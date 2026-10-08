"""Import one Waymo Perception v2.0.1 segment to the offline normalized contract.

This intentionally produces sequence.json, not a browser v1 manifest/snapshot.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time

import numpy as np
from PIL import Image

from adapters.waymo import (WaymoSource, SEGMENT, TIME, CAMERA_NAMES, LIDAR_NAMES,
                            REQUIRED, OPTIONAL, range_array, decode_return)
from build_tracking_bev import rasterize_bev
from pipeline.geometry import BASIS, rigid, box_transform, points_outside_boxes
from pipeline.pcd import write_pcd

SCHEMA = 'labelfaster.normalized-sequence/1'
ADAPTER_VERSION = 'waymo-parquet-1'
OPTICAL_TO_WAYMO = np.array([[0., 0, 1, 0], [-1, 0, 0, 0], [0, -1, 0, 0], [0, 0, 0, 1]])


def json_value(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(type(value).__name__)


def write_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, default=json_value, allow_nan=False) + '\n')


def matrix_list(matrix):
    return matrix.flatten(order='F').tolist()


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unique_rows(rows, key, expected, component):
    result = {}
    for row in rows:
        identity = row[key]
        if identity in result:
            raise ValueError(f'Duplicate {component} sample: {identity}')
        result[identity] = row
    if set(result) != set(expected):
        raise ValueError(f'{component} sensor set mismatch: {set(result)} != {set(expected)}')
    return result


def import_segment(source, output, frames=None, bev_mpp=.25, box_padding=.2):
    started = time.monotonic()
    camera_calib = source.calibration('camera_calibration', 'key.camera_name')
    lidar_calib = source.calibration('lidar_calibration', 'key.laser_name')
    if set(camera_calib) != set(CAMERA_NAMES) or set(lidar_calib) != set(LIDAR_NAMES):
        raise ValueError('Waymo v2.0.1 requires its five camera and five lidar calibrations')
    vehicle_rows = list(source.rows('vehicle_pose'))
    if not vehicle_rows or len({r[TIME] for r in vehicle_rows}) != len(vehicle_rows):
        raise ValueError('Vehicle reference timestamps must be unique and nonempty')
    count = len(vehicle_rows) if frames is None else frames
    if count < 1 or count > len(vehicle_rows):
        raise ValueError('Requested frame count exceeds source reference frames')
    first_pose = rigid(vehicle_rows[0]['[VehiclePoseComponent].world_from_vehicle.transform'])
    world_to_local = BASIS.copy()
    world_to_local[:3, 3] = -BASIS[:3, :3] @ first_pose[:3, 3]
    origin_time = vehicle_rows[0][TIME]
    provenance = [{'component': c, 'path': f'{source.split}/{c}/{source.segment}.parquet',
                   'sha256': file_hash(p), 'bytes': p.stat().st_size} for c, p in sorted(source.paths.items())]
    identity = {'dataset': 'waymo-perception', 'release': '2.0.1', 'split': source.split,
                'segment': source.segment, 'adapter': ADAPTER_VERSION, 'contract': SCHEMA,
                'frames': count, 'returns': [1, 2], 'sources': provenance}
    identifier = 'waymo_' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
    sequence = {'schema': SCHEMA, 'id': identifier,
                'coordinateSystem': {'handedness': 'right', 'up': 'Y', 'unit': 'meter', 'matrixOrder': 'column-major',
                                     'sourceWorldToLocal': matrix_list(world_to_local)},
                'time': {'unit': 'microsecond', 'sourceOriginMicros': str(origin_time),
                         'matchingPolicy': 'exact-frame-key', 'missingPolicy': 'reject'},
                'provenance': identity,
                'capabilities': {'pointCloud': True, 'cameraImages': True, 'boxObservations3d': True,
                                 'fullBoxPose': True, 'pointCameraReferences': True, 'editableInRuntimeV1': False},
                'sensors': [], 'frames': []}
    for cid, calibration in sorted(camera_calib.items()):
        ext = rigid(calibration['[CameraCalibrationComponent].extrinsic.transform'])
        prefix = '[CameraCalibrationComponent]'
        sequence['sensors'].append({'id': f'camera-{cid}', 'kind': 'camera', 'sourceId': cid, 'name': CAMERA_NAMES[cid],
            'sensorToEgo': matrix_list(BASIS @ ext @ OPTICAL_TO_WAYMO), 'model': 'pinhole-brown-conrady',
            'width': int(calibration[prefix+'.width']), 'height': int(calibration[prefix+'.height']),
            'intrinsics': [float(calibration[prefix+'.intrinsic.'+k]) for k in ('f_u', 'f_v', 'c_u', 'c_v')],
            'distortion': [float(calibration[prefix+'.intrinsic.'+k]) for k in ('k1', 'k2', 'p1', 'p2', 'k3')],
            'rollingShutterDirection': int(calibration[prefix+'.rolling_shutter_direction'])})
    for lid, calibration in sorted(lidar_calib.items()):
        ext = rigid(calibration['[LiDARCalibrationComponent].extrinsic.transform'])
        sequence['sensors'].append({'id': f'lidar-{lid}', 'kind': 'lidar', 'sourceId': lid, 'name': LIDAR_NAMES[lid],
            'sensorToEgo': matrix_list(BASIS @ ext @ BASIS.T), 'sourceCalibration': calibration})

    component_names = [c for c in (*REQUIRED, *OPTIONAL) if c not in ('vehicle_pose', 'camera_calibration', 'lidar_calibration') and c in source.paths]
    streams = {c: iter(source.groups(c)) for c in component_names}
    current = {c: next(stream, None) for c, stream in streams.items()}
    report = {'schema': SCHEMA, 'sequenceId': identifier, 'frameCount': count, 'dynamicPoints': 0, 'staticPoints': 0,
              'boxObservations': 0, 'cameraPoseOffsetsMicros': [], 'frames': [],
              'limitations': ['Offline normalized output; browser v1 cannot consume sequence.json.',
                  'No independent runtime projection or editing implementation in this stage.',
                  'Side lidars use frame pose; TOP uses per-pixel pose for both returns, following the SDK.',
                  'Point-camera pixels are source references, not projections of edited geometry.',
                  'No per-point timestamps are inferred from azimuth.',
                  'Static filtering excludes all observed 3D boxes; unlabeled moving objects may remain.']}
    with tempfile.TemporaryDirectory(prefix='labelfaster-waymo-static-') as work_directory:
        work = Path(work_directory)
        for frame, vehicle_row in enumerate(vehicle_rows[:count]):
            timestamp = vehicle_row[TIME]
            groups = {}
            for component, item in current.items():
                if item is not None and item[0] < timestamp:
                    raise ValueError(f'Orphan timestamp in {component}: {item[0]}')
                groups[component] = item[1] if item is not None and item[0] == timestamp else []
                if component in ('camera_image', 'lidar', 'lidar_pose', 'lidar_camera_projection') and not groups[component]:
                    raise ValueError(f'Missing {component} at {timestamp}')
            vehicle_pose = rigid(vehicle_row['[VehiclePoseComponent].world_from_vehicle.transform'])
            vehicle_to_world = world_to_local @ vehicle_pose
            cameras = unique_rows(groups['camera_image'], 'key.camera_name', camera_calib, 'camera')
            lidars = unique_rows(groups['lidar'], 'key.laser_name', lidar_calib, 'lidar')
            projections = unique_rows(groups['lidar_camera_projection'], 'key.laser_name', lidar_calib, 'projection')
            top = unique_rows(groups['lidar_pose'], 'key.laser_name', [1], 'TOP pose')[1]
            pixel_pose = range_array(top, 'LiDARPoseComponent', 'range_image_return1', 6)
            observations, object_ids = [], set()
            for row in groups['lidar_box']:
                oid = row['key.laser_object_id']
                if oid in object_ids:
                    raise ValueError('Duplicate box observation')
                object_ids.add(oid)
                prefix = '[LiDARBoxComponent].box'
                center = np.array([row[prefix+'.center.'+axis] for axis in 'xyz'])
                dimensions = np.array([row[prefix+'.size.'+axis] for axis in 'xyz'])
                heading = row[prefix+'.heading']
                if not np.isfinite([*center, *dimensions, heading]).all() or min(dimensions) <= 0:
                    raise ValueError('Invalid 3D box geometry')
                observations.append({'objectId': oid, 'source': 'human-observation', 'sourceTimestampMicros': str(timestamp),
                    'label': int(row['[LiDARBoxComponent].type']), 'size': dimensions[[0, 2, 1]].tolist(),
                    'boxToWorld': matrix_list(box_transform(center, heading, vehicle_to_world)), 'sourceFields': row})
            frame_doc = {'schema': 'labelfaster.normalized-frame/1', 'sequenceId': identifier, 'index': frame,
                         'timeMicros': timestamp-origin_time, 'egoToWorld': matrix_list(vehicle_to_world @ BASIS.T),
                         'samples': [], 'boxObservations': observations,
                         'sourceComponents': {c: groups[c] for c in OPTIONAL if c in groups}}
            for cid, row in sorted(cameras.items()):
                prefix = '[CameraImageComponent]'
                data = row[prefix+'.image']
                with Image.open(io.BytesIO(data)) as image:
                    image.load()
                    calibration = camera_calib[cid]
                    if image.size != (calibration['[CameraCalibrationComponent].width'], calibration['[CameraCalibrationComponent].height']) or image.format != 'JPEG':
                        raise ValueError('Image format/dimensions disagree with camera calibration')
                relative = f'images/camera-{cid}/{frame}.jpg'
                path = output / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                pose = rigid(row[prefix+'.pose.transform'])
                ext = rigid(camera_calib[cid]['[CameraCalibrationComponent].extrinsic.transform'])
                pose_time = round(row[prefix+'.pose_timestamp'] * 1_000_000) - origin_time
                report['cameraPoseOffsetsMicros'].append(pose_time-(timestamp-origin_time))
                metadata = {k: v for k, v in row.items() if k != prefix+'.image'}
                frame_doc['samples'].append({'sensorId': f'camera-{cid}', 'status': 'available',
                    'sampleId': f'{timestamp}:camera-{cid}', 'referenceTimeMicros': timestamp-origin_time,
                    'poseTimeMicros': pose_time, 'cameraToWorld': matrix_list(world_to_local @ pose @ ext @ OPTICAL_TO_WAYMO),
                    'image': relative, 'imageSha256': hashlib.sha256(data).hexdigest(), 'sourceFields': metadata})
            cloud_parts, attrs = [], {k: [] for k in ('sensor_id', 'return_id', 'range_row', 'range_column', 'range', 'elongation', 'nlz', 'camera_projection')}
            for lid, row in sorted(lidars.items()):
                for return_id in (1, 2):
                    field = f'range_image_return{return_id}'
                    image = range_array(row, 'LiDARComponent', field, 4)
                    points, indices, extra = decode_return(image, lidar_calib[lid], vehicle_pose, world_to_local, pixel_pose if lid == 1 else None)
                    projection = range_array(projections[lid], 'LiDARCameraProjectionComponent', field, 6)
                    if projection.shape[:2] != image.shape[:2] or not np.equal(projection, np.floor(projection)).all():
                        raise ValueError('Camera reference pixels do not match range image')
                    refs = projection[indices[:, 0], indices[:, 1]].astype(np.int32)
                    if not np.isin(refs[:, [0, 3]], [0, *camera_calib]).all():
                        raise ValueError('Unknown camera in projection reference')
                    cloud_parts.append(points)
                    attrs['sensor_id'].append(np.full(len(points), lid, dtype=np.uint8))
                    attrs['return_id'].append(np.full(len(points), return_id, dtype=np.uint8))
                    attrs['range_row'].append(indices[:, 0]); attrs['range_column'].append(indices[:, 1])
                    attrs['range'].append(image[indices[:, 0], indices[:, 1], 0].astype(np.float32))
                    attrs['elongation'].append(extra[:, 0].astype(np.float32)); attrs['nlz'].append(extra[:, 1].astype(np.float32))
                    attrs['camera_projection'].append(refs)
                    frame_doc['samples'].append({'sensorId': f'lidar-{lid}', 'status': 'available', 'returnId': return_id,
                        'sampleId': f'{timestamp}:lidar-{lid}:return-{return_id}', 'referenceTimeMicros': timestamp-origin_time,
                        'motionCompensation': 'per-pixel-vehicle-pose' if lid == 1 else 'reference-vehicle-pose',
                        'pointOffset': sum(len(p) for p in cloud_parts[:-1]), 'pointCount': len(points)})
            points = np.concatenate(cloud_parts).astype('<f4')
            cloud_path = output / 'pcd' / f'{frame}.pcd'
            write_pcd(cloud_path, points)
            attr_path = output / 'attributes' / f'{frame}.npz'
            attr_path.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(attr_path, **{k: np.concatenate(v) for k, v in attrs.items()})
            frame_doc['pointCloud'] = {'path': f'pcd/{frame}.pcd', 'format': 'pcd-xyzi-binary', 'pointCount': len(points),
                                      'sha256': file_hash(cloud_path), 'attributes': f'attributes/{frame}.npz',
                                      'attributesSha256': file_hash(attr_path), 'attributeSchema': 'labelfaster.point-attributes/1'}
            keep = points_outside_boxes(points, observations, box_padding)
            write_pcd(work / f'{frame}.pcd', points[keep])
            report['dynamicPoints'] += len(points); report['staticPoints'] += int(keep.sum())
            report['boxObservations'] += len(observations)
            report['frames'].append({'index': frame, 'points': len(points), 'staticPoints': int(keep.sum()), 'boxes': len(observations)})
            relative = f'frames/{frame}.json'
            write_json(output / relative, frame_doc)
            sequence['frames'].append({'index': frame, 'timeMicros': timestamp-origin_time, 'path': relative})
            for component in streams:
                if current[component] is not None and current[component][0] == timestamp:
                    current[component] = next(streams[component], None)
            if frame % 10 == 0 or frame == count-1:
                print(f'Waymo frame {frame+1}/{count}: {len(points)} points, {len(observations)} boxes', flush=True)
        if count == len(vehicle_rows) and any(item is not None for item in current.values()):
            raise ValueError('Component contains timestamps outside the vehicle reference timeline')
        config, bev_report = rasterize_bev(sorted(work.glob('*.pcd')), output, bev_mpp)
        sequence['bev'] = {**config, 'path': 'bev/map.png', 'policy': 'all-observed-boxes-excluded', 'boxPaddingMeters': box_padding}
        report['bev'] = bev_report
    offsets = report.pop('cameraPoseOffsetsMicros')
    report['cameraPoseOffsetMicros'] = {'min': min(offsets), 'max': max(offsets)}
    report['importSeconds'] = round(time.monotonic()-started, 3)
    report['createdAt'] = datetime.now(timezone.utc).isoformat()
    report['independentValidation'] = 'not-run'
    write_json(output / 'sequence.json', sequence)
    write_json(output / 'import-report.json', report)
    return sequence, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Root containing split/component/segment.parquet')
    parser.add_argument('--split', choices=['training', 'validation'], default='validation')
    parser.add_argument('--segment', required=True)
    parser.add_argument('--output', type=Path, required=True, help='New, absent directory; never replaces an existing import')
    parser.add_argument('--frames', type=int, help='First N reference frames; default all')
    parser.add_argument('--bev-mpp', type=float, default=.25)
    parser.add_argument('--box-padding', type=float, default=.2)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]+(?:_[0-9]+){4}', args.segment):
        parser.error('Invalid Waymo segment ID')
    if not np.isfinite([args.bev_mpp, args.box_padding]).all() or args.bev_mpp <= 0 or args.box_padding < 0:
        parser.error('Invalid raster/box settings')
    source_root, output = args.input.resolve(), args.output.resolve()
    if output.exists() or source_root == output or source_root in output.parents or output in source_root.parents:
        parser.error('Use an absent output directory separate from source data')
    source = WaymoSource(source_root, args.split, args.segment)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.waymo-import-', dir=output.parent) as staging:
        sequence, report = import_segment(source, Path(staging), args.frames, args.bev_mpp, args.box_padding)
        from validate_normalized import validate_directory
        validate_directory(Path(staging))
        shutil.move(staging, output)
    print(f"Imported {len(sequence['frames'])} frames, {report['dynamicPoints']} points to {output}")


if __name__ == '__main__':
    try:
        main()
    except (ValueError, FileNotFoundError, KeyError) as error:
        print(f'Waymo import failed: {error}', file=sys.stderr)
        sys.exit(2)
