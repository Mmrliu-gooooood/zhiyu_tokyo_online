import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'zhiyu-generation-shell',
  requirements: { requirement: '讲解光合作用' },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

test('uses the ZHIYU course-construction shell', async ({ page, mockApi }) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: createSettingsStorage(), session: GENERATION_SESSION },
  );
  await mockApi.setupGenerationMocks();

  // Keep the page in its generating state until the shell contract has been
  // observed. The default SSE mock completes synchronously, so without this
  // gate a fast browser can reach the classroom before the active step is read.
  let releaseOutlines!: () => void;
  const outlinesGate = new Promise<void>((resolve) => {
    releaseOutlines = resolve;
  });
  await page.route('**/api/generate/scene-outlines-stream', async (route) => {
    await outlinesGate;
    await route.fallback();
  });

  const generation = new GenerationPreviewPage(page);
  try {
    await generation.goto();

    await expect(generation.shell).toBeVisible();
    await expect(generation.timeline).toBeVisible();
    await expect(generation.preview).toBeVisible();
    await expect(generation.timeline.locator('[data-status="active"]')).toHaveCount(1);
  } finally {
    releaseOutlines();
  }
  await generation.waitForRedirectToClassroom();
});
