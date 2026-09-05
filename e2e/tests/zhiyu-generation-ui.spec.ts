import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';

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

test('activates teaching actions while its first scene request is pending', async ({
  page,
  mockApi,
}) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: createSettingsStorage(), session: GENERATION_SESSION },
  );
  await mockApi.setupGenerationMocks();
  let releaseActions!: () => void;
  const actionsGate = new Promise<void>((resolve) => {
    releaseActions = resolve;
  });
  await page.route('**/api/generate/scene-actions', async (route) => {
    await actionsGate;
    await route.fallback();
  });

  const generation = new GenerationPreviewPage(page);
  try {
    await generation.goto();
    await expect(generation.stepTitle).toHaveText(/Generating Teaching Actions|生成教学动作/);
    const steps = generation.timeline.locator('li');
    await expect(steps.nth(3)).toHaveAttribute('data-status', 'done');
    await expect(steps.nth(4)).toHaveAttribute('data-status', 'active');
    await expect(generation.timeline.locator('[aria-current="step"]')).toHaveCount(1);
  } finally {
    releaseActions();
  }
  await generation.waitForRedirectToClassroom();
});

for (const stage of ['agents', 'content'] as const) {
  test(`cycles every topic card while generating ${stage}`, async ({ page, mockApi }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('maic:account:settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      {
        settings: createSettingsStorage({ agentMode: stage === 'agents' ? 'auto' : 'preset' }),
        session: GENERATION_SESSION,
      },
    );
    await mockApi.setupGenerationMocks();
    await mockApi.mockSceneOutlinesStream(
      Array.from({ length: 10 }, (_, index) => ({
        ...mockOutlines[0],
        id: `topic-${index + 1}`,
        title: `Topic ${index + 1}`,
        order: index,
      })),
    );
    const endpoint = stage === 'agents' ? 'agent-profiles' : 'scene-content';
    await page.route(`**/api/generate/${endpoint}`, () => {});
    const generation = new GenerationPreviewPage(page);
    await generation.goto();
    await expect(generation.stepTitle).toHaveText(
      stage === 'agents'
        ? /Generating Classroom Roles|生成课堂角色/
        : /Generating Page Content|生成页面内容/,
    );
    // Keep native animation time: Motion also uses the browser's document
    // timeline, which Playwright's fake timer clock does not advance.
    // Exact interval and cleanup semantics are covered by the component tests.
    const topics = generation.preview.getByRole('button', { name: /^Topic \d+$/ });
    await expect(topics).toHaveText(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    await page.waitForTimeout(5_300);
    await expect(topics).toHaveText(['Topic 5', 'Topic 6', 'Topic 7', 'Topic 8']);
    await expect(topics.first().locator('..')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('topic-card-page-2.png') });
    await page.waitForTimeout(5_000);
    await expect(topics).toHaveText(['Topic 9', 'Topic 10']);
    await page.waitForTimeout(5_000);
    await expect(topics).toHaveText(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
  });
}
