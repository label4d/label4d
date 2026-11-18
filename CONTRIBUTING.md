# Contributing

Start with the [README](README.md), [architecture](docs/architecture.md) and [data contracts](docs/data-formats.md). The runtime is a v1 local editor; planned v2 behavior is not an implementation contract. Agent-specific guidance is in [AGENTS.md](AGENTS.md).

## Develop locally

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Use Node.js 20+ and pnpm 8.15.0. For Python tools, install uv and use `uv run --project tools/py`; do not add a second dependency environment. Keep dependency and lockfile changes together.

Report bugs with the relevant commit, browser/OS, dataset sequence, frame, reproduction steps and expected/actual behavior. Screenshots help with projection or view problems. Use a small synthetic reproduction or explain how to obtain public source data; avoid uploading private datasets.

## Submit changes

- Keep changes focused. Describe the concrete behavior change and how it was verified.
- Route editor mutations through session/command APIs; use Python for offline numeric processing.
- Add meaningful regression coverage for data loss, frame races, coordinate errors and broken interactions.
- Update the appropriate current guide when formats, commands or user behavior change.
- Do not commit generated datasets, test screenshots, credentials or machine-specific configuration.

## Verify

```sh
pnpm lint
pnpm test
pnpm test:tools
pnpm build
pnpm --filter @label4d/web-ui exec playwright install chromium
pnpm --filter @label4d/web-ui exec playwright test --workers=2
```

Run checks relevant to the change and state which were run. Playwright owns port 4173. Real KITTI tests require locally generated assets; report skips instead of claiming real-data coverage. For dataset changes, follow the [tool guide](tools/README.md) and [KITTI verification guide](docs/real-camera-preview.md).

The old v2 fixture preflight checks schema and checksums only. It does not prove that a fixture is a valid v1 runtime input or that mixed recordings align.

## Release preparation

The project is licensed under the MIT License; the license text is in [LICENSE](LICENSE) and third-party and reference-data attribution is recorded in [NOTICE](NOTICE). Do not label the project production-ready or claim scale/performance beyond measured coverage. Current limits and planned extensions belong in the [roadmap](docs/roadmap.md).

Changes to the project license, to the NOTICE attribution, or to the security reporting channel are maintainer decisions: propose them as an issue before editing those files.
