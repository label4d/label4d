import { test, expect, editorUrl } from './editorFixture';

test.describe('Label4D App', () => {
  test('loads without runtime errors and renders viewports', async ({ page }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    page.on('pageerror', (error) => {
      pageErrors.push(error);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(editorUrl, { waitUntil: 'networkidle' });

    await expect(page.getByText('Label4D', { exact: true })).toHaveCount(1);
    const canvasLocator = page.locator('canvas');
    await expect(canvasLocator).toHaveCount(7);

    await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});

// A clean checkout must never silently replace missing real data with synthetic data.
test('missing default dataset reports failure without a synthetic fallback', async ({ page }) => {
  await page.route('**/kitti-camera/manifest.json', (route) => route.fulfill({
    status: 404, contentType: 'text/plain', body: 'Not found',
  }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('数据加载失败');
  await expect(page.getByRole('alert')).toContainText('/kitti-camera/manifest.json');
  await expect(page.getByRole('link', { name: '打开合成演示' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
});
