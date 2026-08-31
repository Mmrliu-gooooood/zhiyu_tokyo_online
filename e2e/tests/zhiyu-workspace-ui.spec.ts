import { test, expect } from '../fixtures/base';

/**
 * This contract runs in the feature-enabled Workspace profile described by
 * the Surface Matrix. The ordinary profile intentionally redirects `/workspace`
 * to Home, so the release gate supplies the two workbench flags and DATABASE_URL.
 */
test.describe('ZHIYU workspace shell', () => {
  test('keeps the workspace regions and real navigation controls reachable', async ({ page }) => {
    await page.goto('/workspace');

    const shell = page.getByTestId('zhiyu-workspace-shell');
    await expect(shell).toBeVisible();
    await expect(page.getByTestId('zhiyu-workspace-rail')).toBeVisible();
    await expect(page.getByTestId('pro-workspace-home')).toBeVisible();
    await expect(page.getByTestId('pro-workspace-new-session')).toBeVisible();

    const collapse = page.getByTestId('pro-nav-collapse');
    await collapse.click();
    await expect(page.getByTestId('pro-nav-rail-mini')).toBeVisible();
    await page.getByTestId('pro-nav-expand').click();
    await expect(page.getByTestId('zhiyu-workspace-rail')).toBeVisible();
  });
});
