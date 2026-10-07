import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../public/kitti-camera/', import.meta.url));

test('real BEV loads the aligned map, selects in screen space and follows presented lidar frames', async ({ page }) => {
  test.skip(!existsSync(`${output}/bev/map.png`), 'Run pnpm fixtures:camera-preview');
  const manifest = JSON.parse(readFileSync(`${output}/manifest.json`, 'utf8'));
  const snapshot = JSON.parse(readFileSync(`${output}/snapshot.json`, 'utf8'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?manifest=/kitti-camera/manifest.json');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
  const map = page.waitForResponse((r) => r.url().endsWith('/kitti-camera/bev/map.png'));
  await page.getByRole('button', { name: 'BEV 俯视模式', exact: true }).click();
  expect((await map).status()).toBe(200);
  await expect(page.getByRole('status', { name: 'BEV 底图状态' })).toHaveText('底图已加载');
  const view = page.getByTestId('bev-view');
  await expect(view).toHaveAttribute('data-cloud-frame', '0');
  await expect.poll(async () => Number(await view.getAttribute('data-cloud-points'))).toBeGreaterThan(100_000);

  // Select the car at its rendered screen position, off the view's horizontal centerline.
  const rect = (await view.locator('canvas').boundingBox())!;
  const [cx, cz, half] = (await view.getAttribute('data-bev'))!.split(',').map(Number);
  const pos = snapshot.tracks.find((t: { meta: { id: string } }) => t.meta.id === 'kitti_00000').keyframes.pos;
  const scale = rect.height / (2 * half);
  const x = rect.x + rect.width / 2 + (pos[0] - cx) * scale;
  const y = rect.y + rect.height / 2 + (pos[2] - cz) * scale;
  await page.keyboard.down('Shift');
  await page.mouse.move(x + 10, y + 10); await page.mouse.down();
  await page.mouse.move(x - 10, y - 10, { steps: 5 }); await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.object-select').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');

  for (const frame of [12, 100]) {
    await page.getByLabel('跳转到帧', { exact: true }).fill(String(frame));
    await page.getByLabel('跳转到帧', { exact: true }).press('Enter');
    await expect(view).toHaveAttribute('data-cloud-frame', String(frame));
    await expect.poll(async () => Number(await view.getAttribute('data-cloud-points'))).toBeGreaterThan(100_000);
    const [vx, vz] = (await view.getAttribute('data-bev'))!.split(',').map(Number);
    expect(Math.abs(vx - manifest.egoPoses[frame][12])).toBeLessThan(.1);
    expect(Math.abs(vz - manifest.egoPoses[frame][14])).toBeLessThan(.1);
    await page.screenshot({ path: `test-results/real-bev-frame${frame}.png` });
  }
  await page.getByLabel('当前帧点云', { exact: true }).uncheck();
  await expect(page.getByLabel('当前帧点云', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '4D 点云模式', exact: true }).click();
  await page.getByRole('button', { name: 'BEV 俯视模式', exact: true }).click();
  await expect(page.getByRole('status', { name: 'BEV 底图状态' })).toHaveText('底图已加载');
  expect(errors).toEqual([]);
});
