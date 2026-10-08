"""Synthetic contract regressions; independent real SDK checks run separately."""
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.waymo import WaymoSource, decode_return, SEGMENT, TIME
from pipeline.geometry import BASIS, box_transform, points_outside_boxes, rotation_rpy
from import_waymo import import_segment

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    import jsonschema
    from validate_normalized import validate_directory
except ImportError:
    pa = None


class RangeGeometry(unittest.TestCase):
    def calibration(self):
        return {'[LiDARCalibrationComponent].extrinsic.transform': np.eye(4).flatten(),
                '[LiDARCalibrationComponent].beam_inclination.values': [0],
                '[LiDARCalibrationComponent].beam_inclination.min': -.1,
                '[LiDARCalibrationComponent].beam_inclination.max': .1}

    def test_azimuth_pixel_centers_and_no_double_ego_transform(self):
        image = np.array([[[10, .5, 1, -1], [10, .7, 2, 1]]], dtype=float)
        vehicle = np.eye(4); vehicle[0, 3] = 100
        local = BASIS.copy(); local[:3, 3] = [-100, 0, 0]
        cloud, indices, extra = decode_return(image, self.calibration(), vehicle, local)
        np.testing.assert_allclose(cloud[:, :3], [[0, 0, -10], [0, 0, 10]], atol=1e-12)
        np.testing.assert_array_equal(indices, [[0, 0], [0, 1]])
        np.testing.assert_array_equal(extra, [[1, -1], [2, 1]])
        pixel_pose = np.array([[[0, 0, 0, 101, 0, 0], [0, 0, 0, 102, 0, 0]]], dtype=float)
        cloud, _, _ = decode_return(image, self.calibration(), vehicle, local, pixel_pose)
        np.testing.assert_allclose(cloud[:, :3], [[1, 0, -10], [2, 0, 10]], atol=1e-12)

    def test_reversed_beams_and_bad_pose_shape(self):
        image = np.ones((2, 1, 4)); image[..., 0] = 10
        calibration = self.calibration()
        calibration['[LiDARCalibrationComponent].beam_inclination.values'] = [-.2, .2]
        cloud, _, _ = decode_return(image, calibration, np.eye(4), BASIS)
        self.assertGreater(cloud[0, 1], 0); self.assertLess(cloud[1, 1], 0)
        with self.assertRaisesRegex(ValueError, 'per-pixel pose'):
            decode_return(image, calibration, np.eye(4), BASIS, np.ones((1, 1, 6)))

    def test_tilted_box_retains_axes_and_filters_in_its_local_frame(self):
        vehicle = BASIS.copy(); vehicle[:3, :3] = BASIS[:3, :3] @ rotation_rpy([.2, .1, .5])
        box = box_transform([5, 1, 2], .7, vehicle)
        size = [4, 2, 1]
        # Length, height, width basis includes the source-to-display basis.
        expected = vehicle[:3, :3] @ rotation_rpy([0, 0, .7]) @ BASIS[:3, :3].T
        np.testing.assert_allclose(box[:3, :3], expected)
        self.assertGreater(abs(box[1, 0]), .01)  # A yaw-only world box loses this.
        points = np.array([box[:3, 3], box[:3, 3]+box[:3, 0]*3])
        keep = points_outside_boxes(points, [{'size': size, 'boxToWorld': box.flatten(order='F').tolist()}], 0)
        np.testing.assert_array_equal(keep, [False, True])


