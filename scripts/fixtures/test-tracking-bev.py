"""Independent raster checks: asymmetric axes and actual filtered source points."""
import importlib.util
import json
import unittest

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('bev', __file__.replace('test-tracking-bev.py', 'build-tracking-bev.py'))
bev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bev)


class BevAlignment(unittest.TestCase):
    def test_asymmetric_xz_axes_and_pixel_bounds(self):
        points = np.array([[10.1, 50, -19.9], [10.9, -50, -19.1], [11.1, 0, -19.9], [9.9, 0, -20]])
        self.assertEqual(bev.pixel_indices(points, np.array([10, -20]), .5, 4).tolist(), [0, 5, 2])

    def test_real_static_points_land_on_occupied_pixels(self):
        manifest = json.loads((bev.OUT / 'manifest.json').read_text())
        config = manifest['bev']['tileset']
        image = np.asarray(Image.open(bev.OUT / 'bev/map.png'))
        self.assertEqual(image.shape, (config['height'], config['width'], 3))
        background = np.array([12, 20, 28])
        for frame in [0, 12, 100, 199]:
            points = bev.read_points(bev.SOURCE / f'{frame}.pcd')[::997]
            # Compute X/row independently of the rasterizer helper.
            cols = np.floor((points[:, 0] - config['originX']) / config['metersPerPixel']).astype(int)
            rows = np.floor((points[:, 2] - config['originZ']) / config['metersPerPixel']).astype(int)
            self.assertTrue(((cols >= 0) & (cols < config['width'])).all())
            self.assertTrue(((rows >= 0) & (rows < config['height'])).all())
            self.assertTrue((image[rows, cols] != background).any(axis=1).all())
        report = json.loads((bev.OUT / 'alignment-report.json').read_text())
        self.assertEqual(report['bev']['sourcePoints'], report['staticPoints'])


if __name__ == '__main__':
    unittest.main()
