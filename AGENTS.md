# Repository guidance

## Start here

Read `README.md` and the relevant parts of `docs/architecture.md`. Read `docs/data-formats.md` before changing geometry, projection, import or serialization; read `tools/README.md` before changing offline tooling. These describe the implemented v1 application. `docs/roadmap.md` lists future work, not current guarantees.

Inspect `git status` before editing. Preserve unrelated work and saved annotations. Do not assume generated KITTI assets, a running service, PotreeConverter or any contributor's local paths exist.

## Boundaries

- `apps/web-ui` owns React components and viewport integration. Route annotation edits through `EditorSession`, commands and `History`; do not mutate store arrays from UI handlers.
- `packages/core/src/model`, `command`, `geometry` and `projection` contain domain logic and math. Keep them independent of React and browser UI. Three.js adapters live in `render`; `stream/PotreeSelection.ts` also uses Three.js for view-dependent selection.
- `EditorSession` owns document editing, presentation coordination and resource providers. Selection, hover, navigation and tool previews are session state, not durable annotation edits.
- Offline dataset transforms and numeric processing belong in `tools/py` using Python/NumPy. Reuse the importer and BEV pipeline instead of adding JavaScript duplicates. `scripts` is for orchestration and engineering checks.

## Correctness rules

- Runtime manifests and snapshots are **formatVersion 1**, right-handed **Y-up**. Matrices are column-major; box size is `[length, height, width]`; yaw points along `(cos(yaw), 0, -sin(yaw))` in XZ. Reject incompatible input rather than silently reinterpreting it.
- Render and edit the **presented** frame (`session.frame`), not a requested frame whose resources are still loading. Preserve epoch checks, editing gates and cancellation behavior.
- Use same-recording, same-frame photos, lidar, poses, calibration and labels. For KITTI, OXTS angles are radians, label locations are bottom centers, and `rotation_y` rotates the camera X length axis. Include rectification and the projection baseline.
- Sequence identity determines persisted-document restoration. A different recording or coordinate version needs a different ID. Never clear browser storage to hide a seed-data mismatch.
- Keep edits atomic and reversible. When persistence is enabled, maintain commit-before-publish behavior and report save failures accurately. QA invalidation must participate in undo/redo.
- Release event listeners, scheduler entries, GPU resources and decoded images on disposal. Late loads must not resurrect obsolete views or frames. A checked layer toggle is not evidence that points were rendered.
- The home page defaults to `/kitti-camera/manifest.json`; an explicit `?manifest=...` selects another dataset. The synthetic product demo has been removed. Never silently fall back to synthetic data on a real-data failure.
- Treat synthetic data as synthetic. Do not infer real alignment or production-scale performance from synthetic fixture tests or internally self-consistent transforms.

## Development and verification

Use pnpm 8.15.0 and the committed lockfile. Run Python through `uv run --project tools/py`; dependencies are defined by `pyproject.toml` and `uv.lock`. Development uses the core source alias in Vite, while `pnpm build` checks package outputs and types.

| Change | Relevant checks |
| --- | --- |
| Core behavior, persistence or math | `pnpm test`; meaningful regression tests in `packages/core/test` |
| UI interactions or rendering | `pnpm lint`, `pnpm build`, relevant Playwright tests and visual inspection |
| Import, geometry conversion or rasterization | `pnpm test:tools`; regenerate affected data and run independent real-data checks when available |
| Documentation | Check local links, file paths, commands and Mermaid syntax; do not run unrelated suites just for prose |

Browser tests run with `pnpm --filter @labelfaster/web-ui exec playwright test --workers=2` and own port 4173. Install Chromium with the corresponding Playwright command if needed. Tests can skip missing real assets; disclose skipped coverage. `pnpm verify:preflight` validates historical fixture schemas/checksums, not real recording alignment or full release readiness.

Prefer a regression that fails for the reported bug over a test that merely reproduces the implementation. Keep browser test probes read-only and confined to test mode. Update documentation when behavior or commands change.

## Repository hygiene

Do not commit dataset archives, raw scans/photos, generated PCD/LAS/Potree/BEV, virtual environments or browser test artifacts. Commit reusable tools, tests, lockfiles and small attributable references. Store generated datasets under the ignored `apps/web-ui/public/datasets/` directory or outside the checkout.

Do not add private machine paths, credentials or local-service assumptions to public documentation. Keep architecture diagrams tied to actual files. Remove replaced documentation and update its inbound links rather than maintaining contradictory versions. Keep future designs separate from implemented behavior, and do not invent license or attribution decisions.
