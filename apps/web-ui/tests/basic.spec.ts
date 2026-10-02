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

    await page.goto('/', { waitUntil: 'networkidle' });

    await expect(page.getByText('Labelfaster 4D', { exact: true })).toHaveCount(1);
    const canvasLocator = page.locator('canvas');
    await expect(canvasLocator).toHaveCount(7);

    await expect(page.getByRole('status', { name: '本地保存状态' })).toContainText('已保存');
    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});
