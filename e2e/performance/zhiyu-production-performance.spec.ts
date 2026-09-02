import { test, expect, type Page } from '@playwright/test';
import playwrightPackage from '@playwright/test/package.json';

import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';

type CdpMetric = {
  readonly name: string;
  readonly value: number;
};

type CdpMetricName =
  | 'LayoutCount'
  | 'RecalcStyleCount'
  | 'LayoutDuration'
  | 'ScriptDuration'
  | 'TaskDuration';

const CDP_METRIC_NAMES: readonly CdpMetricName[] = [
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'ScriptDuration',
  'TaskDuration',
];

const LONG_TASK_BUFFER_KEY = '__openmaicPhase0LongTaskDurationsMs';
const OBSERVATION_WINDOW_MS = 1_000;
const OWNER_CAUGHT_UP_STREAM = [
  'event: caught_up',
  'data: {"type":"caught_up","replayed":0,"fromEventId":"0"}',
  '',
  '',
].join('\n');

function metricsByName(metrics: readonly CdpMetric[]) {
  return new Map(metrics.map(({ name, value }) => [name, value]));
}

async function readCdpMetrics(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');

  const read = async () => {
    const response = (await session.send('Performance.getMetrics')) as {
      readonly metrics: readonly CdpMetric[];
    };
    return metricsByName(response.metrics);
  };

  return { read, session };
}

