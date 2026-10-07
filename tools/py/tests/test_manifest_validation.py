import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_manifest import validate_manifest

ROOT = Path(__file__).resolve().parents[3]


class ManifestValidation(unittest.TestCase):
    def test_repository_samples_match_expected_acceptance(self):
        schema = json.loads((ROOT / 'fixtures/schemas/manifest.v2.schema.json').read_text())
        for path in (ROOT / 'fixtures/schemas/samples').glob('*.json'):
            with self.subTest(sample=path.name):
                errors = validate_manifest(json.loads(path.read_text()), schema)
                self.assertEqual(bool(errors), 'invalid' in path.name, errors)

    def test_duplicate_reference_and_pose_times_are_rejected(self):
        for document in [{'referenceFrames': [{'timeUs': 1}, {'timeUs': 1}]},
                         {'pose': {'frames': [{'timeUs': 2}, {'timeUs': 1}]}}]:
            self.assertTrue(validate_manifest(document, {'type': 'object'}))

    def test_boolean_is_not_an_integer_and_numeric_const_is_not_boolean(self):
        self.assertTrue(validate_manifest(True, {'type': 'integer'}))
        self.assertTrue(validate_manifest(True, {'const': 1}))
        self.assertFalse(validate_manifest(1.0, {'type': 'integer', 'const': 1}))


if __name__ == '__main__':
    unittest.main()
