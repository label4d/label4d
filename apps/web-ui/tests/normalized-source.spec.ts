import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const size of [20, 198]) test(`Waymo ${size} frames: source browsing, cameras, full poses, seeking and playback`, async ({ page }) => {
  test.setTimeout(120_000);
  const root = fileURLToPath(new URL(`../public/datasets/waymo-normalized-${size}/`, import.meta.url));
  test.skip(!existsSync(root + 'sequence.json'), 'Generate normalized real Waymo assets first');
  const sequence = JSON.parse(readFileSync(root + 'sequence.json', 'utf8'));
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
  const read = () => page.evaluate(async () => (window as any).__LABELFASTER_TEST__.read());
  const tree = sequence.potree ? page.waitForResponse((r) => r.url().endsWith(`/waymo-normalized-${size}/potree/octree.bin`) && r.status() === 206) : null;
  await page.goto(`/?manifest=/datasets/waymo-normalized-${size}/sequence.json`);
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('只读浏览', { timeout: 60000 });
  await expect.poll(async () => (await read()).frame.status, { timeout: 60000 }).toBe('ready');
  await expect(page.getByLabel('选择相机 1')).toHaveValue('camera-1');
  await expect(page.getByRole('button', { name: '3D框', exact: true })).toBeDisabled();
  await page.getByText('点云显示', { exact: true }).click();
  const potree = page.getByRole('checkbox', { name: '静态点云(Potree)' });
  if (tree) {
    expect((await tree).status()).toBe(206);
    await expect(potree).toBeEnabled();
    await expect(page.getByRole('status', { name: 'Potree 加载状态' })).toContainText('Potree 已显示', { timeout: 30000 });
    await potree.uncheck();
    await expect(page.getByRole('status', { name: 'Potree 加载状态' })).toHaveText('Potree 已关闭');
    await potree.check();
    await expect(page.getByRole('status', { name: 'Potree 加载状态' })).toContainText('Potree 已显示', { timeout: 30000 });
  } else await expect(potree).toBeDisabled();
  await page.getByText('点云显示', { exact: true }).click();
  const sampleFrames = [0, Math.floor(size/2), size-1];
  for (const frame of sampleFrames) {
    if (frame) { await page.getByLabel('跳转到帧', { exact: true }).fill(String(frame)); await page.getByLabel('跳转到帧', { exact: true }).press('Enter'); }
    await expect.poll(async () => (await read()).frame, { timeout: 30000 }).toEqual({ requested: frame, presented: frame, status: 'ready' });
    const source = JSON.parse(readFileSync(root + `frames/${frame}.json`, 'utf8'));
    const actual = await read();
    expect(actual.dataset.cloudCount).toBe(source.pointCloud.pointCount); expect(actual.dataset.referenceCount).toBe(source.pointCloud.pointCount * 6);
    expect(actual.dataset.time).toBe(source.timeMicros/1e6); expect(actual.dataset.active.sort()).toEqual(source.boxObservations.map((b: any) => b.objectId).sort());
    expect(actual.dataset.cameras).toHaveLength(5); expect(actual.dataset.cameras.every((a: any) => a.image)).toBe(true);
    for (const camera of actual.dataset.cameras) expect(camera.poseTime).toBe(source.samples.find((s: any) => s.sensorId === camera.id).poseTimeMicros/1e6);
    const id = source.boxObservations[0].objectId;
    const resolved = await page.evaluate(async (objectId) => (window as any).__LABELFASTER_TEST__.read({ objectIds: [objectId] }), id);
    expect(resolved.dataset.states[0].boxToWorld).toEqual(source.boxObservations[0].boxToWorld);
    await expect(page.locator('.camera-empty')).toHaveCount(0);
    await page.screenshot({ path: `test-results/waymo-${size}-frame${frame}.png` });
  }
  await page.getByRole('button', {name:'BEV 俯视模式',exact:true}).click();
  await expect(page.getByRole('status', {name:'BEV 底图状态'})).toHaveText('底图已加载');
  const bev = page.getByTestId('bev-view');
  await expect(bev).toHaveAttribute('data-cloud-frame', String(size-1));
  const rect = (await bev.boundingBox())!;
  const [cx,cz,half] = (await bev.getAttribute('data-bev'))!.split(',').map(Number);
  const last = JSON.parse(readFileSync(root+`frames/${size-1}.json`,'utf8'));
  const visible = last.boxObservations.map((b: any) => ({id:b.objectId,x:rect.x+rect.width/2+(b.boxToWorld[12]-cx)*rect.height/(2*half), y:rect.y+rect.height/2+(b.boxToWorld[14]-cz)*rect.height/(2*half)})).filter((b: any)=>b.x>rect.x+20 && b.x<rect.x+rect.width-20 && b.y>rect.y+50 && b.y<rect.y+rect.height-20);
  expect(visible.length).toBeGreaterThan(0);
  await page.mouse.click(visible[0].x,visible[0].y);
  await expect.poll(async()=> (await read()).interaction.selection.length).toBe(1);
  await expect(page.getByLabel('源框旋转矩阵')).toBeVisible();
  await page.screenshot({path:`test-results/waymo-${size}-bev.png`});
  await page.getByRole('button', {name:'4D 点云模式',exact:true}).click();
  await page.locator('.object-select').first().click();
  await expect(page.getByLabel('源框旋转矩阵')).toBeVisible();
  await expect(page.getByRole('button',{name:'上一个观测帧'})).toBeEnabled();
  for (const camera of sequence.sensors.filter((s: any) => s.kind === 'camera')) {
    await page.getByLabel('选择相机 5').selectOption(camera.id);
    await page.getByLabel('点云投影', { exact: true }).last().check();
    await expect.poll(async () => page.evaluate(() => {
      const view = (window as any).__lfCam;
      return view?.group.children.find((a: any) => a.isPoints)?.geometry.getAttribute('position').count ?? 0;
    })).toBeGreaterThan(0);
    // Verify actual rendered pixels against bound official reference triples, not static reprojection.
    const pixels = await page.evaluate(() => {
      const session = (window as any).__lf, view = (window as any).__lfCam;
      const positions = view.group.children.find((a: any) => a.isPoints).geometry.getAttribute('position').array;
      const refs = session.currentPointCloud().cameraReferences, id = view.projector.sourceCameraId, height = view.projector.config.height;
      const reference = new Set<string>(); for (let i=0;i<refs.length;i+=3) if (refs[i]===id) reference.add(`${refs[i+1]},${height-refs[i+2]}`);
      let matching=0; for(let i=0;i<positions.length;i+=3) if(reference.has(`${positions[i]},${positions[i+1]}`)) matching++;
      return { matching, rendered: positions.length/3 };
    });
    expect(pixels.matching).toBe(pixels.rendered);
  }
  await page.getByLabel('跳转到帧', { exact: true }).fill('0'); await page.getByLabel('跳转到帧', { exact: true }).press('Enter');
  await expect.poll(async () => (await read()).frame.presented).toBe(0);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await read()).frame.presented).toBeGreaterThan(2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '专注主视图', exact: true }).click();
  await page.getByRole('button', { name: '退出专注视图', exact: true }).click();
  await expect(page.locator('.camera-empty')).toHaveCount(0);
  expect((await read()).dataset.readOnly).toBe(true);expect(errors).toEqual([]);
});
