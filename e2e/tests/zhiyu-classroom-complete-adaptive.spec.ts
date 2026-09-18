import { test, expect } from '../fixtures/base';
import type { Page, TestInfo } from '@playwright/test';

const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
const STANDALONE_STAGE_ID = `zhiyu-complete-adaptive-standalone-e2e-${RUN_ID}`;
const WORKSPACE_STAGE_ID = `zhiyu-complete-adaptive-workspace-e2e-${RUN_ID}`;

type PersistenceHeaders = {
  authorization?: string;
  origin: string;
  'x-learner-key'?: string;
};

test.describe.configure({ timeout: 120_000 });

async function seedCompletedStage(
  page: Page,
  stageId: string,
  options: { title?: string; withoutQuiz?: boolean; staleOutline?: boolean } = {},
): Promise<PersistenceHeaders | undefined> {
  const persistenceRequest = page
    .waitForRequest(
      (request) => request.url().includes('/api/persistence/documents/warmup-nonexistent'),
      { timeout: 5_000 },
    )
    .catch(() => null);
  await page.goto('/classroom/warmup-nonexistent');
  const persistedLoad = await persistenceRequest;
  const document = await page.evaluate(
    async ({ stageId, options }) => {
      const request = indexedDB.open('maic-documents', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('stages', { keyPath: 'id' });
        const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
        scenes.createIndex('by-stage', 'stageId');
        db.createObjectStore('outlines', { keyPath: 'stageId' });
      };
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const now = Date.now();
      const scenes = [
        {
          id: 'complete-quiz',
          stageId,
          type: 'quiz',
          title: 'Knowledge check',
          order: 0,
          content: {
            type: 'quiz',
            questions: [
              {
                id: 'complete-q1',
                type: 'single',
                question: 'Which option is correct?',
                options: [
                  { value: 'a', label: 'A' },
                  { value: 'b', label: 'B' },
                ],
                answer: ['a'],
                hasAnswer: true,
                points: 1,
              },
            ],
          },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'complete-interactive',
          stageId,
          type: 'interactive',
          title: 'Interactive example',
          order: 1,
          content: { type: 'interactive', url: 'about:blank' },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'complete-pbl',
          stageId,
          type: 'pbl',
          title: 'Project practice',
          order: 2,
          content: { type: 'pbl', projectConfig: {} },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'complete-slide',
          stageId,
          type: 'slide',
          title: 'Summary slide',
          order: 3,
          content: {
            type: 'slide',
            canvas: { elements: [], background: { color: '#ffffff' } },
          },
          createdAt: now,
          updatedAt: now,
        },
      ];

      if (options.withoutQuiz) scenes.splice(0, 1);
      const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
      const stage = {
        id: stageId,
        name:
          options.title ??
          'A deliberately long completed course title for compact layout verification',
        description: '',
        language: 'en-US',
        style: 'professional',
        createdAt: now,
        updatedAt: now,
        dslVersion: '0.1.0',
      };
      tx.objectStore('stages').put(stage);
      for (const scene of scenes) tx.objectStore('scenes').put(scene);
      const outline = {
        outlines: options.staleOutline
          ? [
              {
                id: 'stale-summary',
                type: 'slide',
                title: 'Summary slide',
                description: 'Saved outline from before editing',
                keyPoints: [],
                order: 4,
              },
            ]
          : [],
        generationComplete: true,
        createdAt: now,
        updatedAt: now,
      };
      tx.objectStore('outlines').put({ stageId, outline });
      localStorage.setItem(
        `maic:device:editor-current-scene:${stageId}`,
        JSON.stringify({ sceneId: 'complete-slide', updatedAt: new Date(now).toISOString() }),
      );
      // Seed an isolated, persisted reviewed attempt through the compatibility
      // journal. The completion page asynchronously migrates this into
      // maic-runtime before calculating its score, exercising the real delayed
      // answer-read path without touching a user's course or calling a service.
      localStorage.setItem('quizAnswers:complete-quiz', JSON.stringify({ 'complete-q1': 'a' }));
      localStorage.setItem(
        'quizResults:complete-quiz',
        JSON.stringify([
          {
            questionId: 'complete-q1',
            correct: true,
            status: 'correct',
            earned: 1,
          },
        ]),
      );
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { stage, scenes, outline };
    },
    { stageId, options },
  );

  if (!persistedLoad) return undefined;
  const requestHeaders = await persistedLoad.allHeaders();
  const headers: PersistenceHeaders = {
    origin: 'http://localhost:3000',
    ...(requestHeaders.authorization ? { authorization: requestHeaders.authorization } : {}),
    ...(requestHeaders['x-learner-key']
      ? { 'x-learner-key': requestHeaders['x-learner-key'] }
      : {}),
  };
  const response = await page.request.put(`/api/persistence/documents/${stageId}`, {
    headers,
    data: document,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return headers;
}

async function cleanupCompletedStage(
  page: Page,
  stageId: string,
  headers: PersistenceHeaders | undefined,
) {
  if (!headers) return;
  await page.request.delete(`/api/persistence/runtime/stages/${stageId}`, { headers });
  await page.request.delete(`/api/persistence/documents/${stageId}`, { headers });
}

async function advanceToCompletion(page: Page) {
  const playbackBar = page.getByTestId('zhiyu-playback-bar');
  const next = playbackBar.getByRole('button', { name: /next scene|下一场景/i });
  await expect(next).toBeEnabled({ timeout: 30_000 });
  await next.click();
  const complete = page.locator(
    'section[aria-label="Course complete"], section[aria-label="课程完成"]',
  );
  await expect(complete).toBeVisible({ timeout: 30_000 });
  return complete;
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { scrollBottom?: boolean } = {},
) {
  // Framer Motion intentionally staggers the completion reveal; capture the
  // settled UI so the attached artifact is useful as visual evidence.
  await page.waitForTimeout(1_500);
  if (options.scrollBottom) {
    await page.getByTestId('classroom-complete-scroll').evaluate((element) => {
      (element as HTMLElement).style.scrollBehavior = 'auto';
      element.scrollTop = element.scrollHeight;
    });
  }
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function setObservedSectionHeight(complete: ReturnType<Page['locator']>, height: number) {
  await complete.evaluate((element, nextHeight) => {
    const section = element as HTMLElement;
    section.style.bottom = 'auto';
    section.style.height = `${nextHeight}px`;
  }, height);
  await expect.poll(() => complete.evaluate((element) => element.clientHeight)).toBe(height);
}

async function verifyExactHeightHysteresis(complete: ReturnType<Page['locator']>) {
  const trophy = complete.getByTestId('classroom-complete-trophy');

  await setObservedSectionHeight(complete, 820);
  await expect(complete).toHaveAttribute('data-compact', 'false');
  await expect.poll(() => trophy.evaluate((element) => element.clientWidth)).toBe(200);

  await setObservedSectionHeight(complete, 780);
  await expect(complete).toHaveAttribute('data-compact', 'false');

  await setObservedSectionHeight(complete, 759);
  await expect(complete).toHaveAttribute('data-compact', 'true');
  await expect.poll(() => trophy.evaluate((element) => element.clientWidth)).toBe(120);

  await setObservedSectionHeight(complete, 780);
  await expect(complete).toHaveAttribute('data-compact', 'true');

  await setObservedSectionHeight(complete, 820);
  await expect(complete).toHaveAttribute('data-compact', 'false');

  await complete.evaluate((element) => {
    const section = element as HTMLElement;
    section.style.removeProperty('bottom');
    section.style.removeProperty('height');
  });
}

async function verifyVeryShortScroll(page: Page) {
  const complete = page.locator(
    'section[aria-label="Course complete"], section[aria-label="课程完成"]',
  );
  const scroll = page.getByTestId('classroom-complete-scroll');
  const trophy = page.getByTestId('classroom-complete-trophy');
  await setObservedSectionHeight(complete, 420);
  await expect(complete).toHaveAttribute('data-compact', 'true');
  await expect
    .poll(() =>
      scroll.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
    )
    .toMatchObject({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) });
  const dimensions = await scroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const [scrollTopBox, trophyBox] = await Promise.all([scroll.boundingBox(), trophy.boundingBox()]);
  expect(scrollTopBox).not.toBeNull();
  expect(trophyBox).not.toBeNull();
  expect(trophyBox!.y).toBeGreaterThanOrEqual(scrollTopBox!.y - 1);
  expect(trophyBox!.y + trophyBox!.height).toBeLessThanOrEqual(
    scrollTopBox!.y + scrollTopBox!.height + 1,
  );

  await scroll.focus();
  await page.keyboard.press('End');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const encouragement = page.getByText(/Outstanding|A good start|太棒了|万事开头难/);
  await expect(encouragement).toBeVisible();
  const [scrollBox, encouragementBox] = await Promise.all([
    scroll.boundingBox(),
    encouragement.boundingBox(),
  ]);
  expect(scrollBox).not.toBeNull();
  expect(encouragementBox).not.toBeNull();
  expect(encouragementBox!.y + encouragementBox!.height).toBeLessThanOrEqual(
    scrollBox!.y + scrollBox!.height + 1,
  );
}

test('standalone classroom switches by container height and keeps the full result reachable', async ({
  page,
}, testInfo) => {
  let persistenceHeaders: PersistenceHeaders | undefined;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    persistenceHeaders = await seedCompletedStage(page, STANDALONE_STAGE_ID);
    await page.goto(`/classroom/${STANDALONE_STAGE_ID}`);
    const complete = await advanceToCompletion(page);
    await expect(complete).toHaveAttribute('data-compact', 'true');
    await expect(page.getByText(/1 \/ 1 correct|答对 1 \/ 1/)).toBeVisible();
    await capture(page, testInfo, 'standalone-compact');

    await verifyExactHeightHysteresis(complete);
    await capture(page, testInfo, 'standalone-full');

    await verifyVeryShortScroll(page);
    await capture(page, testInfo, 'standalone-scroll-bottom', { scrollBottom: true });

    const previous = page
      .getByTestId('zhiyu-playback-bar')
      .getByRole('button', { name: /previous scene|上一场景/i });
    await previous.click();
    await expect(complete).toBeHidden();
    await advanceToCompletion(page);
  } finally {
    await cleanupCompletedStage(page, STANDALONE_STAGE_ID, persistenceHeaders);
  }
});

test('hosted workspace classroom uses the same compact completion surface', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('**/api/agent/sessions', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback(),
  );
  await page.route('**/api/agent/owner-events', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'cache-control': 'no-cache' },
          body: 'event: connected\ndata: {}\n\n',
        })
      : route.fallback(),
  );
  let persistenceHeaders: PersistenceHeaders | undefined;
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    persistenceHeaders = await seedCompletedStage(page, WORKSPACE_STAGE_ID);
    await page.goto(`/workspace?course=${WORKSPACE_STAGE_ID}`);
    await expect(page.getByTestId('zhiyu-workspace-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workbench-start-learning')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('workbench-start-learning').click();
    await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
    const complete = await advanceToCompletion(page);
    await expect(complete).toHaveAttribute('data-compact', 'true');
    await capture(page, testInfo, 'workspace-compact');

    // Playback intentionally owns the full workspace and removes its pane
    // controls. Resize the actual hosted section (not window.innerHeight) to
    // prove its ResizeObserver responds to host-container changes.
    await verifyExactHeightHysteresis(complete);
    await verifyVeryShortScroll(page);
    await capture(page, testInfo, 'workspace-scroll-bottom', { scrollBottom: true });
  } finally {
    await cleanupCompletedStage(page, WORKSPACE_STAGE_ID, persistenceHeaders);
  }
});

