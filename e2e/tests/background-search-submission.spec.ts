import { test, expect } from '@playwright/test';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';

// Production browser regression: keep background capability enabled and exercise
// the real client submission code. External generation is replaced at the job
// transport boundary; worker execution is covered by the server integration tests.
for (const mode of ['brave', 'tavily', 'no-search'] as const) {
  const providerId = mode === 'no-search' ? 'brave' : mode;
  const webSearch = mode !== 'no-search';
  test(`ordinary background generation submits ${mode} and reaches outline review`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const searchRef = { id: '123e4567-e89b-42d3-a456-426614174088', revision: 1 };
    const modelRef = { id: '123e4567-e89b-42d3-a456-426614174099', revision: 1 };
    const snapshots: Record<string, unknown>[] = [];
    const submissions: Record<string, unknown>[] = [];
    const job = {
      jobId: 'e2e-background-search',
      stageId: 'e2e-background-search-stage',
      status: 'awaiting_confirmation',
      phase: 'outlines',
      stateVersion: 2,
      runNo: 1,
      planRevision: 1,
      readyScenes: 0,
      totalScenes: mockOutlines.length,
      warningCount: 0,
      lastErrorCode: null,
      reviewHold: true,
      autoContinueAt: null,
      pollUrl: '/api/generate-classroom/e2e-background-search',
      courseUrl: '/classroom/e2e-background-search-stage',
      pollIntervalMs: 1000,
      outlines: mockOutlines,
    };
    await page.addInitScript(
      ({ key, settings, session }) => {
        localStorage.setItem(key, settings);
        localStorage.setItem('locale', 'en-US');
        sessionStorage.setItem('generationSession', JSON.stringify(session));
      },
      {
        key: SETTINGS_KV_KEY,
        settings: createSettingsStorage({
          reviewOutlineEnabled: true,
          imageGenerationEnabled: false,
          videoGenerationEnabled: false,
          webSearchProviderId: providerId,
          webSearchProvidersConfig: {
            [providerId]: {
              enabled: true,
              apiKey: providerId === 'tavily' ? 'e2e-search-secret' : '',
              baseUrl: providerId === 'brave' ? 'https://search.brave.com' : '',
            },
          },
        }),
        session: {
          sessionId: `e2e-${providerId}`,
          requirements: {
            requirement: '讲解布迪厄的思想',
            language: 'zh-CN',
            webSearch,
          },
          pdfText: '',
          currentStep: 'generating',
        },
      },
    );
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        json: {
          providers: {},
          webSearch: {},
          generation: { background: { enabled: true, available: true, pipelineVersion: '1' } },
        },
      }),
    );
    await page.route('**/api/agent/media-config-snapshots', (route) =>
      route.fulfill({ json: { ref: modelRef } }),
    );
    await page.route('**/api/generate-classroom**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/search-snapshots')) {
        snapshots.push(request.postDataJSON());
        return route.fulfill({ json: { ref: searchRef } });
      }
      if (path.endsWith('/model-snapshots')) return route.fulfill({ json: { ref: modelRef } });
      if (path === '/api/generate-classroom' && request.method() === 'POST') {
        submissions.push(request.postDataJSON());
        return route.fulfill({ status: 202, json: job });
      }
      return route.fulfill({ json: path === '/api/generate-classroom' ? { jobs: [] } : job });
    });
    await page.goto('/generation-preview');
    await expect.poll(() => submissions.length, { timeout: 15000 }).toBe(1);
    expect(snapshots).toHaveLength(webSearch ? 1 : 0);
    if (webSearch) expect(snapshots[0]).toMatchObject({ providerId });
    expect(submissions[0]).toMatchObject({
      enableWebSearch: webSearch,
      modelConfigRef: modelRef,
    });
    expect(submissions[0].searchConfigRef).toEqual(webSearch ? searchRef : undefined);
    expect(JSON.stringify(submissions[0])).not.toContain('e2e-search-secret');
    await expect(page.getByText(mockOutlines[0].title).first()).toBeVisible();
    await expect(page.getByText('BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
