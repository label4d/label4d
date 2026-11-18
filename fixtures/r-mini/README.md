# r-mini

Historical fixture for the KITTI raw drive 0084 (tracking sequence 0011). It is
a small reference input for schema, checksum and projection checks, not a demo
dataset and not a dataset you can open in the browser.

- `manifest.json` — v2 manifest with ego poses, sensor entries and BEV/resource
  references derived from the official KITTI release.
- `reference-answers.json` — independent reference boxes taken from official
  KITTI tracking labels (human annotations), used to check that a converter
  reproduces the same geometry.
- `checksums.json` — content hashes for the fixture files.

## Attribution

These files are derived from the KITTI Vision Benchmark Suite and are
redistributed under the KITTI dataset terms, **not** under this project's
license. Sources and the required citation are listed in the repository
[NOTICE](../../NOTICE); see also
[the calibration README](../calibration/2011_09_26/README.md).

## Known limitation

Raw drive 0084 was incorrectly associated with tracking 0011 by earlier local
scripts, and the v2 manifest format is a historical input only — the runtime
reads format version 1. Correct internal transforms do not prove that two
different recordings correspond, so this fixture must not be used as evidence
of alignment to tracking 0011.
