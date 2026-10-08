"""Waymo Perception v2.0.1 Parquet reader and NumPy range-image decoder.

Numerical conventions follow the official range_image_utils and v2 lidar_utils:
https://github.com/waymo-research/waymo-open-dataset/tree/99a4cb3ff07e2fe06c2ce73da001f850f628e45a/src/waymo_open_dataset
This module does not import TensorFlow or the Waymo SDK.
"""
from itertools import groupby
from pathlib import Path
import json
import numpy as np

from pipeline.geometry import rigid, rotation_rpy, transform_points

SEGMENT = 'key.segment_context_name'
TIME = 'key.frame_timestamp_micros'
CAMERA_NAMES = {1: 'front', 2: 'front-left', 3: 'front-right', 4: 'side-left', 5: 'side-right'}
LIDAR_NAMES = {1: 'top', 2: 'front', 3: 'side-left', 4: 'side-right', 5: 'rear'}
REQUIRED = ('vehicle_pose', 'camera_calibration', 'lidar_calibration', 'camera_image',
            'lidar', 'lidar_pose', 'lidar_box', 'lidar_camera_projection')
OPTIONAL = ('camera_box', 'camera_to_lidar_box_association', 'lidar_camera_synced_box',
            'projected_lidar_box', 'stats')


def range_array(row, component, field, channels):
    prefix = f'[{component}].{field}'
    shape = row.get(prefix + '.shape')
    values = row.get(prefix + '.values')
    if shape is None or values is None:
        raise ValueError(f'Missing {prefix}')
    shape = tuple(int(v) for v in shape)
    if len(shape) != 3 or min(shape) <= 0 or shape[2] != channels:
        raise ValueError(f'Invalid shape for {prefix}: {shape}')
    result = np.asarray(values).reshape(shape)
    if not np.isfinite(result).all():
        raise ValueError(f'Non-finite {prefix}')
    return result


def decode_return(image, calibration, vehicle_pose, world_to_local, pixel_pose=None):
    """Return valid world-local XYZI and source range-image indices.

    TOP is deskewed with its per-pixel vehicle->global pose (also for return 2).
    Other sensors use the reference vehicle pose as in the official SDK.
    """
    height, width, channels = image.shape
    if channels != 4 or not np.isfinite(image).all():
        raise ValueError('Expected finite H x W x 4 range image')
    extrinsic = rigid(calibration['[LiDARCalibrationComponent].extrinsic.transform'])
    inclinations = calibration['[LiDARCalibrationComponent].beam_inclination.values']
    if inclinations is None or len(inclinations) == 0:
        lo = calibration['[LiDARCalibrationComponent].beam_inclination.min']
        hi = calibration['[LiDARCalibrationComponent].beam_inclination.max']
        if not np.isfinite([lo, hi]).all() or lo >= hi:
            raise ValueError('Invalid beam inclination bounds')
        inclinations = lo + (np.arange(height) + .5) / height * (hi - lo)
    inclinations = np.asarray(inclinations, dtype=np.float64)[::-1]
    if inclinations.shape != (height,) or not np.isfinite(inclinations).all():
        raise ValueError('Beam inclinations do not match range-image rows')
    mask = image[..., 0] > 0
    indices = np.argwhere(mask)
    rows, cols = indices.T
    azimuth = ((width - cols - .5) / width * 2 - 1) * np.pi - np.arctan2(extrinsic[1, 0], extrinsic[0, 0])
    inclination = inclinations[rows]
    distance = image[mask, 0]
    laser = distance[:, None] * np.column_stack([np.cos(azimuth)*np.cos(inclination),
                                                np.sin(azimuth)*np.cos(inclination), np.sin(inclination)])
    vehicle = transform_points(laser, extrinsic)
    if pixel_pose is not None:
        if pixel_pose.shape != (height, width, 6) or not np.isfinite(pixel_pose).all():
            raise ValueError('TOP per-pixel pose does not match range image')
        poses = pixel_pose[mask]
        # Subtract the large global origin before casting derived points to Float32.
        rotations = rotation_rpy(poses[:, :3])
        global_points = np.einsum('nij,nj->ni', rotations, vehicle) + poses[:, 3:]
        local = transform_points(global_points, world_to_local)
    else:
        local = transform_points(vehicle, world_to_local @ rigid(vehicle_pose))
    points = np.column_stack([local, image[mask, 1]])
    return points, indices.astype(np.int32), image[mask, 2:4]


class WaymoSource:
    """Streams timestamp-sorted components one row/frame at a time.

    Unsorted components are rejected explicitly rather than buffering the entire
    sensor recording. Sorting can be done separately before import.
    """
    def __init__(self, root, split, segment):
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as error:
            raise ValueError('Install Waymo extras: uv run --project tools/py --extra waymo ...') from error
        self.pa, self.pq = pa, pq
        self.segment, self.split = segment, split
        metadata = Path(root) / 'source.json'
        if metadata.is_file():
            identity = json.loads(metadata.read_text())
            if (identity.get('version') != '2.0.1' or identity.get('split') != split or
                    identity.get('segmentId') != segment):
                raise ValueError('Source cache release/split/segment identity mismatch')
        self.paths = {c: Path(root) / split / c / f'{segment}.parquet' for c in (*REQUIRED, *OPTIONAL)}
        missing = [c for c in REQUIRED if not self.paths[c].is_file()]
        if missing:
            raise ValueError(f'Missing Waymo components: {", ".join(missing)}')
        self.paths = {c: p for c, p in self.paths.items() if p.is_file()}

    def rows(self, component):
        previous = None
        for batch in self.pq.ParquetFile(self.paths[component]).iter_batches(batch_size=1):
            row = {}
            for name, column in zip(batch.schema.names, batch.columns):
                scalar = column[0]
                if scalar.is_valid and (self.pa.types.is_list(column.type) or self.pa.types.is_large_list(column.type)):
                    row[name] = scalar.values.to_numpy(zero_copy_only=False)
                else:
                    row[name] = scalar.as_py()
            if row.get(SEGMENT) != self.segment:
                raise ValueError(f'Segment identity mismatch in {component}')
            if TIME in row:
                timestamp = row[TIME]
                if not isinstance(timestamp, int) or (previous is not None and timestamp < previous):
                    raise ValueError(f'{component} must be sorted by integer frame_timestamp_micros')
                previous = timestamp
            yield row

    def groups(self, component):
        for timestamp, rows in groupby(self.rows(component), key=lambda r: r[TIME]):
            yield timestamp, list(rows)

    def calibration(self, component, key):
        result = {}
        for row in self.rows(component):
            identifier = row[key]
            if identifier in result:
                raise ValueError(f'Duplicate sensor calibration in {component}')
            result[identifier] = row
        return result