test('records the fixed production Workspace browser performance baseline', async ({
  page,
  browser,
}, testInfo) => {
  const boundaryHits = {
    serverProviders: 0,
    ownerSessions: 0,
    ownerEvents: 0,
    stageFreshness: 0,
    stageManifest: 0,
    stageScenes: 0,
  };
  const unexpectedExternalRequests: string[] = [];
  const realProviderRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://localhost:3000') unexpectedExternalRequests.push(request.url());
    if (
      /\/api\/(?:generate|chat|ai)(?:\/|$)/.test(url.pathname) ||
      /\/api\/agent\/sessions\/[^/]+\/messages$/.test(url.pathname)
    ) {
      realProviderRequests.push(request.url());
    }
  });

  await page.route('**/api/server-providers', (route) => {
    boundaryHits.serverProviders += 1;
    return route.fulfill({ json: { providers: {} } });
  });
  await page.route('**/api/agent/sessions', (route) => {
    boundaryHits.ownerSessions += 1;
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/agent/owner-events', (route) => {
    boundaryHits.ownerEvents += 1;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: OWNER_CAUGHT_UP_STREAM,
    });
  });
  await page.route('**/api/stages/*/freshness', (route) => {
    boundaryHits.stageFreshness += 1;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: ': fixed performance fixture\n\n',
    });
  });
  await page.route('**/api/stages/*/manifest', (route) => {
    boundaryHits.stageManifest += 1;
    return route.fulfill({ status: 404, json: { error: 'fixture-local-stage' } });
  });
  await page.route('**/api/stages/*/scenes?*', (route) => {
    boundaryHits.stageScenes += 1;
    return route.fulfill({ json: { scenes: [] } });
  });

  // The seed helper first opens Home to create the production IndexedDB. Start
  // both recorders afterwards so only the fixed Workspace navigation is measured.
  await seedClassroomDatabase(page);
  await page.addInitScript((bufferKey) => {
    const durations: number[] = [];
    Reflect.set(globalThis, bufferKey, durations);
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: true });
  }, LONG_TASK_BUFFER_KEY);

  const cdp = await readCdpMetrics(page);

  await page.goto(`/workspace?course=${ZHIYU_CLASSROOM_STAGE_ID}`);
  await expect(page.getByTestId('zhiyu-workspace-shell')).toBeVisible();
  await expect(page.getByTestId('zhiyu-workspace-rail')).toBeVisible();
  await expect(page.getByTestId('workbench-chat')).toBeAttached();
  await expect(page.getByTestId('zhiyu-editor-shell')).toBeVisible();

  const browserEnvironment = await page.evaluate(async (observationWindowMs) => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await new Promise((resolve) => setTimeout(resolve, observationWindowMs));

    return {
      deviceScaleFactor: window.devicePixelRatio,
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontsReady: document.fonts.status === 'loaded',
      interVariableLoaded: document.fonts.check('12px "Inter Variable"'),
      locale: navigator.language,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, OBSERVATION_WINDOW_MS);

  const sampledCdpMetrics = await cdp.read();
  await cdp.session.detach();

  const cdpMetrics = Object.fromEntries(
    CDP_METRIC_NAMES.map((name) => {
      const value = sampledCdpMetrics.get(name);
      expect(value, `CDP must expose ${name} at the fixed sample point`).toEqual(
        expect.any(Number),
      );
      return [name, value!];
    }),
  ) as Record<CdpMetricName, number>;

  const longTaskDurationsMs = await page.evaluate((bufferKey) => {
    const durations = Reflect.get(globalThis, bufferKey);
    return Array.isArray(durations) ? (durations as number[]) : [];
  }, LONG_TASK_BUFFER_KEY);
  const longTaskTotalDurationMs = longTaskDurationsMs.reduce(
    (total, duration) => total + duration,
    0,
  );

  const record = {
    environment: {
      appBaseURL: 'http://localhost:3000',
      browserName: testInfo.project.name,
      browserVersion: browser.version(),
      playwrightVersion: playwrightPackage.version,
      colorScheme: 'light',
      observationWindowMs: OBSERVATION_WINDOW_MS,
      ...browserEnvironment,
    },
    fixture: {
      route: `/workspace?course=${ZHIYU_CLASSROOM_STAGE_ID}`,
      stageId: ZHIYU_CLASSROOM_STAGE_ID,
      serverProviders: 'mocked-empty',
      ownerSessions: 'mocked-empty',
      ownerEvents: 'fixed-caught-up',
      stageFreshness: 'fixed-noop-stream',
      stageManifest: 'fixed-404-local-stage',
      stageScenes: 'fixed-empty',
      boundaryHits,
      realProviderRequests: {
        count: realProviderRequests.length,
        urls: realProviderRequests,
      },
      unexpectedExternalRequests,
    },
    fontsReady: browserEnvironment.fontsReady,
    longTasks: {
      count: longTaskDurationsMs.length,
      totalDurationMs: longTaskTotalDurationMs,
      maxDurationMs: Math.max(0, ...longTaskDurationsMs),
      durationsMs: longTaskDurationsMs,
    },
    cdp: cdpMetrics,
  };

  expect(record, 'the Playwright harness must collect the Phase 0 browser metrics').toMatchObject({
    fontsReady: true,
    longTasks: {
      count: expect.any(Number),
      totalDurationMs: expect.any(Number),
      maxDurationMs: expect.any(Number),
    },
    cdp: {
      LayoutCount: expect.any(Number),
      RecalcStyleCount: expect.any(Number),
      LayoutDuration: expect.any(Number),
      ScriptDuration: expect.any(Number),
      TaskDuration: expect.any(Number),
    },
  });
  expect(browserEnvironment).toMatchObject({
    deviceScaleFactor: 1,
    fontsReady: true,
    interVariableLoaded: true,
    locale: 'en-US',
    timezone: 'UTC',
    viewport: { width: 1366, height: 900 },
  });
  for (const value of [...Object.values(cdpMetrics), ...longTaskDurationsMs]) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(boundaryHits.serverProviders).toBeGreaterThan(0);
  expect(boundaryHits.ownerSessions).toBeGreaterThan(0);
  expect(realProviderRequests).toEqual([]);
  expect(unexpectedExternalRequests).toEqual([]);

  const json = JSON.stringify(record, null, 2);
  await testInfo.attach('phase0-browser-performance.json', {
    body: json,
    contentType: 'application/json',
  });
  console.log(`PHASE0_BROWSER_PERFORMANCE ${JSON.stringify(record)}`);
});
