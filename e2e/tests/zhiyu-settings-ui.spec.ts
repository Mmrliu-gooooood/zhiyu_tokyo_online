import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (settings) => {
      if (!localStorage.getItem('maic:account:settings-storage')) {
        localStorage.setItem('maic:account:settings-storage', settings);
      }
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({
      providersConfig: {
        openai: { apiKey: '' },
      },
    }),
  );
});

test.describe('ZHIYU settings information architecture', () => {
  test('keeps the structural regions and non-secret provider preference persistence', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();

    await expect(page.getByTestId('zhiyu-settings-shell')).toBeVisible();
    await expect(page.getByTestId('zhiyu-settings-nav')).toBeVisible();
    await expect(page.getByTestId('zhiyu-settings-content')).toBeVisible();

    // `requiresApiKey` is a provider capability preference, not a credential.
    // Toggling it exercises the existing Settings store without placing a key
    // in the fixture or sending one to a test endpoint.
    const requiresKey = page.getByRole('checkbox', { name: /requires api key/i });
    await expect(requiresKey).toBeChecked();
    await requiresKey.click();
    await expect(requiresKey).not.toBeChecked();

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('maic:account:settings-storage');
          return raw ? JSON.parse(raw)?.state?.providersConfig?.openai?.requiresApiKey : undefined;
        }),
      )
      .toBe(false);

    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('checkbox', { name: /requires api key/i })).not.toBeChecked();
  });
});
