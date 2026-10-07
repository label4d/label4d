import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

TOOL = Path(__file__).resolve().parents[1] / 'import_kitti_tracking.py'


class KittiImport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'input'
        self.output = self.root / 'output'
        self.training = self.source / 'training'
        for directory in ['image_02/0004', 'velodyne/0004', 'oxts', 'calib', 'label_02']:
            (self.training / directory).mkdir(parents=True)
        for frame in range(2):
            Image.new('RGB', (16, 8), (frame * 40, 0, 0)).save(self.training / f'image_02/0004/{frame:06d}.png')
            np.array([[2, 1, 8, .5], [10, 0, 20, .8]], dtype='<f4').tofile(self.training / f'velodyne/0004/{frame:06d}.bin')
        (self.training / 'oxts/0004.txt').write_text('49 8 0 0 0 0\n49 8 0 0 0 0\n')
        (self.training / 'calib/0004.txt').write_text(
            'P2: 4 0 8 -0.4 0 4 4 0 0 0 1 0\nR_rect: 1 0 0 0 1 0 0 0 1\n'
            'Tr_velo_cam: 1 0 0 0 0 1 0 0 0 0 1 0\nTr_imu_velo: 1 0 0 0 0 1 0 0 0 0 1 0\n')
        (self.training / 'label_02/0004.txt').write_text(''.join(
            f'{frame} 7 Car 0 0 0 0 0 15 7 2 2 4 2 2 8 0\n' for frame in range(2)))

    def run_import(self, *extra):
        return subprocess.run([sys.executable, str(TOOL), '--input', str(self.source), '--sequence', '0004',
                               '--output', str(self.output), '--url-prefix', '/datasets/custom', '--skip-potree',
                               *extra], capture_output=True, text=True)

    def test_new_sequence_all_frames_camera_size_boxes_and_urls(self):
        result = self.run_import()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['frameCount'], 2)
        self.assertEqual(manifest['cameras'][0]['width'], 16)
        self.assertEqual(manifest['cameras'][0]['height'], 8)
        self.assertEqual(manifest['cameras'][0]['imageTemplate'], '/datasets/custom/images/{frame}.png')
        self.assertEqual(manifest['bev']['tileset']['urlTemplate'], '/datasets/custom/bev/map.png')
        self.assertNotIn('potree', manifest)
        track = json.loads((self.output / 'snapshot.json').read_text())['tracks'][0]
        self.assertEqual(track['keyframes']['frames'], [0, 1])
        np.testing.assert_allclose(track['keyframes']['pos'][:3], [2, 8, -1])
        np.testing.assert_allclose(track['keyframes']['yaw'], [0, 0])
        report = json.loads((self.output / 'alignment-report.json').read_text())
        self.assertEqual(report['dynamicPoints'], 4)
        self.assertEqual(report['staticPoints'], 2)  # Both car-interior returns filtered.
        self.assertEqual(report['bev']['sourcePoints'], 2)
        self.assertEqual(self.run_import().returncode, 2)  # Never silently replace an imported dataset.

    def test_frame_limit_and_missing_pair_validation(self):
        result = self.run_import('--frames', '1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.output / 'manifest.json').read_text())['frameCount'], 1)
        (self.training / 'image_02/0004/000001.png').unlink()
        result = self.run_import('--overwrite')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('paired source frame 1', result.stderr)
        self.assertEqual(json.loads((self.output / 'manifest.json').read_text())['frameCount'], 1)

    def test_cache_identity_mismatch_rejected(self):
        self.source.mkdir(exist_ok=True)
        # Force compact-cache discovery by hiding the official layout.
        self.training.rename(self.source / 'archived')
        (self.source / 'source.json').write_text(json.dumps({'sequence': '0011'}))
        result = self.run_import()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('matching source.json', result.stderr)
        self.assertFalse(self.output.exists())

    def test_invalid_calibration_is_rejected_before_output(self):
        (self.training / 'calib/0004.txt').write_text('P2: 0 0 0\n')
        result = self.run_import()
        self.assertEqual(result.returncode, 2)
        self.assertIn('invalid tracking calibration', result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
