# Labelfaster

A browser-based workspace for annotating 4D point-cloud sequences with synchronized camera views.

Labelfaster combines a React/Three.js editor, a TypeScript annotation engine, and Python data tools. It runs locally with static datasets and saves annotation documents in the browser.

## What works today

- Current-frame point clouds and a streamed static Potree overlay.
- BEV image maps with current-frame lidar, boxes and ego trajectories.
- Calibrated camera images, box projection and optional same-frame lidar projection.
- Track keyframes, interpolation, object attributes, static geometry, selection and undo/redo.
- Playback and seeking with separate requested and presented frames. Both 3D and BEV follow the ego vehicle by default.
- Local IndexedDB persistence and JSON snapshot import/export.
- A self-contained synthetic demo and a reusable KITTI tracking importer.

The runtime uses **v1, right-handed Y-up coordinates**. It is a local, single-editor application; a collaboration server, v2 timestamp model and other dataset adapters are future work. See the [roadmap](docs/roadmap.md).

## Quick start

Requirements: Node.js 20 or newer and pnpm 8.15.0. Python 3.11+ and [uv](https://docs.astral.sh/uv/) are needed only for the data tools and fixture checks. A WebGL-capable browser is required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The synthetic demo needs no external dataset. Development resolves the core package directly from source.

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

The [data-tools guide](tools/README.md) covers directory layout, downloading selected official frames, full imports, output identity and rebuilding. The [KITTI verification guide](docs/real-camera-preview.md) covers the supplied 200-frame preview.

Dataset downloads and generated assets are not committed. KITTI and third-party dependencies retain their own usage and license terms.

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

Playwright starts its own test server on port **4173**, which must be free. Real-data tests skip when their generated assets are absent; a passing demo test run does not establish real-data alignment. Python tool tests include a small, generated input independent of the real preview.

Annotation saves are local to the browser profile and origin. Export snapshots for backup before clearing browser data or changing origins; generated datasets and saved annotation documents are different artifacts.

## Documentation and contributing

- [Documentation index](docs/README.md) — current guides, including Chinese technical documentation.
- [Architecture](docs/architecture.md) — implemented components and Mermaid diagrams.
- [Data formats](docs/data-formats.md) — coordinates, manifest and snapshot contracts.
- [Contributing](CONTRIBUTING.md) — development and verification workflow.
- [AGENTS.md](AGENTS.md) — repository guidance for coding agents.

## License status

A project license has not yet been selected. Public-source preparation does not itself grant redistribution or modification rights; maintainers must add the selected license before an open-source release. Dataset and dependency terms are separate.
