# Labelfaster

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/k7/labelfaster/actions/workflows/ci.yml/badge.svg)](https://github.com/k7/labelfaster/actions/workflows/ci.yml)

A browser-based workspace for annotating 4D point-cloud sequences with synchronized camera views.

Labelfaster combines a React/Three.js editor, a TypeScript annotation engine, and Python data tools. It runs locally with static datasets and saves annotation documents in the browser.

## What works today

- Current-frame point clouds and a streamed static Potree overlay.
- BEV image maps with current-frame lidar, boxes and ego trajectories.
- Calibrated camera images, box projection and optional same-frame lidar projection.
- Track keyframes, interpolation, object attributes, static geometry, selection and undo/redo.
- Playback and seeking with separate requested and presented frames. Both 3D and BEV follow the ego vehicle by default.
- Local IndexedDB persistence and JSON snapshot import/export.
- Reusable KITTI tracking and Waymo Perception Python importers.
- Shared DatasetProvider resources for KITTI and Waymo, with explicit editing, projection and image-loading capabilities.
- Read-only Waymo source browsing: real timestamps, five cameras, full-pose boxes and official point pixel references.

Editable documents use **v1, right-handed Y-up coordinates**. Waymo normalized sequences use a separate, explicitly read-only browser presentation contract; they are never converted to yaw-only v1 documents. Full-pose editing and collaboration remain future work. See the [roadmap](docs/roadmap.md).

## Quick start

Requirements: Node.js 20 or newer and pnpm 8.15.0. Python 3.11+ and [uv](https://docs.astral.sh/uv/) are needed only for the data tools and fixture checks. A WebGL-capable browser is required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The home page loads `/kitti-camera/manifest.json` by default. Prepare that real dataset with `pnpm fixtures:camera-preview` (requires Python/uv and PotreeConverter), or use `?manifest=...` for another imported dataset. Missing real data produces an explicit error; there is no synthetic fallback.

Development resolves the core package directly from source. The application has no synthetic demo or mock model pre-annotation. Small static inputs under `apps/web-ui/tests/fixtures/` are used only by automated tests and are not bundled.

For a production build:

```sh
pnpm build
pnpm --filter @labelfaster/web-ui preview
```

The output is `apps/web-ui/dist`. Serve it over HTTP; `file://` does not provide the required loading and browser-storage environment.

## Use real data

The Python importer consumes matching KITTI tracking images, Velodyne frames, OXTS, calibration and labels:

```sh
pnpm data:import:kitti \
  --input /data/kitti --sequence 0004 \
  --output apps/web-ui/public/datasets/kitti-0004 \
  --url-prefix /datasets/kitti-0004 --skip-potree
```

Open `/?manifest=/datasets/kitti-0004/manifest.json` on the running app. `--skip-potree` produces current-frame clouds, annotations, photos and BEV without requiring PotreeConverter. For a static Potree map, build the [converter](third_party/POTREE_BUILD.md) and omit that flag.

For a complete download → preprocessing → validation → browser walkthrough, see the [reproduction guide](docs/data-reproduction.md).

The [data-tools guide](tools/README.md) covers directory layout, downloading selected official frames, full imports, output identity and rebuilding. The [KITTI verification guide](docs/real-camera-preview.md) covers the supplied 200-frame preview.

Use the dataset selector in the top bar to switch between the prepared KITTI preview and the full Waymo sequence (`/datasets/waymo-normalized-198/sequence.json`). Switching reloads the page and restores saved KITTI annotations when you return. Both datasets must be generated locally; a missing resource reports a loading error.

Open imported Waymo data with `/?manifest=/datasets/waymo-normalized-20/sequence.json`. Playback uses source timestamps; 3D/BEV display complete box poses. Camera overlays use supplied 2D projected boxes and official point-to-pixel references, without claiming rolling-shutter reprojection. Source browsing does not write IndexedDB or export v1 snapshots.

Add a static map to an imported normalized sequence with `pnpm data:potree:normalized --input <dataset-directory>` (requires PotreeConverter), then reload its page. Current-frame clouds remain available.

For Waymo import and independent SDK checks, see the [data-tools guide](tools/README.md) and [normalized contract](docs/normalized-data.md).

Dataset downloads and generated assets are not committed. KITTI and third-party dependencies retain their own usage and license terms; see [NOTICE](NOTICE) for the attribution details.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web-ui/` | React application, view composition, panels and browser tests |
| `packages/core/` | Annotation model, commands, session, persistence, streaming, projection and render adapters |
| `tools/py/` | Python/NumPy import, geometry conversion, filtering, BEV, LAS and validation |
| `scripts/` | Fixture orchestration, synthetic fixture generation and engineering checks |
| `fixtures/` | Schemas, test metadata and small calibration/reference inputs |
| `third_party/` | PotreeConverter build instructions and an Apple patch |
| `docs/` | Current architecture, data contracts and operational guides |

## Checks

```sh
pnpm lint
pnpm test
pnpm test:tools
pnpm build
pnpm --filter @labelfaster/web-ui exec playwright install chromium
pnpm --filter @labelfaster/web-ui exec playwright test --workers=2
```

Playwright starts its own test server on port **4173**, which must be free. Real-data tests skip when their generated assets are absent; a passing editor fixture test run does not establish real-data alignment. Python tool tests include a small, generated input independent of the real preview.

The same checks run on every push and pull request through GitHub Actions (`.github/workflows/ci.yml`): lint, unit tests and build, the Python tool tests, and the browser suite. The browser job has no generated KITTI or Waymo assets, so the real-data specs skip there exactly as they do on a fresh clone.

Annotation saves are local to the browser profile and origin. Export snapshots for backup before clearing browser data or changing origins; generated datasets and saved annotation documents are different artifacts.

## Documentation and contributing

- [Documentation index](docs/README.md) — current guides, including Chinese technical documentation.
- [Architecture](docs/architecture.md) — implemented components and Mermaid diagrams.
- [Data formats](docs/data-formats.md) — coordinates, manifest and snapshot contracts.
- [Contributing](CONTRIBUTING.md) — development and verification workflow.
- [AGENTS.md](AGENTS.md) — repository guidance for coding agents.

## License

Labelfaster is licensed under the [MIT License](LICENSE).

```
Copyright (c) 2026 The Labelfaster Authors
```

[NOTICE](NOTICE) records the third-party components this repository references
(PotreeConverter, npm and Python dependencies) and the KITTI reference inputs
that are redistributed under the KITTI dataset terms. The project license
covers the code in this repository only: KITTI and Waymo data keep their own
usage terms, and dataset downloads and generated assets are not committed.
Security reports are handled as described in [SECURITY.md](SECURITY.md).
