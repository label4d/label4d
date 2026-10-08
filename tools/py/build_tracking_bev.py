"""Rasterize the filtered tracking cloud in the same Y-up world XZ plane."""
import json
import pathlib
import argparse

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


def rasterize_bev(files, output, mpp):
    """Shared rasterizer independent of runtime manifest version."""
    if not files or not np.isfinite(mpp) or mpp <= 0:
        raise ValueError('BEV requires clouds and positive mpp')
    lower, upper = np.full(2, np.inf), np.full(2, -np.inf)
    for path in files:
        points = read_points(path)[:, [0, 2]]
        if not len(points):
            continue
        lower = np.minimum(lower, points.min(axis=0))
        upper = np.maximum(upper, points.max(axis=0))
    if not np.isfinite(lower).all():
        raise ValueError('No static points available for a BEV map')
    origin = np.floor((lower - 2) / mpp) * mpp
    required = int(np.ceil(((upper + 2 - origin) / mpp).max()))
    size = 2 ** int(np.ceil(np.log2(required)))
    if size > 4096:
        raise ValueError('BEV exceeds 4096 pixels per side; increase --bev-mpp (or --mpp for standalone BEV)')
    counts = np.zeros(size * size, dtype=np.uint32)
    total = 0
    for path in files:
        points = read_points(path)
        indices = pixel_indices(points, origin, mpp, size)
        if len(indices) != len(points):
            raise ValueError('BEV extent cropped source points')
        np.add.at(counts, indices, 1)
        total += len(indices)
    density = counts.reshape(size, size)
    image = np.full((size, size, 3), [12, 20, 28], dtype=np.uint8)
    occupied = density > 0
    brightness = np.clip(55 + np.log1p(density[occupied]) * 28, 0, 210)
    image[occupied] = np.stack([brightness * .65, brightness * .92, brightness], axis=1).astype(np.uint8)
    (output / 'bev').mkdir(parents=True, exist_ok=True)
    Image.fromarray(image).save(output / 'bev/map.png')
    config = {'originX': float(origin[0]), 'originZ': float(origin[1]),
              'metersPerPixel': mpp, 'width': size, 'height': size}
    report = {'sourcePoints': total, 'occupiedPixels': int(occupied.sum()),
              'rowAxis': '+Z', 'columnAxis': '+X'}
    return config, report


def build_bev(source=SOURCE, output=OUT, mpp=MPP):
    files = sorted(source.glob('*.pcd'))
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if len(files) != manifest['frameCount']:
        raise ValueError('BEV requires one filtered PCD per manifest frame')
    config, bev_report = rasterize_bev(files, output, mpp)
    prefix = manifest['pointCloud']['urlTemplate'].split('/pcd/')[0]
    manifest['bev'] = {'tileset': {**config, 'tileSize': config['width'],
                                 'urlTemplate': f'{prefix}/bev/map.png'}}
    manifest_path.write_text(json.dumps(manifest, indent=2))
    report_path = output / 'alignment-report.json'
    report = json.loads(report_path.read_text())
    if bev_report['sourcePoints'] != report['staticPoints']:
        raise ValueError('BEV source does not match the filtered Potree cloud')
    report['bev'] = bev_report
    report_path.write_text(json.dumps(report, indent=2))
    print(f"BEV: {config['width']}x{config['height']}, {mpp} m/px, {bev_report['sourcePoints']} same-source static points")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=pathlib.Path, required=True, help='Filtered static PCD directory')
    parser.add_argument('--output', type=pathlib.Path, required=True, help='Imported sequence directory')
    parser.add_argument('--mpp', type=float, default=MPP)
    args = parser.parse_args()
    build_bev(args.input, args.output, args.mpp)
