"""Publication and integrity regressions for the optional static overlay."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_normalized_potree import build
from pipeline.pcd import write_pcd
from validate_normalized import validate_potree


class NormalizedPotree(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.converter = self.root / 'converter'; self.converter.write_text(''); self.converter.chmod(0o700)
        self.original = json.dumps({'id': 'recording', 'frames': [{'index': 0, 'path': 'frames/0.json'}, {'index': 1, 'path': 'frames/1.json'}]})
        (self.root / 'sequence.json').write_text(self.original)
        (self.root / 'frames').mkdir()
        for i in range(2):
            write_pcd(self.root / f'pcd/{i}.pcd', np.array([[0,0,0,1], [5,0,0,2]], dtype=np.float32))
            box = {'size': [2,2,2] if i == 0 else [20,20,20], 'boxToWorld': np.eye(4).flatten(order='F').tolist()}
            (self.root / f'frames/{i}.json').write_text(json.dumps({'pointCloud': {'path': f'pcd/{i}.pcd'}, 'boxObservations': [box]}))

    def conversion(self, args, check):
        if args[0] == str(self.converter.resolve()):
            out = Path(args[args.index('-o')+1]); out.mkdir()
            (out/'metadata.json').write_text(json.dumps({'version':'2.0','encoding':'UNCOMPRESSED','points':1}))
            (out/'hierarchy.bin').write_bytes(b'hierarchy'); (out/'octree.bin').write_bytes(b'points')
        else:
            # Fully excluded frame must be skipped, otherwise LAS bounds fail.
            work = Path(args[args.index('--input')+1])
            self.assertEqual([p.name for p in (work/'pcd').glob('*.pcd')], ['0.pcd'])

    def test_empty_frame_counts_and_checksum_binding(self):
        with patch('build_normalized_potree.validate_directory'), patch('build_normalized_potree.subprocess.run', side_effect=self.conversion):
            report = build(self.root, self.converter)
        self.assertEqual((report['inputPoints'], report['keptPoints'], report['excludedPoints']), (4,1,3))
        sequence = json.loads((self.root/'sequence.json').read_text())
        self.assertEqual(sequence['id'], 'recording')
        validate_potree(self.root, sequence['potree'], 2)
        (self.root/'potree/octree.bin').write_bytes(b'corruption')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            validate_potree(self.root, sequence['potree'], 2)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            build(self.root, self.converter)

    def test_failed_converter_does_not_publish(self):
        with patch('build_normalized_potree.validate_directory'), patch('build_normalized_potree.subprocess.run', side_effect=RuntimeError('converter failed')):
            with self.assertRaises(RuntimeError): build(self.root, self.converter)
        self.assertEqual((self.root/'sequence.json').read_text(), self.original)
        self.assertFalse((self.root/'potree').exists())
        self.assertFalse(list(self.root.glob('.potree-build-*')))

    def test_failed_index_publication_rolls_back_overlay(self):
        with patch('build_normalized_potree.validate_directory'), patch('build_normalized_potree.subprocess.run', side_effect=self.conversion), patch('build_normalized_potree.os.replace', side_effect=OSError('publish failed')):
            with self.assertRaises(OSError): build(self.root, self.converter)
        self.assertEqual((self.root/'sequence.json').read_text(), self.original)
        self.assertFalse((self.root/'potree').exists())

    def test_rejects_invalid_padding_before_processing(self):
        for padding in (-1, float('nan')):
            with self.assertRaisesRegex(ValueError, 'Padding'): build(self.root, self.converter, padding)
