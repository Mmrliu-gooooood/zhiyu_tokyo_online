import type { Page, TestInfo } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';
import { createSettingsStorage } from '../fixtures/test-data/settings';
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
  sceneOutlines: null,
  currentStep: 'generating',
});

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
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  await page.screenshot({
    path: testInfo.outputPath(`zhiyu-matrix-${surface}-${matrix.width}-${matrix.theme}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

async function openCombinedWorkspace(page: Page, matrix: MatrixCase) {
  await configureMatrixCase(page, matrix);
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
        { settings: createSettingsStorage(), session: GENERATION_SESSION },
      );
      await mockApi.setupGenerationMocks();
      const generation = new GenerationPreviewPage(page);
      await generation.goto();
      await expect(generation.shell).toBeVisible();
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
