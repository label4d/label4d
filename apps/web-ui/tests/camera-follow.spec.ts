import { test, expect } from '@playwright/test';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const realManifest = fileURLToPath(new URL('../public/kitti-camera/manifest.json', import.meta.url));

for (const dataset of ['demo', 'kitti']) {
test(`${dataset}: 3D follow keeps the camera rigidly attached during playback, seek and user orbit`, async ({ page }) => {
  test.skip(dataset === 'kitti' && !existsSync(realManifest), 'Generate the official camera preview first');
  await page.goto(dataset === 'demo' ? '/' : '/?manifest=/kitti-camera/manifest.json');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
  const view = page.getByTestId('cloud-view');
  const manifest = dataset === 'kitti' ? JSON.parse(readFileSync(realManifest, 'utf8')) : await page.evaluate(async () => {
    const { buildDemoManifest } = await import('/src/lib/demo.ts');
    return buildDemoManifest();
  });
  const relative = async () => {
    const state = JSON.parse((await view.getAttribute('data-camera'))!);
    const pose = new Matrix4().fromArray(manifest.egoPoses[state.frame]);
    const local = pose.clone().invert().multiply(new Matrix4().compose(new Vector3().fromArray(state.position), new Quaternion().fromArray(state.quaternion), new Vector3(1, 1, 1)));
    return { frame: state.frame, matrix: local.elements, target: new Vector3().fromArray(state.target).applyMatrix4(pose.invert()).toArray() };
  };
  const sameOffset = (a: Awaited<ReturnType<typeof relative>>, b: Awaited<ReturnType<typeof relative>>) => {
    a.matrix.forEach((value, i) => expect(value).toBeCloseTo(b.matrix[i], 6));
    a.target.forEach((value, i) => expect(value).toBeCloseTo(b.target[i], 6));
  };
  await page.getByText('点云显示', { exact: true }).click();
  await expect(page.getByLabel('跟随自车', { exact: true })).toBeChecked();
  const initial = await relative();
  await page.getByText('点云显示', { exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await relative()).frame).toBeGreaterThan(5);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  sameOffset(initial, await relative());
  await page.getByLabel('跳转到帧', { exact: true }).fill(String(Math.floor(manifest.frameCount / 2)));
  await page.getByLabel('跳转到帧', { exact: true }).press('Enter');
  await expect.poll(async () => (await relative()).frame).toBe(Math.floor(manifest.frameCount / 2));
  sameOffset(initial, await relative());
  const rect = (await view.locator('canvas').boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height * .6);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(rect.x + rect.width * .65 + 30, rect.y + rect.height * .6, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const adjusted = await relative();
  expect(adjusted.matrix).not.toEqual(initial.matrix);
  await page.getByLabel('跳转到帧', { exact: true }).fill(String(manifest.frameCount - 1));
  await page.getByLabel('跳转到帧', { exact: true }).press('Enter');
  await expect.poll(async () => (await relative()).frame).toBe(manifest.frameCount - 1);
  sameOffset(adjusted, await relative());
  await page.screenshot({ path: `test-results/camera-follow-${dataset}.png` });
});
}
