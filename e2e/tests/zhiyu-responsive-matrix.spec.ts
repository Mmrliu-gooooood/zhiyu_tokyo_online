import type { Page, TestInfo } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';
import { ClassroomPage } from '../pages/classroom.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { HomePage } from '../pages/home.page';

type MatrixCase = {
  readonly width: 800 | 1024 | 1366 | 1600;
  readonly theme: 'light' | 'dark';
};

const TIER_A_CASES: readonly MatrixCase[] = [
  { width: 800, theme: 'light' },
  { width: 1024, theme: 'light' },
  { width: 1366, theme: 'light' },
  { width: 1600, theme: 'light' },
  { width: 1366, theme: 'dark' },
];

const TIER_B_CASES: readonly MatrixCase[] = [
  { width: 800, theme: 'light' },
  { width: 1024, theme: 'light' },
  { width: 1366, theme: 'light' },
  { width: 1366, theme: 'dark' },
];

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'zhiyu-responsive-matrix',
  requirements: { requirement: 'Explain photosynthesis' },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: mockOutlines,
  languageDirective: 'Use English for the generated course.',
  currentStep: 'generating',
  previewPhase: 'review',
});

const GOLDEN_ERROR_STAGE_ID = 'e2e-zhiyu-golden-error';
const CONTAMINATING_SESSION_ID = 'e2e-golden-backend-contamination';

const CONTAMINATING_SESSION = {
  id: CONTAMINATING_SESSION_ID,
  stageId: 'e2e-unrelated-course',
  prompt: 'This backend session must not enter the visual fixture',
  status: 'succeeded',
  createdAt: 1_788_192_000_000,
  updatedAt: 1_788_192_000_000,
} as const;

const EMPTY_OWNER_EVENT_STREAM = [
  'event: caught_up',
  'data: {"type":"caught_up","replayed":0,"fromEventId":"0"}',
  '',
  '',
].join('\n');

async function configureMatrixCase(page: Page, matrix: MatrixCase) {
  await page.setViewportSize({ width: matrix.width, height: 900 });
  await page.emulateMedia({ colorScheme: matrix.theme });
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('locale', 'en-US');
  }, matrix);
}