@unittest.skipIf(pa is None, 'Run pnpm test:tools:waymo for Parquet/contract regressions')
class WaymoImport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.source_root = self.root / 'input'; self.output = self.root / 'out'
        self.segment = '100_0_000_20_000'; self.t0 = 1_500_000_000_000_000
        self.components = {}
        photo = io.BytesIO(); Image.new('RGB', (16, 8), (10, 40, 80)).save(photo, format='JPEG')
        camera_prefix = '[CameraCalibrationComponent]'
        lidar_prefix = '[LiDARCalibrationComponent]'
        for cid in range(1, 6):
            cal = {SEGMENT: self.segment, 'key.camera_name': cid, camera_prefix+'.extrinsic.transform': np.eye(4).flatten().tolist(),
                   camera_prefix+'.width': 16, camera_prefix+'.height': 8, camera_prefix+'.rolling_shutter_direction': 4}
            for k, v in zip(('f_u', 'f_v', 'c_u', 'c_v', 'k1', 'k2', 'p1', 'p2', 'k3'), (10, 10, 8, 4, 0, 0, 0, 0, 0)):
                cal[camera_prefix+'.intrinsic.'+k] = float(v)
            self.components.setdefault('camera_calibration', []).append(cal)
            self.components.setdefault('lidar_calibration', []).append({SEGMENT: self.segment, 'key.laser_name': cid,
                lidar_prefix+'.extrinsic.transform': np.eye(4).flatten().tolist(), lidar_prefix+'.beam_inclination.values': [0.],
                lidar_prefix+'.beam_inclination.min': -.1, lidar_prefix+'.beam_inclination.max': .1})
        for frame, delta in enumerate((0, 110_000)):
            t = self.t0+delta; pose = np.eye(4); pose[0, 3] = 100+frame
            pose[:3, :3] = rotation_rpy([.05*frame, 0, 0])
            self.components.setdefault('vehicle_pose', []).append({SEGMENT: self.segment, TIME: t,
                '[VehiclePoseComponent].world_from_vehicle.transform': pose.flatten().tolist()})
            for sensor in range(1, 6):
                self.components.setdefault('camera_image', []).append({SEGMENT: self.segment, TIME: t, 'key.camera_name': sensor,
                    '[CameraImageComponent].image': photo.getvalue(), '[CameraImageComponent].pose.transform': pose.flatten().tolist(),
                    '[CameraImageComponent].pose_timestamp': (t+5000)/1e6,
                    '[CameraImageComponent].rolling_shutter_params.shutter': .001})
                ri = {SEGMENT: self.segment, TIME: t, 'key.laser_name': sensor}
                cp = ri.copy()
                for ret in (1, 2):
                    name = f'range_image_return{ret}'
                    ri[f'[LiDARComponent].{name}.shape'] = [1, 2, 4]
                    ri[f'[LiDARComponent].{name}.values'] = [10., .5, .2, -1., 20., .7, .3, 1.]
                    cp[f'[LiDARCameraProjectionComponent].{name}.shape'] = [1, 2, 6]
                    cp[f'[LiDARCameraProjectionComponent].{name}.values'] = [1, 2, 3, 0, 0, 0, 2, 4, 5, 0, 0, 0]
                self.components.setdefault('lidar', []).append(ri)
                self.components.setdefault('lidar_camera_projection', []).append(cp)
            self.components.setdefault('lidar_pose', []).append({SEGMENT: self.segment, TIME: t, 'key.laser_name': 1,
                '[LiDARPoseComponent].range_image_return1.shape': [1, 2, 6],
                '[LiDARPoseComponent].range_image_return1.values': [0., 0., 0., 100.+frame, 0., 0.]*2})
            box = {SEGMENT: self.segment, TIME: t, 'key.laser_object_id': 'same-object', '[LiDARBoxComponent].type': 1,
                   '[LiDARBoxComponent].box.heading': 0.}
            for k, v in zip(('center.x', 'center.y', 'center.z', 'size.x', 'size.y', 'size.z'), (0, 10, 0, 4, 2, 2)):
                box['[LiDARBoxComponent].box.'+k] = float(v)
            self.components.setdefault('lidar_box', []).append(box)
        self.write_source()

    def write_source(self):
        for c, rows in self.components.items():
            path = self.source_root / 'validation' / c / f'{self.segment}.parquet'
            path.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(pa.Table.from_pylist(rows), path)

    def source(self):
        return WaymoSource(self.source_root, 'validation', self.segment)

    def test_import_retains_time_camera_pose_returns_and_attribute_binding(self):
        sequence, report = import_segment(self.source(), self.output)
        self.assertEqual([f['timeMicros'] for f in sequence['frames']], [0, 110_000])
        self.assertEqual(sequence['time']['sourceOriginMicros'], str(self.t0))
        self.assertFalse((self.output / 'manifest.json').exists())
        frame = json.loads((self.output / 'frames/0.json').read_text())
        self.assertEqual(len(frame['samples']), 15)
        self.assertEqual(frame['samples'][0]['poseTimeMicros'], 5000)
        self.assertEqual(frame['boxObservations'][0]['size'], [4, 2, 2])
        self.assertEqual(report['dynamicPoints'], 40)
        self.assertEqual(validate_directory(self.output)['frames'], 2)
        with np.load(self.output / 'attributes/0.npz') as attrs:
            self.assertEqual(set(attrs['return_id']), {1, 2})
            self.assertEqual(set(attrs['sensor_id']), set(range(1, 6)))
        # Binding catches changed point ordering/data, not merely equal lengths.
        path = self.output / 'pcd/0.pcd'; data = bytearray(path.read_bytes()); data[-1] ^= 1; path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            validate_directory(self.output)

    def test_missing_sensor_and_wrong_segment_fail(self):
        self.components['camera_image'].pop(0); self.write_source()
        with self.assertRaisesRegex(ValueError, 'sensor set mismatch'):
            import_segment(self.source(), self.output)
        self.components['lidar'][0][SEGMENT] = 'different'; self.write_source()
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            list(self.source().rows('lidar'))

    def test_source_cache_cannot_be_reused_for_another_release(self):
        (self.source_root / 'source.json').write_text(json.dumps({'version': '1.4.3',
            'split': 'validation', 'segmentId': self.segment}))
        with self.assertRaisesRegex(ValueError, 'release/split/segment'):
            self.source()

    def test_unsorted_duplicate_and_oversized_frame_requests_fail(self):
        with self.assertRaisesRegex(ValueError, 'exceeds source'):
            import_segment(self.source(), self.output, frames=3)
        self.components['lidar'].reverse(); self.write_source()
        with self.assertRaisesRegex(ValueError, 'sorted'):
            list(self.source().rows('lidar'))
        self.components['lidar'].reverse()
        self.components['camera_image'].insert(0, self.components['camera_image'][0]); self.write_source()
        with self.assertRaisesRegex(ValueError, 'Duplicate camera'):
            import_segment(self.source(), self.output)

    def run_cli(self):
        return subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'import_waymo.py'),
            '--input', str(self.source_root), '--output', str(self.output), '--segment', self.segment],
            capture_output=True, text=True)

    def test_failed_import_is_not_published_and_existing_output_is_preserved(self):
        # Failure after the first complete frame must remove partial staged files.
        self.components['camera_image'].pop(); self.write_source()
        result = self.run_cli()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.waymo-import-*')), [])
        self.output.mkdir(); (self.output / 'saved.json').write_text('preserve')
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertEqual((self.output / 'saved.json').read_text(), 'preserve')

    def test_relative_resources_and_sensor_spans_are_enforced(self):
        import_segment(self.source(), self.output, frames=1)
        frame_path = self.output / 'frames/0.json'
        original = json.loads(frame_path.read_text())
        modified = json.loads(frame_path.read_text()); modified['samples'][0]['image'] = '../escape.jpg'
        frame_path.write_text(json.dumps(modified))
        with self.assertRaisesRegex(ValueError, 'relative paths'):
            validate_directory(self.output)
        original['samples'][-1]['returnId'] = 1
        frame_path.write_text(json.dumps(original))
        with self.assertRaisesRegex(ValueError, 'Duplicate lidar return'):
            validate_directory(self.output)


if __name__ == '__main__':
    unittest.main()
