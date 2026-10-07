import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function read(page: Page) {
  return page.evaluate(async () => {
    const probe = (window as unknown as { __LABELFASTER_TEST__: { read(): Promise<{
      frame: { requested: number; presented: number; status: string };
      document: { tracks: Array<{ keyframes: { frames: number[]; pos: number[] } }>; trackCount: number };
      persistence: { status: string; savedRevision: number };
      interaction: { gesture: string; canUndo: boolean; canRedo: boolean };
    }> } }).__LABELFASTER_TEST__;
    return probe.read();
  });
}

test('precise edit, save, undo, reload and redo use the production UI', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/?demo=1');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
  const x = page.getByLabel('x', { exact: true });
  const original = await x.inputValue();
  await x.fill('18'); await x.press('Tab');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r1');
  expect((await read(page)).document.tracks[0].keyframes.pos[0]).toBe(18);
  await page.getByRole('button', { name: '↩ 撤销', exact: true }).click();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r2');
  await expect(x).toHaveValue(original);
  await page.reload();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r2');
  await expect(page.getByLabel('x', { exact: true })).toHaveValue(original);
  await page.getByRole('button', { name: '↪ 重做', exact: true }).click();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r3');
  await expect(page.getByLabel('x', { exact: true })).toHaveValue('18.00');
  expect(errors).toEqual([]);
});

test('a second tab cannot write the same document', async ({ context, page }) => {
  await page.goto('/?demo=1'); await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
  const other = await context.newPage(); await other.goto('/?demo=1');
  await expect(other.getByRole('alert')).toContainText('another tab');
  await expect(other.getByLabel('x', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('x', { exact: true })).toBeEnabled();
  await other.close();
});

test('BEV drawing on empty ground commits once, and Escape cancels the next gesture', async ({ page }) => {
  await page.goto('/?demo=1'); await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
  await page.getByRole('button', { name: 'BEV 俯视模式', exact: true }).click();
  await page.getByRole('button', { name: '3D框', exact: true }).click();
  const canvas = page.locator('canvas').first(); const rect = (await canvas.boundingBox())!;
  const x = rect.x + rect.width * 0.3, y = rect.y + rect.height * 0.3;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 50, y, { steps: 5 }); await page.mouse.up();
  await page.mouse.move(x + 50, y); await page.mouse.down(); await page.mouse.move(x + 50, y + 20, { steps: 5 }); await page.mouse.up();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r1');
  expect((await read(page)).document.trackCount).toBe(4);
  await page.mouse.move(x, y + 80); await page.mouse.down(); await page.mouse.move(x + 50, y + 80, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect((await read(page)).interaction.gesture).toBe('idle');
  expect((await read(page)).persistence.savedRevision).toBe(1);
  await page.getByRole('button', { name: '↩ 撤销', exact: true }).click();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r2');
  expect((await read(page)).document.trackCount).toBe(3);
});