async function captureMatrixEvidence(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  matrix: MatrixCase,
) {
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(matrix.width);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  await page.screenshot({
    path: testInfo.outputPath(`zhiyu-matrix-${surface}-${matrix.width}-${matrix.theme}.png`),
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  await expect(page).toHaveScreenshot(
    `zhiyu-matrix-${surface}-${matrix.width}-${matrix.theme}.png`,
    {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  );
}

async function seedFutureVersionClassroom(page: Page) {
  await page.goto('/classroom/golden-error-warmup');
  await page.evaluate((stageId) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('maic-documents', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('stages', { keyPath: 'id' });
        const scenes = database.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
        scenes.createIndex('by-stage', 'stageId');
        database.createObjectStore('outlines', { keyPath: 'stageId' });
      };
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('stages', 'readwrite');
        const now = Date.now();
        transaction.objectStore('stages').put({
          id: stageId,
          name: 'Future classroom document',
          createdAt: now,
          updatedAt: now,
          dslVersion: '99.0.0',
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, GOLDEN_ERROR_STAGE_ID);
}

async function installDeterministicWorkspaceOwnerFixture(page: Page) {
  await page.route('**/api/agent/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/agent/owner-events', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: EMPTY_OWNER_EVENT_STREAM,
    });
  });
}

async function openCombinedWorkspace(page: Page, matrix: MatrixCase) {
  await configureMatrixCase(page, matrix);
  await installDeterministicWorkspaceOwnerFixture(page);
  await seedClassroomDatabase(page);
  await page.goto(`/workspace?course=${ZHIYU_CLASSROOM_STAGE_ID}`);

  const shell = page.getByTestId('zhiyu-workspace-shell');
  await expect(shell).toBeVisible();
  await expect(page.getByTestId('workspace-classroom-pane')).toBeAttached();
  await expect(page.getByTestId('zhiyu-editor-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-chat-pane')).toBeAttached();
  await expect(page.getByTestId('workbench-chat')).toBeAttached();
  // The workspace pins its hosted course in editor mode. The independent
  // WorkbenchChat owns the one conversation column; classic classroom chat is
  // intentionally absent from the editor surface.
  await expect(page.getByTestId('chat-area')).toHaveCount(0);
  return shell;
}

test.describe('ZHIYU Tier A responsive and theme matrix', () => {
  for (const matrix of TIER_A_CASES) {
    test(`Home ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      await configureMatrixCase(page, matrix);
      await page.addInitScript((settings) => {
        localStorage.setItem('maic:account:settings-storage', settings);
      }, createSettingsStorage());
      const home = new HomePage(page);
      await home.goto();
      await expect(home.createCard).toBeVisible();
      await expect(page.getByRole('button', { name: /start class|开课/i })).toBeDisabled();
      await page.getByRole('button', { name: /theme|主题/i }).click();
      await expect(page.getByRole('button', { name: /dark|深色/i })).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'home', matrix);
    });

    test(`Generation ${matrix.width} ${matrix.theme}`, async ({ page, mockApi }, testInfo) => {
      await configureMatrixCase(page, matrix);
      await page.addInitScript(
        ({ settings, session }) => {
          localStorage.setItem('maic:account:settings-storage', settings);
          sessionStorage.setItem('generationSession', session);
        },
        {
          settings: createSettingsStorage({ reviewOutlineEnabled: true }),
          session: GENERATION_SESSION,
        },
      );
      await mockApi.setupGenerationMocks();
      const generation = new GenerationPreviewPage(page);
      await generation.goto();
      await generation.waitForEditor();
      await captureMatrixEvidence(page, testInfo, 'generation', matrix);
    });

    test(`Classroom ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      await configureMatrixCase(page, matrix);
      await seedClassroomDatabase(page);
      const classroom = new ClassroomPage(page);
      await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
      await classroom.waitForLoaded();
      await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
      await expect(page.getByTestId('zhiyu-playback-bar')).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'classroom', matrix);
    });

    test(`Workspace ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      const shell = await openCombinedWorkspace(page, matrix);
      await expect(shell).not.toHaveAttribute('data-ws-layout', 'home');
      await captureMatrixEvidence(page, testInfo, 'workspace-combined', matrix);

      const reopenChat = page.getByTestId('workspace-chat-reopen');
      if (await reopenChat.isVisible()) {
        await reopenChat.click();
        await expect(page.getByTestId('workbench-chat')).toBeVisible();
        await captureMatrixEvidence(page, testInfo, 'workspace-combined-chat-focus', matrix);
      }
    });

    test(`Hosted Classroom ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      await openCombinedWorkspace(page, matrix);
      await page.getByTestId('workbench-start-learning').click();
      await expect(page.getByTestId('zhiyu-editor-shell')).toBeHidden();
      await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
      await expect(page.getByTestId('zhiyu-playback-bar')).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'hosted-classroom', matrix);
    });
  }
});

