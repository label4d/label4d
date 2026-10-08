"""Compare normalized clouds with a pinned official Waymo TensorFlow decoder.

Fetches only three official SDK source files into a temporary directory, verifies
their pinned SHA256, and never imports them into the production adapter.
"""
import argparse
import ast
import hashlib
import importlib.util
from itertools import product
import json
from pathlib import Path
import tempfile
import urllib.request

import numpy as np

from adapters.waymo import WaymoSource, TIME, range_array
from import_waymo import file_hash, write_json
from validate_normalized import validate_directory

SDK_COMMIT = '99a4cb3ff07e2fe06c2ce73da001f850f628e45a'
REFERENCES = {'range_image_utils': '48abee3df4bc0c5d24e83909b7f149201ab95a08d6b383dfb11382bedab5f265',
              'transform_utils': 'd0be4e86768106a748938ea2c086be64c46c2526f0fd093cb0c9413fd7e26b2a',
              'box_utils': 'ab87aaa7d46a41a77cc85e24602b169a563dd6e4734193625490e5154d558703'}


def load_reference(name, directory, namespace=None):
    path = directory / f'{name}.py'
    url = f'https://raw.githubusercontent.com/waymo-research/waymo-open-dataset/{SDK_COMMIT}/src/waymo_open_dataset/utils/{name}.py'
    if not path.exists():
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(128_000)
        if hashlib.sha256(data).hexdigest() != REFERENCES[name]:
            raise ValueError(f'Official reference checksum mismatch: {name}')
        path.write_bytes(data)
    if file_hash(path) != REFERENCES[name]:
        raise ValueError(f'Official reference checksum mismatch: {name}')
    if namespace is not None:
        # Execute the exact pinned public corner function without importing
        # protobuf-dependent functions from box_utils. Its math is unchanged.
        tree = ast.parse(path.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'get_upright_3d_box_corners')
        module = ast.Module(body=[function], type_ignores=[])
        exec(compile(module, str(path), 'exec'), namespace)
        return namespace['get_upright_3d_box_corners']
    spec = importlib.util.spec_from_file_location(f'waymo_reference_{name}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_reference(source_root, output, selected_frames, reference_dir):
    import tensorflow as tf
    validate_directory(output)
    sequence = json.loads((output / 'sequence.json').read_text())
    origin = int(sequence['time']['sourceOriginMicros'])
    source = WaymoSource(source_root, sequence['provenance']['split'], sequence['provenance']['segment'])
    actual_sources = {c: file_hash(p) for c, p in source.paths.items()}
    if actual_sources != {p['component']: p['sha256'] for p in sequence['provenance']['sources']}:
        raise ValueError('Reference source differs from imported component hashes')
    if any(f < 0 or f >= len(sequence['frames']) for f in selected_frames):
        raise ValueError('Reference frame index out of range')
    targets = {origin+sequence['frames'][f]['timeMicros']: f for f in selected_frames}
    # Only selected frames are retained; large sensor arrays remain streamed.
    rows = {c: {t: r for t, r in source.groups(c) if t in targets}
            for c in ('vehicle_pose', 'lidar', 'lidar_pose', 'lidar_camera_projection', 'lidar_box')}
    calibration = source.calibration('lidar_calibration', 'key.laser_name')
    ranges = load_reference('range_image_utils', reference_dir)
    transforms = load_reference('transform_utils', reference_dir)
    sdk_corners = load_reference('box_utils', reference_dir, {'tf': tf, 'transform_utils': transforms})
    basis = np.array([[1., 0, 0], [0, 0, 1], [0, -1, 0]])
    # Independent reconstruction of local origin from the first source vehicle pose.
    first = next(source.rows('vehicle_pose'))
    world_origin = np.asarray(first['[VehiclePoseComponent].world_from_vehicle.transform']).reshape(4, 4)[:3, 3]
    comparisons, box_checks = [], []
    for timestamp, frame in targets.items():
        frame_doc = json.loads((output / sequence['frames'][frame]['path']).read_text())
        data = (output / frame_doc['pointCloud']['path']).read_bytes()
        start = data.index(b'DATA binary\n')+len(b'DATA binary\n')
        actual = np.frombuffer(data, dtype='<f4', offset=start).reshape(-1, 4)
        vehicle = np.asarray(rows['vehicle_pose'][timestamp][0]['[VehiclePoseComponent].world_from_vehicle.transform']).reshape(4, 4)
        boxes = {b['objectId']: b for b in frame_doc['boxObservations']}
        for row in rows['lidar_box'].get(timestamp, []):
            prefix = '[LiDARBoxComponent].box'
            values = [row[prefix+'.center.'+axis] for axis in 'xyz'] + [row[prefix+'.size.'+axis] for axis in 'xyz'] + [row[prefix+'.heading']]
            corners = sdk_corners(tf.constant([values], dtype=tf.float64)).numpy()[0]
            expected = (corners @ vehicle[:3, :3].T + vehicle[:3, 3]-world_origin) @ basis.T
            box = boxes.pop(row['key.laser_object_id'])
            matrix = np.asarray(box['boxToWorld']).reshape(4, 4, order='F')
            local_corners = np.array(list(product((-1, 1), repeat=3))) * np.asarray(box['size']) / 2
            actual_corners = local_corners @ matrix[:3, :3].T + matrix[:3, 3]
            distance = np.linalg.norm(expected[:, None, :]-actual_corners[None, :, :], axis=2)
            error = float(distance.min(axis=1).max())
            if error > 1e-7 or len(set(distance.argmin(axis=1))) != 8:
                raise ValueError(f'Official SDK box corner mismatch at frame {frame}: {error} m')
            box_checks.append({'frame': frame, 'objectId': row['key.laser_object_id'], 'maxCornerErrorMeters': error})
        if boxes:
            raise ValueError('Output box observations absent from source')
        top_pose = range_array(rows['lidar_pose'][timestamp][0], 'LiDARPoseComponent', 'range_image_return1', 6).astype(np.float64)
        pixel_matrix = transforms.get_transform(transforms.get_rotation_matrix(top_pose[..., 0], top_pose[..., 1], top_pose[..., 2]), top_pose[..., 3:])
        lidar_rows = {r['key.laser_name']: r for r in rows['lidar'][timestamp]}
        projection_rows = {r['key.laser_name']: r for r in rows['lidar_camera_projection'][timestamp]}
        with np.load(output / frame_doc['pointCloud']['attributes'], allow_pickle=False) as attrs:
            for sample in [s for s in frame_doc['samples'] if s['sensorId'].startswith('lidar-')]:
                lid = int(sample['sensorId'].split('-')[1]); return_id = sample['returnId']
                image = range_array(lidar_rows[lid], 'LiDARComponent', f'range_image_return{return_id}', 4).astype(np.float64)
                ext = np.asarray(calibration[lid]['[LiDARCalibrationComponent].extrinsic.transform']).reshape(4, 4)
                angles = calibration[lid]['[LiDARCalibrationComponent].beam_inclination.values']
                if angles is None or len(angles) == 0:
                    bounds = [calibration[lid]['[LiDARCalibrationComponent].beam_inclination.'+k] for k in ('min', 'max')]
                    angles = ranges.compute_inclination(tf.constant(bounds, dtype=tf.float64), image.shape[0]).numpy()
                angles = np.asarray(angles)[::-1]
                sdk_vehicle = ranges.extract_point_cloud_from_range_image(
                    tf.constant(image[None, ..., 0]), tf.constant(ext[None]), tf.constant(angles[None]),
                    pixel_pose=pixel_matrix[None] if lid == 1 else None,
                    frame_pose=tf.constant(vehicle[None]) if lid == 1 else None, dtype=tf.float64).numpy()[0]
                mask = image[..., 0] > 0
                sdk_global = sdk_vehicle[mask] @ vehicle[:3, :3].T + vehicle[:3, 3]
                expected = (sdk_global-world_origin) @ basis.T
                offset, count = sample['pointOffset'], sample['pointCount']
                if len(expected) != count:
                    raise ValueError('SDK point count differs from imported cloud')
                error = float(np.abs(actual[offset:offset+count, :3]-expected).max()) if count else 0.
                if error > .001:
                    raise ValueError(f'SDK coordinate mismatch at frame {frame}, lidar {lid}, return {return_id}: {error} m')
                refs = range_array(projection_rows[lid], 'LiDARCameraProjectionComponent', f'range_image_return{return_id}', 6)[mask]
                indices = np.argwhere(mask)
                if (not np.array_equal(refs, attrs['camera_projection'][offset:offset+count]) or
                        not np.array_equal(indices[:, 0], attrs['range_row'][offset:offset+count]) or
                        not np.array_equal(indices[:, 1], attrs['range_column'][offset:offset+count])):
                    raise ValueError('Original range-image point/pixel reference correspondence changed')
                comparisons.append({'frame': frame, 'lidar': lid, 'return': return_id, 'points': count, 'maxCoordinateErrorMeters': error})
    report = {'sdkCommit': SDK_COMMIT, 'referenceSha256': REFERENCES, 'frames': sorted(selected_frames),
              'comparisons': comparisons, 'boxComparisons': box_checks, 'passed': True,
              'scope': 'XYZ and box corners vs official SDK; original point-camera correspondence; excludes computed camera projection and browser rendering'}
    write_json(output / 'reference-report.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--frames', type=int, nargs='+', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='waymo-sdk-reference-') as directory:
        report = validate_reference(args.input, args.output, args.frames, Path(directory))
    print(json.dumps({'passed': report['passed'], 'frames': report['frames'],
                      'maxCoordinateErrorMeters': max(c['maxCoordinateErrorMeters'] for c in report['comparisons'])}, indent=2))
