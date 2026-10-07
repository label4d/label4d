import { test, expect, editorUrl, selectFirstTrack } from './editorFixture';

const ready = async (page: import('@playwright/test').Page) => {
  await page.goto(editorUrl); await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
  await selectFirstTrack(page);
};

test('frame entry, keyframe jumps and Escape use the selected track without unintended edits', async ({ page }) => {
  await ready(page);
  const jump = page.getByRole('button', { name: /^跳转到关键帧 / }).nth(1);
  const target = (await jump.innerText()).trim(); await jump.click();
  await expect(page.getByLabel('跳转到帧', { exact: true })).toHaveValue(target);
  const frame = page.getByLabel('跳转到帧', { exact: true });
  await frame.fill('125'); await frame.press('Escape'); await expect(frame).toHaveValue(target);
  await frame.fill('37'); await frame.press('Enter'); await expect(frame).toHaveValue('37');
  await page.keyboard.press(']'); await expect(frame).toHaveValue('38');
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
});

test('search, geometry filtering and Shift selection expose real editing actions', async ({ page }) => {
  await ready(page);
  const search = page.getByLabel('搜索对象'); await search.fill('0003');
  await expect(page.locator('.object-select')).toHaveCount(1);
  await expect(page.locator('.object-select')).toContainText('#0003');
  await search.fill(''); await page.getByRole('button', { name: '几何', exact: true }).click();
  await expect(page.locator('.object-select')).toHaveCount(2);
  await page.locator('.object-select').first().click();
  await expect(page.getByRole('button', { name: '编辑顶点 5' })).toBeVisible();
  await page.getByRole('button', { name: '轨迹', exact: true }).click();
  await page.locator('.object-select').first().click(); await page.locator('.object-select').nth(1).click({ modifiers: ['Shift'] });
  await expect(page.getByText('已选择 2 个对象')).toBeVisible();
  await expect(page.getByRole('button', { name: '删除选中对象', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '收起对象列表' }).click();
  await expect(search).toBeHidden(); await page.getByRole('button', { name: '展开对象列表' }).click(); await expect(search).toBeVisible();
});

test('focus, resizing and keyboard help preserve the annotation document and layout preferences', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '专注主视图', exact: true }).click();
  await expect(page.getByRole('region', { name: '相机视图', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '退出专注视图' }).click();
  await expect(page.getByRole('region', { name: '相机视图', exact: true })).toBeVisible();
  const handle = page.getByRole('separator', { name: '调整属性面板宽度' });
  await handle.focus(); await handle.press('ArrowLeft'); await expect(handle).toHaveAttribute('aria-valuenow', '324');
  await page.getByRole('button', { name: '快捷键帮助' }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeHidden();
  await page.reload(); await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
  await expect(page.getByRole('separator', { name: '调整属性面板宽度' })).toHaveAttribute('aria-valuenow', '324');
  const camera = page.getByRole('separator', { name: '调整相机区域高度' }); const box = (await camera.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 35); await page.mouse.up();
  expect(Number(await camera.getAttribute('aria-valuenow'))).toBeGreaterThan(158);
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存 r0');
});

test('small screens keep navigation, frame controls and the property drawer usable', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  await expect(page.getByRole('complementary', { name: '对象与属性' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'BEV 俯视模式' })).toBeVisible();
  await page.getByRole('button', { name: '切换属性面板' }).click();
  await expect(page.getByLabel('x', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭属性面板' }).click();
  await expect(page.getByLabel('跳转到帧', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
