"""Validate the offline contract and its image/point-attribute bindings."""
import argparse
import json
from pathlib import Path, PurePosixPath
import sys

import numpy as np
from PIL import Image

from import_waymo import SCHEMA, file_hash
from pipeline.geometry import rigid
from build_tracking_bev import read_points

SCHEMA_PATH = Path(__file__).resolve().parents[2] / 'fixtures/schemas/normalized-sequence.v1.schema.json'


def resource(root, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or '\\' in relative:
        raise ValueError('Resources must be portable relative paths inside the import')
    resolved = (root / relative).resolve()
    if root.resolve() not in resolved.parents or not resolved.is_file():
        raise ValueError(f'Missing or escaping resource: {relative}')
    return resolved


def validate_potree(root, descriptor, frame_count):
    if descriptor['encoding'] != 'UNCOMPRESSED' or descriptor['frameCount'] != frame_count:
        raise ValueError('Potree encoding/frame count mismatch')
    files = descriptor['files']
    if {f['path'] for f in files} != {'metadata.json', 'hierarchy.bin', 'octree.bin'} or len(files) != 3:
        raise ValueError('Potree must bind all three converter files')
    for entry in files:
        path = resource(root, descriptor['path'] + '/' + entry['path'])
        if file_hash(path) != entry['sha256']:
            raise ValueError('Potree checksum mismatch')
    metadata = json.loads(resource(root, descriptor['path'] + '/metadata.json').read_text())
    if metadata.get('version') != '2.0' or metadata.get('encoding') != 'UNCOMPRESSED' or metadata.get('points') != descriptor['pointCount']:
        raise ValueError('Potree metadata encoding/point count mismatch')
    return metadata


def validate_directory(root):
    import jsonschema
    sequence = json.loads((root / 'sequence.json').read_text())
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.Draft202012Validator(schema).validate(sequence)
    frame_validator = jsonschema.Draft202012Validator(schema['$defs']['frame'])
    ids = [s['id'] for s in sequence['sensors']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate sensor identity')
    cameras = {s['id']: s for s in sequence['sensors'] if s['kind'] == 'camera'}
    sensor_by_id = {s['id']: s for s in sequence['sensors']}
    rigid(np.array(sequence['coordinateSystem']['sourceWorldToLocal']).reshape(4, 4, order='F'))
    for sensor in sequence['sensors']:
        rigid(np.array(sensor['sensorToEgo']).reshape(4, 4, order='F'))
        if sensor['kind'] == 'camera':
            intrinsics = sensor['intrinsics']
            if min(intrinsics[:2]) <= 0 or not np.isfinite([*intrinsics, *sensor['distortion']]).all():
                raise ValueError('Invalid camera intrinsics/distortion')
    previous = -1
    for index, entry in enumerate(sequence['frames']):
        if entry['index'] != index or entry['timeMicros'] <= previous or (index == 0 and entry['timeMicros'] != 0):
            raise ValueError('Reference timeline must start at zero and strictly increase')
        previous = entry['timeMicros']
        frame = json.loads(resource(root, entry['path']).read_text())
        frame_validator.validate(frame)
        if (frame.get('schema') != 'labelfaster.normalized-frame/1' or frame.get('sequenceId') != sequence['id'] or
                frame.get('index') != index or frame.get('timeMicros') != entry['timeMicros']):
            raise ValueError('Frame identity/timestamp does not match sequence index')
        rigid(np.array(frame['egoToWorld']).reshape(4, 4, order='F'))
        object_ids = set()
        for box in frame['boxObservations']:
            if box['objectId'] in object_ids or len(box['size']) != 3 or not np.isfinite(box['size']).all() or min(box['size']) <= 0:
                raise ValueError('Invalid box observation identity/size')
            object_ids.add(box['objectId'])
            rigid(np.array(box['boxToWorld']).reshape(4, 4, order='F'))
        cloud = frame['pointCloud']
        path = resource(root, cloud['path']); attrs_path = resource(root, cloud['attributes'])
        if cloud.get('attributeSchema') != 'labelfaster.point-attributes/1' or cloud['sha256'] != file_hash(path) or cloud['attributesSha256'] != file_hash(attrs_path):
            raise ValueError('Point cloud/attribute binding checksum mismatch')
        points = read_points(path)
        count = cloud['pointCount']
        if len(points) != count or not np.isfinite(points).all():
            raise ValueError('Invalid point count or coordinates')
        with np.load(attrs_path, allow_pickle=False) as attrs:
            expected = {'sensor_id': np.dtype('uint8'), 'return_id': np.dtype('uint8'),
                        'range_row': np.dtype('int32'), 'range_column': np.dtype('int32'),
                        'range': np.dtype('float32'), 'elongation': np.dtype('float32'),
                        'nlz': np.dtype('float32'), 'camera_projection': np.dtype('int32')}
            if set(attrs.files) != set(expected):
                raise ValueError('Invalid point attribute fields')
            for field, dtype in expected.items():
                data = attrs[field]
                shape = (count, 6) if field == 'camera_projection' else (count,)
                if data.shape != shape or data.dtype != dtype or not np.isfinite(data).all():
                    raise ValueError(f'Invalid point attribute {field}')
            offset, sample_ids, camera_ids, lidar_returns = 0, set(), set(), set()
            for sample in frame['samples']:
                if sample['sampleId'] in sample_ids or sample['sensorId'] not in sensor_by_id or sample['status'] != 'available':
                    raise ValueError('Invalid sample identity/status')
                sample_ids.add(sample['sampleId'])
                sensor = sensor_by_id[sample['sensorId']]
                if sample['referenceTimeMicros'] != entry['timeMicros']:
                    raise ValueError('Sample reference time mismatch')
                if sensor['kind'] == 'camera':
                    if sample['sensorId'] in camera_ids:
                        raise ValueError('Duplicate camera sample')
                    camera_ids.add(sample['sensorId'])
                    photo_path = resource(root, sample['image'])
                    if sample['imageSha256'] != file_hash(photo_path):
                        raise ValueError('Image checksum mismatch')
                    with Image.open(photo_path) as photo:
                        photo.load()
                        if photo.size != (sensor['width'], sensor['height']):
                            raise ValueError('Image dimensions mismatch')
                    rigid(np.array(sample['cameraToWorld']).reshape(4, 4, order='F'))
                else:
                    key = (sample['sensorId'], sample['returnId'])
                    if key in lidar_returns:
                        raise ValueError('Duplicate lidar return')
                    lidar_returns.add(key)
                    n = sample['pointCount']
                    if sample['pointOffset'] != offset or n < 0 or offset+n > count:
                        raise ValueError('Invalid lidar point spans')
                    if (not np.all(attrs['sensor_id'][offset:offset+n] == sensor['sourceId']) or
                            not np.all(attrs['return_id'][offset:offset+n] == sample['returnId'])):
                        raise ValueError('Lidar point order/source mismatch')
                    offset += n
            if offset != count:
                raise ValueError('Lidar spans do not cover the cloud')
            expected_returns = {(s['id'], r) for s in sequence['sensors'] if s['kind'] == 'lidar' for r in (1, 2)}
            if camera_ids != set(cameras) or lidar_returns != expected_returns:
                raise ValueError('Missing camera/lidar return samples')
    resource(root, sequence['bev']['path'])
    if 'potree' in sequence:
        validate_potree(root, sequence['potree'], len(sequence['frames']))
    return {'schema': SCHEMA, 'id': sequence['id'], 'frames': len(sequence['frames']), 'validated': True}


if __name__ == '__main__':
    import jsonschema
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate_directory(args.directory), indent=2))
    except (ValueError, KeyError, OSError, jsonschema.ValidationError) as error:
        print(f'Normalized validation failed: {error}', file=sys.stderr)
        sys.exit(2)
