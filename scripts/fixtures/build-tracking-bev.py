"""Rasterize the filtered tracking cloud in the same Y-up world XZ plane."""
import json
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web-ui/public/kitti-camera'
SOURCE = ROOT / 'fixtures/kitti-tracking-source/static-preview/pcd'
MPP = 0.15


def read_points(path):
    data = path.read_bytes()
    start = data.index(b'DATA binary\n') + len(b'DATA binary\n')
    return np.frombuffer(data, dtype='<f4', offset=start).reshape(-1, 4)[:, :3]


def pixel_indices(points, origin, mpp, size):
    # Image top row is minZ, rows increase toward +Z. Pixel bounds, not centers.
    pixels = np.floor((points[:, [0, 2]] - origin) / mpp).astype(np.int64)
    valid = (pixels >= 0).all(axis=1) & (pixels < size).all(axis=1)
    return pixels[valid, 1] * size + pixels[valid, 0]


def main():
    files = sorted(SOURCE.glob('*.pcd'))
    if len(files) != 200:
        raise ValueError('Build the official 200-frame tracking preview first')
    lower, upper = np.full(2, np.inf), np.full(2, -np.inf)
    for path in files:
        points = read_points(path)[:, [0, 2]]
        lower = np.minimum(lower, points.min(axis=0))
        upper = np.maximum(upper, points.max(axis=0))
    origin = np.floor((lower - 2) / MPP) * MPP
    required = int(np.ceil(((upper + 2 - origin) / MPP).max()))
    size = 2 ** int(np.ceil(np.log2(required)))
    counts = np.zeros(size * size, dtype=np.uint32)
    total = 0
    for path in files:
        points = read_points(path)
        indices = pixel_indices(points, origin, MPP, size)
        if len(indices) != len(points):
            raise ValueError('BEV extent cropped source points')
        np.add.at(counts, indices, 1)
        total += len(indices)
    density = counts.reshape(size, size)
    image = np.full((size, size, 3), [12, 20, 28], dtype=np.uint8)
    occupied = density > 0
    brightness = np.clip(55 + np.log1p(density[occupied]) * 28, 0, 210)
    image[occupied] = np.stack([brightness * .65, brightness * .92, brightness], axis=1).astype(np.uint8)
    (OUT / 'bev').mkdir(exist_ok=True)
    Image.fromarray(image).save(OUT / 'bev/map.png')
    manifest_path = OUT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['bev'] = {'tileset': {
        'originX': float(origin[0]), 'originZ': float(origin[1]),
        'metersPerPixel': MPP, 'width': size, 'height': size, 'tileSize': size,
        'urlTemplate': '/kitti-camera/bev/map.png',
    }}
    manifest_path.write_text(json.dumps(manifest, indent=2))
    report_path = OUT / 'alignment-report.json'
    report = json.loads(report_path.read_text())
    if total != report['staticPoints']:
        raise ValueError('BEV source does not match the filtered Potree cloud')
    report['bev'] = {'sourcePoints': total, 'occupiedPixels': int(occupied.sum()), 'rowAxis': '+Z', 'columnAxis': '+X'}
    report_path.write_text(json.dumps(report, indent=2))
    print(f'BEV: {size}x{size}, {MPP} m/px, {total} same-source static points')


if __name__ == '__main__':
    main()
