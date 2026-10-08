"""Import matching KITTI tracking images, lidar, OXTS, calibration and labels."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

from build_tracking_bev import build_bev
from pipeline.geometry import BASIS
from pipeline.pcd import write_pcd

ROOT = Path(__file__).resolve().parents[2]
LABELS = {'Car': 'Car', 'Van': 'Truck', 'Truck': 'Truck', 'Pedestrian': 'Pedestrian',
          'Person_sitting': 'Pedestrian', 'Cyclist': 'Cyclist', 'Tram': 'Truck'}


def source_paths(root, sequence):
    training = root / 'training' if (root / 'training').is_dir() else root
    if (training / 'image_02' / sequence).is_dir():
        return (training / 'image_02' / sequence, training / 'velodyne' / sequence,
                training / 'oxts' / f'{sequence}.txt', training / 'calib' / f'{sequence}.txt',
                training / 'label_02' / f'{sequence}.txt')
    # The range downloader records the identity of its compact cache.
    identity_path = root / 'source.json'
    if not identity_path.exists() or json.loads(identity_path.read_text())['sequence'] != sequence:
        raise ValueError('Use the official tracking training layout or a downloader cache with matching source.json')
    return root / 'images', root / 'velodyne', root / 'oxts' / f'{sequence}.txt', root / 'calib' / f'{sequence}.txt', root / 'labels' / f'{sequence}.txt'


def transform(values):
    matrix = np.eye(4)
    matrix[:3, :] = values.reshape(3, 4)
    return matrix


def ego_transforms(rows):
    scale, earth = math.cos(rows[0, 0] * math.pi / 180), 6378137.
    translations = np.stack([earth * scale * rows[:, 1] * math.pi / 180,
                             earth * scale * np.log(np.tan(math.pi / 4 + rows[:, 0] * math.pi / 360)),
                             rows[:, 2]], axis=1)
    translations -= translations[0]
    poses = []
    for frame, row in enumerate(rows):
        roll, pitch, yaw = row[3:6]  # Official OXTS angles are radians.
        cr, sr, cp, sp, cy, sy = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
        matrix = np.eye(4)
        matrix[:3, :3] = [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
                         [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr], [-sp, cp * sr, cp * cr]]
        matrix[:3, 3] = translations[frame]
        poses.append(matrix)
    return poses


def import_sequence(args, work):
    images, lidar, oxts, calibration, labels = source_paths(args.input, args.sequence)
    files = sorted(lidar.glob('*.bin'))
    count = args.frames if args.frames is not None else len(files)
    if count < 1 or count > len(files):
        raise ValueError('Requested frame count exceeds available lidar frames')
    rows = np.atleast_2d(np.loadtxt(oxts))
    if len(rows) < count or rows.shape[1] < 6 or not np.isfinite(rows[:count, :6]).all():
        raise ValueError('Missing or invalid OXTS rows')
    for frame in range(count):
        image, cloud = images / f'{frame:06d}.png', lidar / f'{frame:06d}.bin'
        if not image.is_file() or not cloud.is_file() or cloud.stat().st_size % 16:
            raise ValueError(f'Missing or malformed paired source frame {frame}')
    calib = {p[0]: np.array(p[1:], dtype=float) for p in
             (line.replace(':', ' ').split() for line in calibration.read_text().splitlines()) if len(p) > 1}
    for key, length in [('Tr_velo_cam', 12), ('Tr_imu_velo', 12), ('R_rect', 9), ('P2', 12)]:
        if key not in calib or calib[key].size != length or not np.isfinite(calib[key]).all():
            raise ValueError(f'Missing or invalid tracking calibration: {key}')
    velo_cam, imu_velo = transform(calib['Tr_velo_cam']), transform(calib['Tr_imu_velo'])
    rect = np.eye(4)
    rect[:3, :3] = calib['R_rect'].reshape(3, 3)
    for matrix in [velo_cam, imu_velo, rect]:
        rotation = matrix[:3, :3]
        if not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-3) or abs(np.linalg.det(rotation) - 1) >= 1e-3:
            raise ValueError('Calibration rotation is not a rigid right-handed transform')
    projection = calib['P2'].reshape(3, 4)
    if projection[0, 0] <= 0 or projection[1, 1] <= 0:
        raise ValueError('Camera focal lengths must be positive')
    baseline = np.eye(4)
    baseline[:3, 3] = np.linalg.solve(projection[:, :3], projection[:, 3])
    camera_imu = baseline @ rect @ velo_cam @ imu_velo
    imu_world = ego_transforms(rows[:count])
    world_velo = [BASIS @ pose @ np.linalg.inv(imu_velo) for pose in imu_world]
    world_rect = [matrix @ np.linalg.inv(velo_cam) @ np.linalg.inv(rect) for matrix in world_velo]
    poses = [(BASIS @ pose @ np.linalg.inv(BASIS)).flatten(order='F').tolist() for pose in imu_world]
    tracks, boxes = {}, {frame: [] for frame in range(count)}
    for line in labels.read_text().splitlines():
        p = line.split()
        frame, tid, kind = int(p[0]), int(p[1]), p[2]
        if frame >= count or frame < 0 or kind not in LABELS:
            continue
        height, width, length = map(float, p[10:13])
        x, y, z, rotation = map(float, p[13:17])
        if min(height, width, length) <= 0 or not np.isfinite([height, width, length, x, y, z, rotation]).all():
            raise ValueError(f'Invalid label geometry at frame {frame}, track {tid}')
        matrix = world_rect[frame]
        center = (matrix @ np.array([x, y - height / 2, z, 1]))[:3]
        # KITTI rotates its camera X length axis about Y (not the camera Z axis).
        heading = matrix[:3, :3] @ np.array([math.cos(rotation), 0, -math.sin(rotation)])
        yaw, size = math.atan2(-heading[2], heading[0]), [length, height, width]
        track = tracks.setdefault(tid, {
            'meta': {'id': f'kitti_{tid:05d}', 'label': LABELS[kind], 'startFrame': frame, 'endFrame': frame,
                     'interpolation': 'linear', 'source': 'human', 'attributes': {'kitti_type': kind}},
            'keyframes': {'frames': [], 'pos': [], 'yaw': [], 'size': []}, 'frameAttributes': []})
        keys = track['keyframes']
        if keys['frames'] and frame <= keys['frames'][-1]:
            raise ValueError(f'Labels must have unique increasing frames for track {tid}')
        track['meta']['endFrame'] = frame
        track['frameAttributes'].append({'frame': frame, 'attrs': {'occlusion': p[4], 'truncation': p[3]}})
        keys['frames'].append(frame)
        keys['pos'].extend(center.tolist())
        keys['yaw'].append(yaw)
        keys['size'].extend(size)
        boxes[frame].append((center, yaw, np.array(size)))

    for directory in [args.output / 'images', args.output / 'pcd', work / 'pcd']:
        directory.mkdir(parents=True, exist_ok=True)
    # Dedicated work directories must not carry extra static frames from a previous import.
    existing = {path.name for path in (work / 'pcd').glob('*.pcd')}
    if existing - {f'{frame}.pcd' for frame in range(count)}:
        raise ValueError('Work directory contains extra frames; use a fresh --work-dir')
    checks, static_count, dynamic_count = [], 0, 0
    dimensions = None
    for frame in range(count):
        image, cloud = images / f'{frame:06d}.png', lidar / f'{frame:06d}.bin'
        with Image.open(image) as photo:
            if dimensions is not None and dimensions != photo.size:
                raise ValueError('Camera image dimensions vary between frames')
            dimensions = photo.size
        raw = np.fromfile(cloud, dtype='<f4').reshape(-1, 4)
        if not len(raw) or not np.isfinite(raw).all():
            raise ValueError(f'Invalid lidar points at frame {frame}')
        points, matrix = raw.copy(), world_velo[frame]
        points[:, :3] = raw[:, :3] @ matrix[:3, :3].T + matrix[:3, 3]
        write_pcd(args.output / 'pcd' / f'{frame}.pcd', points)
        dynamic_count += len(points)
        keep = np.ones(len(points), dtype=bool)
        for center, yaw, size in boxes[frame]:
            delta, c, s = points[:, :3] - center, math.cos(yaw), math.sin(yaw)
            local_x, local_z = c * delta[:, 0] - s * delta[:, 2], s * delta[:, 0] + c * delta[:, 2]
            inside = (abs(local_x) < size[0] / 2 + args.box_padding) & (abs(delta[:, 1]) < size[1] / 2 + args.box_padding) & (abs(local_z) < size[2] / 2 + args.box_padding)
            keep &= ~inside
        write_pcd(work / 'pcd' / f'{frame}.pcd', points[keep])
        static_count += int(keep.sum())
        shutil.copyfile(image, args.output / 'images' / f'{frame}.png')
        if frame in {0, 12, 50, 100, count - 1}:
            checks.append({'frame': frame, 'imageSha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                           'lidarSha256': hashlib.sha256(cloud.read_bytes()).hexdigest()})
        if frame % 50 == 0:
            print(f'Converted tracking {args.sequence} frame {frame}', flush=True)

    prefix, identifier = args.url_prefix.rstrip('/'), args.id or f'kitti_tracking_{args.sequence}_{args.output.name}_aligned_v2'
    manifest = {'formatVersion': 1, 'id': identifier, 'fps': args.fps, 'frameCount': count, 'egoPoses': poses,
                'pointCloud': {'urlTemplate': f'{prefix}/pcd/{{frame}}.pcd', 'format': 'pcd', 'approxBytesPerFrame': 2000000},
                'cameras': [{'id': 'cam2', 'model': 'pinhole', 'width': dimensions[0], 'height': dimensions[1],
                             'intrinsics': {'fx': projection[0, 0], 'fy': projection[1, 1], 'cx': projection[0, 2], 'cy': projection[1, 2]},
                             'cameraToEgo': (BASIS @ np.linalg.inv(camera_imu)).flatten(order='F').tolist(),
                             'imageTemplate': f'{prefix}/images/{{frame}}.png'}]}
    snapshot = {'formatVersion': 1, 'sequenceId': identifier, 'frameCount': count,
                'createdAt': datetime.now(timezone.utc).isoformat(), 'qa': {'status': 'pending', 'notes': f'KITTI tracking {args.sequence}'},
                'tracks': list(tracks.values()), 'geometries': []}
    report = {'source': f'official KITTI tracking {args.sequence}', 'frames': count, 'tracks': len(tracks),
              'dynamicPoints': dynamic_count, 'staticPoints': static_count, 'sourceChecks': checks,
              'staticPolicy': f'Points inside human-labelled boxes excluded with {args.box_padding}m padding; unlabeled dynamics may remain.'}
    for name, document in [('manifest.json', manifest), ('snapshot.json', snapshot), ('alignment-report.json', report)]:
        (args.output / name).write_text(json.dumps(document, indent=2))
    build_bev(work / 'pcd', args.output, args.bev_mpp)
    if not args.skip_potree:
        las = work / 'world.las'
        subprocess.run([sys.executable, str(Path(__file__).with_name('export_world_las.py')), '--input', str(work), '--output', str(las)], check=True)
        subprocess.run([str(args.potree_converter), str(las), '-o', str(args.output / 'potree'), '--encoding', 'UNCOMPRESSED'], check=True)
        manifest = json.loads((args.output / 'manifest.json').read_text())
        manifest['potree'] = {'url': f'{prefix}/potree'}
        (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(f'Imported {count} frames, {len(tracks)} tracks → {args.output}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--sequence', required=True, help='Official four-digit tracking sequence, e.g. 0004')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--url-prefix', required=True, help='URL serving the output directory, e.g. /datasets/0004')
    parser.add_argument('--frames', type=int, help='First N frames; default: all available frames')
    parser.add_argument('--id', help='Unique editor document identity')
    parser.add_argument('--fps', type=float, default=10)
    parser.add_argument('--box-padding', type=float, default=.2)
    parser.add_argument('--bev-mpp', type=float, default=.15)
    parser.add_argument('--work-dir', type=Path, help='Dedicated intermediate directory; default: temporary directory')
    parser.add_argument('--potree-converter', type=Path, default=Path(os.environ.get('LABELFASTER_POTREE_CONVERTER', ROOT / 'third_party/PotreeConverter/build/PotreeConverter')))
    parser.add_argument('--skip-potree', action='store_true', help='Import current-frame clouds and BEV without a static Potree tree')
    parser.add_argument('--overwrite', action='store_true', help='Explicitly allow rebuilding generated output; browser documents are untouched')
    args = parser.parse_args()
    if not re.fullmatch(r'\d{4}', args.sequence) or not np.isfinite([args.fps, args.bev_mpp, args.box_padding]).all() or args.fps <= 0 or args.bev_mpp <= 0 or args.box_padding < 0:
        parser.error('Invalid sequence or numeric settings')
    args.input, args.output = args.input.resolve(), args.output.resolve()
    if args.output.exists() and any(args.output.iterdir()) and not args.overwrite:
        parser.error('Output is not empty; use a new directory or --overwrite for generated data')
    if args.input == args.output or args.input in args.output.parents or args.output in args.input.parents:
        parser.error('Source and output directories must be separate')
    if not args.skip_potree and not args.potree_converter.is_file():
        parser.error('Build PotreeConverter, provide --potree-converter, or explicitly use --skip-potree')
    if args.work_dir:
        import_sequence(args, args.work_dir.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix='labelfaster-import-') as directory:
            import_sequence(args, Path(directory))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as error:
        print(f'Import failed: {error}', file=sys.stderr)
        sys.exit(2)
