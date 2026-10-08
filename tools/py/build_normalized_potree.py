"""Add a filtered static Potree overlay to an existing normalized sequence."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np

from export_world_las import read_pcd_xyz
from import_waymo import file_hash
from pipeline.geometry import points_outside_boxes
from pipeline.pcd import write_pcd
from validate_normalized import resource, validate_directory, validate_potree


def build(root, converter, padding=.2):
    root = Path(root).resolve()
    converter = Path(converter).resolve()
    if not np.isfinite(padding) or padding < 0:
        raise ValueError('Padding must be finite and nonnegative')
    if not converter.is_file() or not os.access(converter, os.X_OK):
        raise ValueError('An executable PotreeConverter is required')
    original = (root / 'sequence.json').read_bytes()
    sequence = json.loads(original)
    target = root / 'potree'
    if 'potree' in sequence or target.exists():
        raise ValueError('Potree already exists; use a fresh dataset output for rebuilding')
    validate_directory(root)
    with tempfile.TemporaryDirectory(prefix='.potree-build-', dir=root) as tmp:
        work = Path(tmp)
        counts = []
        for entry in sequence['frames']:
            frame = json.loads(resource(root, entry['path']).read_text())
            points = read_pcd_xyz(resource(root, frame['pointCloud']['path']))
            filtered = points[points_outside_boxes(points, frame['boxObservations'], padding)]
            counts.append({'frame': entry['index'], 'input': len(points), 'kept': len(filtered)})
            if len(filtered):
                write_pcd(work / 'pcd' / f"{entry['index']}.pcd", filtered)
        total = sum(c['kept'] for c in counts)
        if not total:
            raise ValueError('No points remain after filtering')
        subprocess.run([sys.executable, str(Path(__file__).with_name('export_world_las.py')),
                        '--input', str(work), '--output', str(work / 'world.las')], check=True)
        output = work / 'potree'
        subprocess.run([str(converter), str(work / 'world.las'), '-o', str(output),
                        '--encoding', 'UNCOMPRESSED'], check=True)
        descriptor = {'path': 'potree', 'encoding': 'UNCOMPRESSED', 'frameCount': len(counts),
                      'pointCount': total, 'policy': 'all-observed-boxes-excluded', 'boxPaddingMeters': padding,
                      'files': [{'path': name, 'sha256': file_hash(output / name)}
                                for name in ('metadata.json', 'hierarchy.bin', 'octree.bin')]}
        validate_potree(work, descriptor, len(counts))
        report = {'sequenceId': sequence['id'], 'frames': counts, 'inputPoints': sum(c['input'] for c in counts),
                  'keptPoints': total, 'excludedPoints': sum(c['input']-c['kept'] for c in counts),
                  'boxPaddingMeters': padding, 'limitation': 'Unlabeled moving objects may remain.'}
        (output / 'build-report.json').write_text(json.dumps(report, indent=2)+'\n')
        sequence['potree'] = descriptor
        staged = work / 'sequence.json'
        staged.write_text(json.dumps(sequence, indent=2)+'\n')
        if (root / 'sequence.json').read_bytes() != original or target.exists():
            raise ValueError('Dataset changed during conversion; refusing publication')
        output.rename(target)
        try:
            os.replace(staged, root / 'sequence.json')
        except BaseException:
            target.rename(output)
            raise
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--potree-converter', type=Path, default=Path(os.environ.get(
        'LABELFASTER_POTREE_CONVERTER', 'third_party/PotreeConverter/build/PotreeConverter')))
    parser.add_argument('--box-padding', type=float, default=.2)
    args = parser.parse_args()
    print(json.dumps(build(args.input, args.potree_converter, args.box_padding), indent=2))