test.describe('ZHIYU Tier B responsive and theme matrix', () => {
  for (const matrix of TIER_B_CASES) {
    test(`Settings ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      await configureMatrixCase(page, matrix);
      await page.addInitScript((settings) => {
        localStorage.setItem('maic:account:settings-storage', settings);
      }, createSettingsStorage());
      await page.goto('/');
      await page.getByRole('button', { name: /settings|设置/i }).click();
      await expect(page.getByTestId('zhiyu-settings-shell')).toBeVisible();
      await page.getByRole('button', { name: /^add$|^添加$/i }).click();
      await expect(
        page.getByRole('dialog', { name: /add model provider|添加模型供应商/i }),
      ).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'settings-provider-dialog', matrix);
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('dialog', { name: /add model provider|添加模型供应商/i }),
      ).toBeHidden();
    });

    test(`Editor ${matrix.width} ${matrix.theme}`, async ({ page }, testInfo) => {
      await configureMatrixCase(page, matrix);
      await seedClassroomDatabase(page);
      const classroom = new ClassroomPage(page);
      await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
      await classroom.waitForLoaded();
      await page.getByRole('switch', { name: /edit course|编辑课程/i }).click();
      await expect(page.getByTestId('zhiyu-editor-shell')).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'editor', matrix);
    });

    test(`Conversation and hosted editor ${matrix.width} ${matrix.theme}`, async ({
      page,
    }, testInfo) => {
      await openCombinedWorkspace(page, matrix);
      await expect(page.getByTestId('workspace-classroom-pane')).toBeVisible();
      await expect(page.getByTestId('zhiyu-editor-shell')).toBeVisible();
      await expect(page.getByTestId('chat-area')).toHaveCount(0);

      const reopenChat = page.getByTestId('workspace-chat-reopen');
      if (await reopenChat.isVisible()) await reopenChat.click();
      await expect(page.getByTestId('workbench-chat')).toBeVisible();
      await expect(page.getByTestId('workbench-chat-empty')).toBeVisible();
      await captureMatrixEvidence(page, testInfo, 'conversation-hosted-editor', matrix);
    });
  }
});

test('Workspace golden fixture ignores sessions already present in the backend', async ({
  page,
}) => {
  let backendOwnerStreamReached = false;
  await page.route('**/api/agent/sessions', async (route) => {
    await route.fulfill({ json: [CONTAMINATING_SESSION] });
  });
  await page.route('**/api/agent/owner-events', async (route) => {
    backendOwnerStreamReached = true;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: EMPTY_OWNER_EVENT_STREAM,
    });
  });

  const ownerStreamResponse = page.waitForResponse('**/api/agent/owner-events');
  await openCombinedWorkspace(page, { width: 1366, theme: 'light' });
  await ownerStreamResponse;
  await page.getByTestId('pro-nav-tab-sessions').click();

  await expect(
    page.getByTestId('pro-nav-section-sessions').getByText('No chats yet'),
  ).toBeVisible();
  expect(backendOwnerStreamReached).toBe(false);
  await expect(page.getByTestId(`pro-nav-session-${CONTAMINATING_SESSION_ID}`)).toHaveCount(0);
  await expect(page.getByTestId('workbench-chat-empty')).toBeVisible();
});

test('captures the Generation missing-session recovery state', async ({ page }, testInfo) => {
  const matrix = { width: 1366, theme: 'light' } as const;
  await configureMatrixCase(page, matrix);
  await page.goto('/generation-preview');
  await expect(
    page.getByRole('heading', { name: /session not found|未找到生成会话/i }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /back to home|返回首页/i })).toBeVisible();
  await captureMatrixEvidence(page, testInfo, 'generation-missing-session', matrix);
});

test('captures the Classroom loading state', async ({ page }, testInfo) => {
  const matrix = { width: 1366, theme: 'light' } as const;
  await configureMatrixCase(page, matrix);

  let releaseClassroomRequest!: () => void;
  const classroomRequestReleased = new Promise<void>((resolve) => {
    releaseClassroomRequest = resolve;
  });
  await page.route('**/api/classroom?id=e2e-zhiyu-golden-loading', async (route) => {
    await classroomRequestReleased;
    await route.fulfill({ status: 404, body: '{}' });
  });

  try {
    await page.goto('/classroom/e2e-zhiyu-golden-loading');
    await expect(page.getByText('Loading classroom...')).toBeVisible();
    await captureMatrixEvidence(page, testInfo, 'classroom-loading', matrix);
  } finally {
    releaseClassroomRequest();
  }
});

test('captures the Classroom storage error state', async ({ page }, testInfo) => {
  const matrix = { width: 1366, theme: 'light' } as const;
  await configureMatrixCase(page, matrix);
  await seedFutureVersionClassroom(page);
  await page.goto(`/classroom/${GOLDEN_ERROR_STAGE_ID}`);
  await expect(page.getByRole('button', { name: /^retry$/i })).toBeVisible();
  await captureMatrixEvidence(page, testInfo, 'classroom-error', matrix);
});
