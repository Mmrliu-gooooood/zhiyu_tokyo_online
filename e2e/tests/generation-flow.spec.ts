import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';

const SETTINGS_STORAGE = createSettingsStorage();
const REVIEW_SETTINGS_STORAGE = createSettingsStorage({ reviewOutlineEnabled: true });
const WEB_SEARCH_SETTINGS_STORAGE = createSettingsStorage({
  webSearchProviderId: 'brave',
  webSearchProvidersConfig: { brave: {} },
});

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-test-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

const WEB_SEARCH_GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-web-search-fallback-session',
  requirements: {
    requirement: '讲解布迪厄的思想',
    language: 'zh-CN',
    webSearch: true,
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

const PERSISTED_REVIEW_SESSION = JSON.stringify({
  sessionId: 'e2e-review-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: mockOutlines,
  languageDirective: 'Use Chinese for the generated course.',
  currentStep: 'generating',
  previewPhase: 'review',
});

const PERSISTED_OUTLINE_READY_SESSION = JSON.stringify({
  sessionId: 'e2e-outline-ready-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: mockOutlines,
  languageDirective: 'Use Chinese for the generated course.',
  currentStep: 'generating',
  previewPhase: 'outline-ready',
});

async function seedGenerationSession(page: Page, settings: string, session: string): Promise<void> {
  await page.addInitScript(
    ({ seededSettings, seededSession }) => {
      localStorage.setItem('maic:account:settings-storage', seededSettings);
      sessionStorage.setItem('generationSession', seededSession);
    },
    { seededSettings: settings, seededSession: session },
  );
}

test.describe('Generation Flow', () => {
  test('completes generation pipeline and redirects to classroom', async ({ page, mockApi }) => {
    await seedGenerationSession(page, SETTINGS_STORAGE, GENERATION_SESSION);
    // Set up all API mocks
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // The ZHIYU shell is a projection over the existing generation flow.
    await expect(preview.stepTitle).toBeVisible();
    await expect(preview.shell).toBeVisible();
    await expect(preview.timeline).toBeVisible();
    await expect(preview.preview).toBeVisible();

    // Wait for auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('continues outline generation when optional web search is rate limited', async ({
    page,
    mockApi,
  }) => {
    await seedGenerationSession(
      page,
      WEB_SEARCH_SETTINGS_STORAGE,
      WEB_SEARCH_GENERATION_SESSION,
    );
    let webSearchRequests = 0;
    await page.route('**/api/web-search', (route) => {
      webSearchRequests += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Brave Search error (429): <!doctype html><html>challenge</html>',
        }),
      });
    });
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await expect.poll(() => webSearchRequests).toBe(1);
    await preview.waitForRedirectToClassroom();
    expect(webSearchRequests).toBe(1);
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('opens outline editor from preview review opportunity and resumes generation', async ({
    page,
    mockApi,
  }) => {
    await seedGenerationSession(page, SETTINGS_STORAGE, PERSISTED_OUTLINE_READY_SESSION);
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('persists always review preference from the outline editor', async ({ page, mockApi }) => {
    await seedGenerationSession(page, SETTINGS_STORAGE, PERSISTED_OUTLINE_READY_SESSION);
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await preview.enableAlwaysReview();

    // The persist write goes through the KVStore and is asynchronous, so poll
    // rather than reading once straight after the toggle.
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw).state.reviewOutlineEnabled : undefined;
        }, SETTINGS_KV_KEY),
      )
      .toBe(true);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });

  test('automatically opens outline editor when always review is enabled', async ({
    page,
    mockApi,
  }) => {
    await seedGenerationSession(page, REVIEW_SETTINGS_STORAGE, GENERATION_SESSION);

    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForEditor();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });
});

test('resumes generation from a persisted outline review session', async ({ page, mockApi }) => {
  await seedGenerationSession(page, SETTINGS_STORAGE, PERSISTED_REVIEW_SESSION);

  await mockApi.setupGenerationMocks();

  const preview = new GenerationPreviewPage(page);
  await preview.goto();

  await preview.waitForEditor();
  await preview.confirmOutlines();
  await preview.waitForRedirectToClassroom();
  expect(page.url()).toMatch(/\/classroom\//);
});
