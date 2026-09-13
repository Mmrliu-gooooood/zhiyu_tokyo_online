import { test, expect } from '../fixtures/base';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';

test('shows a rejected model preflight and cancels back to Home before submitting a job', async ({
  page,
  mockApi,
}) => {
  // Activate the shared fixture, then retain the actual Docker capabilities and
  // owner-session endpoint. Only the model snapshot preflight is rejected.
  void mockApi;
  await page.unroute('**/api/server-providers');
  const capabilityResponse = await page.request.get('/api/server-providers');
  expect(capabilityResponse.ok()).toBe(true);
  expect((await capabilityResponse.json()).generation?.background?.enabled).toBe(true);

  const errorCode = 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE';
  const submittedJobs: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/generate-classroom'
    ) {
      submittedJobs.push(request.url());
    }
  });
  let rejectedSnapshots = 0;
  await page.route('**/api/generate-classroom/model-snapshots', async (route) => {
    rejectedSnapshots += 1;
    await route.fulfill({ status: 422, json: { error: errorCode } });
  });

  await page.addInitScript(
    ({ settingsKey, settings, session }) => {
      localStorage.setItem(settingsKey, settings);
      sessionStorage.setItem('generationSession', session);
    },
    {
      settingsKey: SETTINGS_KV_KEY,
      settings: createSettingsStorage(),
      session: JSON.stringify({
        sessionId: `submission-failure-e2e-${Date.now()}`,
        requirements: { requirement: 'Model preflight UI regression', webSearch: false },
        pdfText: '',
        currentStep: 'generating',
        previewPhase: 'preparing',
      }),
    },
  );

  await page.goto('/generation-preview');
  const shell = page.getByTestId('zhiyu-generation-shell');
  await expect(shell).toBeVisible();
  await expect(shell.getByRole('heading', { level: 1 })).toHaveText(/Generation failed|生成失败/i);
  await expect(page.getByTestId('zhiyu-generation-preview')).toContainText(errorCode);
  await expect(shell).not.toContainText(/正在准备课程生成任务|Preparing the course generation/i);
  expect(rejectedSnapshots).toBe(1);
  expect(submittedJobs).toEqual([]);

  await shell.getByRole('button', { name: /Back to Home|返回首页/i, exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: /Cancel generation and return|取消生成并返回/i })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('zhiyu-generation-shell')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('generationSession'))).toBeNull();
  expect(submittedJobs).toEqual([]);
});
