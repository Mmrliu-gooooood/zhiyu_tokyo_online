import { test, expect } from '../fixtures/base';
import en from '../../lib/i18n/locales/en-US.json';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/server-providers', (route) =>
    route.fulfill({
      json: { providers: {}, image: {}, video: {}, tts: {}, asr: {}, pdf: {}, webSearch: {} },
    }),
  );
  await page.addInitScript(
    ({ key, settings }) => {
      localStorage.setItem('locale', 'en-US');
      if (!localStorage.getItem(key)) localStorage.setItem(key, settings);
    },
    {
      key: SETTINGS_KV_KEY,
      settings: createSettingsStorage({ imageProviderId: '', videoProviderId: '' }),
    },
  );
  await page.goto(process.env.SETTINGS_TEST_PATH || '/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
});

for (const kind of ['image', 'video'] as const) {
  test(`${kind} custom platform can be configured, checked, selected and removed`, async ({
    page,
  }) => {
    const title = kind === 'image' ? en.settings.imageSettings : en.settings.videoSettings;
    const platform = `My ${kind} gateway`;
    const model = `vendor/${kind}-model:1`;
    const protocol = kind === 'image' ? 'siliconflow-images' : 'openrouter-video';
    await page
      .getByTestId('zhiyu-settings-nav')
      .getByRole('button', { name: title, exact: true })
      .click();
    await page.getByRole('button', { name: en.settings.addProvider, exact: true }).click();
    const add = page.getByRole('dialog', { name: en.settings.addCustomMediaProvider, exact: true });
    await add.getByLabel(en.settings.providerName, { exact: true }).fill(platform);
    await add.getByLabel(en.settings.mediaProtocol, { exact: true }).selectOption(protocol);
    await add.getByLabel('Base URL', { exact: true }).fill('https://gateway.example/api/v1');
    await add.getByRole('button', { name: en.settings.addProviderButton, exact: true }).click();
    await expect(add).toBeHidden();
    await expect(page.getByRole('heading', { name: platform, exact: true })).toBeVisible();
    await page.getByLabel('API Key', { exact: true }).fill('test-media-key');
    await page.getByRole('button', { name: en.settings.addNewModel, exact: true }).click();
    const modelDialog = page.getByRole('dialog', { name: en.settings.addNewModel, exact: true });
    await modelDialog.getByLabel(en.settings.modelId, { exact: true }).fill(model);
    await modelDialog.getByLabel(en.settings.modelName, { exact: true }).fill('My media model');
    await modelDialog.getByRole('button', { name: en.settings.saveModel, exact: true }).click();
    // A custom model is listed once, not once as built-in and again as custom.
    await expect(page.getByText(model, { exact: true })).toHaveCount(1);

    // Verify the actual UI request contract without a paid provider call.
    const requests: Record<string, unknown>[] = [];
    await page.route(`**/api/verify-${kind}-provider`, (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, verification: 'configuration' } });
    });
    await page
      .getByRole('button', { name: en.settings.checkMediaConfiguration, exact: true })
      .click();
    await expect(
      page.getByText(en.settings.mediaConfigurationChecked, { exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerConfig: {
        protocol,
        baseUrl: 'https://gateway.example/api/v1',
        requiresApiKey: true,
        apiKey: 'test-media-key',
      },
    });

    // Editing an address must not make the platform disappear while the field is empty.
    await page.getByLabel('Base URL', { exact: true }).fill('');
    await expect(page.getByRole('heading', { name: platform, exact: true })).toBeVisible();
    await page.getByLabel('Base URL', { exact: true }).fill('https://gateway.example/api/v1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByTestId('zhiyu-settings-nav')
      .getByRole('button', { name: title, exact: true })
      .click();
    await page.getByRole('button', { name: platform, exact: true }).click();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('test-media-key');
    await expect(page.getByLabel(en.settings.mediaProtocol, { exact: true })).toHaveValue(protocol);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('button:has(.lucide-sliders-horizontal)').first().click();
    await page
      .getByRole('button', { name: kind === 'image' ? 'Image' : 'Video', exact: true })
      .click();
    await page.getByRole('switch').check();
    await page.getByRole('combobox').click();
    await expect(page.getByRole('option', { name: /My media model/ })).toHaveCount(1);
    await page.getByRole('option', { name: /My media model/ }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByTestId('zhiyu-settings-nav')
      .getByRole('button', { name: title, exact: true })
      .click();
    await page.getByRole('button', { name: platform, exact: true }).click();
    await page.getByRole('button', { name: en.settings.deleteProvider, exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: en.settings.deleteProvider, exact: true })
      .click();
    await expect(page.getByRole('button', { name: platform, exact: true })).toHaveCount(0);
    await expect(page.getByText('settings.undefined', { exact: true })).toHaveCount(0);
  });

  test(`${kind} settings exposes adding a custom platform`, async ({ page }) => {
    await page
      .getByTestId('zhiyu-settings-nav')
      .getByRole('button', {
        name: kind === 'image' ? en.settings.imageSettings : en.settings.videoSettings,
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole('dialog', { name: 'Settings', exact: true })
        .getByRole('button', { name: en.settings.addProvider, exact: true }),
    ).toBeVisible();
  });

  test(`${kind} settings never renders an undefined title with no selected provider`, async ({
    page,
  }) => {
    await page
      .getByTestId('zhiyu-settings-nav')
      .getByRole('button', {
        name: kind === 'image' ? en.settings.imageSettings : en.settings.videoSettings,
        exact: true,
      })
      .click();
    await expect(page.getByText('settings.undefined', { exact: true })).toHaveCount(0);
  });
}
