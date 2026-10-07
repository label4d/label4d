# Editor contract test inputs

Small synthetic **test-only** v1 manifest and snapshot, four ground points, a placeholder camera PNG and a zero-height raster. They are not a dataset demo or alignment reference. Track/geometry cases retain existing UI regression scenarios; poses vary over 300 frames to check rigid camera follow.

Playwright serves these files using request routes under `/__editor_fixture__/`. They are outside `src` and `public` and are never bundled or offered by the application. No browser-side generator or special URL protocol is required. Real KITTI tests remain separate.
