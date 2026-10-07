import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./fixtures/editor/', import.meta.url));
export const editorManifest = JSON.parse(readFileSync(`${directory}manifest.json`, 'utf8'));
export const editorUrl = '/?manifest=/__editor_fixture__/manifest.json';

// Browser-context routing also covers reloads and the second-tab lock regression.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route(/^https?:\/\/[^/]+\/__editor_fixture__\/[^/?]+$/, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      const contentType = name.endsWith('.json') ? 'application/json' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      if (!['manifest.json', 'snapshot.json', 'frame.pcd', 'camera.png', 'height.png'].includes(name)) {
        await route.fulfill({ status: 404 }); return;
      }
      await route.fulfill({ contentType, body: readFileSync(`${directory}${name}`) });
    });
    await use(context);
  },
});
export { expect };
export async function selectFirstTrack(page: import('@playwright/test').Page) {
  const panel = page.getByRole('complementary', { name: '对象与属性' });
  const wasHidden = !await panel.isVisible();
  if (wasHidden) await page.getByRole('button', { name: '切换属性面板' }).click();
  await page.locator('.object-select').first().click();
  if (wasHidden) await page.getByRole('button', { name: '关闭属性面板' }).click();
}
