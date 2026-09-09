import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';
import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';
import { ClassroomPage } from '../pages/classroom.page';
import { HomePage } from '../pages/home.page';

const CLIENT_EXCEPTION_COPY = /Application error: a client-side exception/i;

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.stack ?? `${error.name}: ${error.message}`);
  });
  return errors;
}

async function expectHealthyClient(page: Page, errors: string[]): Promise<void> {
  await expect(page.getByText(CLIENT_EXCEPTION_COPY)).toHaveCount(0);
  expect(errors.join('\n')).not.toMatch(/AsyncLocalStorage/i);
  expect(errors, `Unexpected client exceptions:\n${errors.join('\n\n')}`).toEqual([]);
}

test.describe('production client bootstrap', () => {
  test('clean browser context renders Home and opens image and video settings', async ({
    page,
  }) => {
    // This listener must be registered before the first navigation. The production
    // regression happened while evaluating a shared client chunk during page boot.
    const pageErrors = capturePageErrors(page);
    const home = new HomePage(page);

    await home.goto();

    await expect(home.logo).toBeVisible();
    await expect(home.createCard).toBeVisible();
    await expect(home.textarea).toBeEditable();
    await expect(home.enterButton).toBeDisabled();

    await page.getByRole('button', { name: /^(Settings|设置)$/i }).click();
    const settings = page.getByTestId('zhiyu-settings-shell');
    const settingsNav = page.getByTestId('zhiyu-settings-nav');
    await expect(settings).toBeVisible();

    const imageSettings = settingsNav.getByRole('button', {
      name: /^(Image Generation|图像生成)$/i,
    });
    const videoSettings = settingsNav.getByRole('button', {
      name: /^(Video Generation|视频生成)$/i,
    });
    await expect(imageSettings).toBeVisible();
    await expect(videoSettings).toBeVisible();

    await imageSettings.click();
    await expect(imageSettings).toHaveAttribute('aria-current', 'page');
    await videoSettings.click();
    await expect(videoSettings).toHaveAttribute('aria-current', 'page');

    await expectHealthyClient(page, pageErrors);
  });

  test('preserved settings keep the ordinary and Pro entry points interactive', async ({
    page,
  }) => {
    const pageErrors = capturePageErrors(page);
    const persistedSettings = createSettingsStorage({
      modelId: 'gpt-5.6',
      providerId: 'openai',
      providersConfig: { openai: { apiKey: 'existing-browser-setting' } },
    });
    await page.addInitScript(
      ({ key, settings }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, settings);
        localStorage.setItem('locale', 'en-US');
      },
      { key: SETTINGS_KV_KEY, settings: persistedSettings },
    );
    // Exercise the ordinary route transition without allowing a real model or
    // media request. The preview shell is sufficient for this bootstrap gate.
    await page.route('**/api/generate**', (route) => route.abort('blockedbyclient'));

    const home = new HomePage(page);
    await home.goto();
    await expect(home.createCard).toBeVisible();

    await home.fillRequirement('Explain how photosynthesis stores energy.');
    await expect(home.enterButton).toBeEnabled();
    await home.submit();
    await page.waitForURL(/\/generation-preview(?:\?|$)/);
    await expect(page.getByTestId('zhiyu-generation-shell')).toBeVisible();

    await page.goto('/');
    await expect(home.createCard).toBeVisible();
    const proEntry = page.getByTestId('pro-mode-enter');
    await expect(proEntry).toBeVisible();
    await proEntry.click();
    await page.waitForURL(/\/workspace(?:\?|$)/);
    await expect(page.getByTestId('zhiyu-workspace-shell')).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const state = JSON.parse(raw).state;
          return { providerId: state.providerId, modelId: state.modelId };
        }, SETTINGS_KV_KEY),
      )
      .toEqual({ providerId: 'openai', modelId: 'gpt-5.6' });
    await expectHealthyClient(page, pageErrors);
  });

  test('existing classroom loads the video-render client graph without exporting', async ({
    page,
  }) => {
    const pageErrors = capturePageErrors(page);

    // HeaderControls imports the global video-render store regardless of whether
    // the experimental Export Video affordance is enabled in this image. Reaching
    // its ordinary export control therefore guards the direct runPolledTask import
    // path without starting a paid render or media-provider request.
    await seedClassroomDatabase(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Export PPTX|导出 PPTX)$/i })).toBeVisible();
    await expectHealthyClient(page, pageErrors);
  });
});
