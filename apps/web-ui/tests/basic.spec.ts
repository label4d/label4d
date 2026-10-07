import { test, expect } from '@playwright/test';

test.describe('Labelfaster App', () => {
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

    await page.goto('/?demo=1', { waitUntil: 'networkidle' });

    await expect(page.getByText('Labelfaster 4D', { exact: true })).toHaveCount(1);
    const canvasLocator = page.locator('canvas');
    await expect(canvasLocator).toHaveCount(7);

    await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});

// A clean checkout must never silently replace missing real data with synthetic data.
test('missing default dataset explains the failure and offers an explicit demo', async ({ page }) => {
  await page.route('**/kitti-camera/manifest.json', (route) => route.fulfill({
    status: 404, contentType: 'text/plain', body: 'Not found',
  }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('数据加载失败');
  await expect(page.getByRole('alert')).toContainText('/kitti-camera/manifest.json');
  await expect(page.getByRole('link', { name: '打开合成演示' })).toHaveAttribute('href', '/?demo=1');
  await expect(page.locator('.camera-demo-label')).toHaveCount(0);
  await page.getByRole('link', { name: '打开合成演示' }).click();
  await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
  await expect(page.locator('.camera-demo-label').first()).toBeVisible();
});