test('1366x768 Chinese dark completion preserves the empty-title fallback without a quiz', async ({
  page,
}, testInfo) => {
  const stageId = `zhiyu-complete-no-quiz-e2e-${RUN_ID}`;
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'zh-CN');
    localStorage.setItem('theme', 'dark');
  });
  let persistenceHeaders: PersistenceHeaders | undefined;
  try {
    persistenceHeaders = await seedCompletedStage(page, stageId, { title: '', withoutQuiz: true });
    await page.goto(`/classroom/${stageId}`);
    const complete = await advanceToCompletion(page);
    await expect(complete).toHaveAttribute('data-compact', 'true');
    await expect(complete.getByRole('heading', { name: '课程完成', exact: true })).toBeVisible();
    await expect(complete.getByRole('status')).toHaveText('课程完成');
    await expect(complete.getByText(/答对|correct|%/)).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(/dark/);
    const scroll = complete.getByTestId('classroom-complete-scroll');
    const dimensions = await scroll.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
    await capture(page, testInfo, 'standalone-chinese-dark-no-quiz');
  } finally {
    await cleanupCompletedStage(page, stageId, persistenceHeaders);
  }
});

for (const hosted of [false, true]) {
  test(`${hosted ? 'Pro hosted' : 'standalone'} completion keeps a trophy entry with stale outlines and bounds a long prompt title`, async ({
    page,
  }, testInfo) => {
    const stageId = `zhiyu-complete-stale-${hosted}-${RUN_ID}`;
    const title =
      '为高中学生设计一节《师说》讲授型大师课（单课时，约10页），核心学习目标有两条，课堂重心放在理解与鉴赏。'.repeat(
        6,
      );
    let headers: PersistenceHeaders | undefined;
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (hosted) {
      await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
    }
    try {
      headers = await seedCompletedStage(page, stageId, {
        title,
        withoutQuiz: true,
        staleOutline: true,
      });
      if (hosted) {
        await page.goto(`/workspace?course=${stageId}`);
        await expect(page.getByTestId('workbench-start-learning')).toBeEnabled({ timeout: 30_000 });
        await page.getByTestId('workbench-start-learning').click();
      } else {
        await page.goto(`/classroom/${stageId}`);
      }
      const rail = page.getByTestId('zhiyu-scene-rail');
      const trophy = rail.getByRole('button', { name: /course complete|课程完成/i });
      await expect(trophy).toBeVisible({ timeout: 30_000 });
      await trophy.click();
      const complete = page.locator(
        'section[aria-label="Course complete"], section[aria-label="课程完成"]',
      );
      await expect(complete).toBeVisible();
      await expect(trophy).toHaveAttribute('aria-current', 'page');
      await expect(trophy.locator('svg.lucide-trophy')).toHaveCount(1);
      await expect(rail.locator('svg.lucide-loader-circle')).toHaveCount(0);
      const heading = complete.getByRole('heading');
      await expect(heading).toHaveText(title);
      await expect(heading).toHaveAttribute('title', title);
      const dimensions = await heading.evaluate((element) => ({
        height: element.clientHeight,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        overflowX: getComputedStyle(element).overflowX,
      }));
      expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight * 2 + 1);
      // Chromium includes hanging Chinese punctuation in the clipped heading's
      // scrollWidth. Verify visible containment and the actual scroll surface
      // instead of treating hidden glyph overhang as horizontal page overflow.
      expect(dimensions.overflowX).toBe('hidden');
      const scroll = complete.getByTestId('classroom-complete-scroll');
      const scrollDimensions = await scroll.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        documentWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
      }));
      expect(scrollDimensions.scrollWidth).toBeLessThanOrEqual(scrollDimensions.width + 1);
      expect(scrollDimensions.documentScrollWidth).toBeLessThanOrEqual(
        scrollDimensions.documentWidth + 1,
      );
      const [headingBox, scrollBox] = await Promise.all([
        heading.boundingBox(),
        scroll.boundingBox(),
      ]);
      expect(headingBox).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(headingBox!.x).toBeGreaterThanOrEqual(scrollBox!.x - 1);
      expect(headingBox!.x + headingBox!.width).toBeLessThanOrEqual(
        scrollBox!.x + scrollBox!.width + 1,
      );

      const panel = page.getByTestId('zhiyu-interaction-panel');
      if ((await panel.getAttribute('data-collapsed')) === 'true') {
        await page
          .getByTestId('zhiyu-playback-bar')
          .getByRole('button', { name: /toggle interaction panel|切换互动面板/i })
          .click();
      }
      await panel.getByRole('tab', { name: /discussion|讨论/i }).click();
      const toggle = panel.getByTestId('guided-learning-toggle').getByRole('switch');
      // This regression runs on deployments with checked tutoring enabled.
      await expect(toggle).toBeVisible();
      for (const active of [false, true, false]) {
        if ((await toggle.getAttribute('aria-checked')) !== String(active)) await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', String(active));
        await expect
          .poll(async () => {
            const track = await toggle.boundingBox();
            const thumb = await toggle.locator('span').boundingBox();
            return (
              !!track &&
              !!thumb &&
              thumb.x >= track.x + 1 &&
              thumb.x + thumb.width <= track.x + track.width - 1
            );
          })
          .toBe(true);
      }
      await capture(
        page,
        testInfo,
        `${hosted ? 'pro' : 'standalone'}-completion-and-toggle-regression`,
      );
      await page.setViewportSize({ width: 1920, height: 1080 });
      if ((await rail.getAttribute('data-collapsed')) === 'true') {
        await rail.getByRole('button', { name: /expand scene rail|展开场景栏/i }).click();
      }
      await expect(rail).toHaveAttribute('data-collapsed', 'false');
      await expect(trophy.locator('span')).toBeVisible();
      await expect(trophy.locator('span')).toHaveText(/course complete|课程完成/i);
      await expect(panel).toHaveAttribute('data-collapsed', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await capture(
        page,
        testInfo,
        `${hosted ? 'pro' : 'standalone'}-completion-expanded-rail-toggle-on`,
      );
    } finally {
      await cleanupCompletedStage(page, stageId, headers);
    }
  });
}
