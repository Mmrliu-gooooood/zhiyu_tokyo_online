import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationJobDisplayProjection } from '@/lib/generation/job-display';

const data = vi.hoisted(() => {
  const outlines = Array.from({ length: 12 }, (_, order) => ({
    id: `scene_${order + 1}`,
    title: `Scene ${order + 1}`,
    order,
  }));
  return {
    outlines,
    scenes: outlines.slice(0, 6).map((outline) => ({
      ...outline,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    })),
    failedOutlines: [] as Array<{ id: string; title: string; order: number }>,
    generationStatus: 'generating',
  };
});

vi.mock('@/lib/store', () => {
  const state = {
    get scenes() {
      return data.scenes;
    },
    outlines: data.outlines,
    currentSceneId: 'scene_1',
    setCurrentSceneId: vi.fn(),
    generatingOutlines: data.outlines.slice(6),
    get generationStatus() {
      return data.generationStatus;
    },
  };
  return {
    useStageStore: Object.assign(() => state, {
      use: { failedOutlines: () => data.failedOutlines },
    }),
    useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 16 / 9 } },
  };
});
vi.mock('@/lib/store/stage', () => ({ PENDING_SCENE_ID: '__pending__' }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
  }),
}));
vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => null,
}));

import { SceneSidebar } from '@/components/stage/scene-sidebar';

function render(display: GenerationJobDisplayProjection) {
  return renderToStaticMarkup(
    createElement(SceneSidebar, {
      collapsed: false,
      onCollapseChange: () => {},
      onRetryOutline: async () => {},
      generationJobDisplay: display,
    }),
  );
}

beforeEach(() => {
  data.scenes = data.outlines.slice(0, 6).map((outline) => ({
    ...outline,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
  }));
  data.failedOutlines = [];
  data.generationStatus = 'generating';
});

describe('SceneSidebar generation task state', () => {
  it('shows the trophy completion entry without a phantom pending thumbnail for a completed edited deck', () => {
    data.generationStatus = 'idle';
    const html = renderToStaticMarkup(
      createElement(SceneSidebar, {
        collapsed: false,
        onCollapseChange: () => {},
        isCourseComplete: true,
      }),
    );
    expect(html).toContain('stage.courseComplete');
    expect(html).toContain('lucide-trophy');
    expect(html).not.toContain('lucide-loader-circle');
    expect(html.match(/data-testid="scene-item"/g)).toHaveLength(data.scenes.length + 1);
  });

  const running: GenerationJobDisplayProjection = {
    status: 'running',
    executing: true,
    terminal: false,
    stopped: false,
    recovery: 'none',
    retryAt: null,
    affectedOutlineIds: [],
    triggerIssues: [],
    unknownIssues: [],
  };

  it('animates every pending scene while generation is running', () => {
    const html = render(running);
    expect(html.match(/class="[^"]*animate-spin[^"]*"/g)).toHaveLength(6);
  });

  it.skipIf(process.env.TEST_BROWSER_UI !== '1')(
    'rotates every pending icon in Chromium and honors reduced motion',
    async () => {
      const { chromium } = await import('@playwright/test');
      const { default: tailwind } = await import('@tailwindcss/postcss');
      const { resolve } = await import('node:path');
      const { createRequire } = await import('node:module');
      // Use the plugin's own PostCSS runtime: the workspace also has a newer
      // PostCSS version with incompatible duplicate TypeScript declarations.
      const require = createRequire(import.meta.url);
      const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss');
      const { css } = await postcss([tailwind()]).process(
        '@import "tailwindcss" source(none);\n@source "../../components/stage/scene-sidebar.tsx";',
        { from: resolve('e2e/fixtures/scene-sidebar.css') },
      );
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ reducedMotion: 'no-preference' });
        await page.setContent(`<style>${css}</style>${render(running)}`);
        const icons = page.locator('svg.lucide-loader-circle');
        expect(await icons.count()).toBe(6);
        const before = await icons.evaluateAll((elements) =>
          elements.map((element) => ({
            name: getComputedStyle(element).animationName,
            state: element.getAnimations()[0]?.playState,
            transform: getComputedStyle(element).transform,
          })),
        );
        expect(before.map(({ name, state }) => ({ name, state }))).toEqual(
          Array.from({ length: 6 }, () => ({ name: 'spin', state: 'running' })),
        );
        await page.waitForTimeout(100);
        const after = await icons.evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).transform),
        );
        expect(after.every((transform, index) => transform !== before[index].transform)).toBe(true);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(
          await icons.evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).animationName),
          ),
        ).toEqual(Array(6).fill('none'));
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it('keeps task recovery visible when every outline already has scene content', () => {
    data.scenes = data.outlines.map((outline) => ({
      ...outline,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    }));

    const html = render({
      status: 'needs_attention',
      executing: false,
      terminal: true,
      stopped: true,
      recovery: 'confirm_unknown',
      retryAt: null,
      affectedOutlineIds: ['scene_7'],
      triggerIssues: [
        {
          outlineId: 'scene_7',
          phase: 'actions',
          code: 'PROVIDER_REQUEST_NOT_SENT',
          state: 'retry_wait',
        },
      ],
      unknownIssues: [],
    });

    expect(html).toContain('generation.classroomStoppedWithTrigger');
    expect(html).toContain('generation.retryCourseGeneration');
    expect(html).not.toContain('animate-spin');
  });

  it('keeps page 07 pending ahead of a non-contiguous ready page 08', () => {
    data.scenes = [
      ...data.scenes,
      {
        ...data.outlines[7],
        type: 'quiz',
        content: { type: 'quiz', questions: [] },
      },
    ];

    const html = render({
      status: 'running',
      executing: true,
      terminal: false,
      stopped: false,
      recovery: 'none',
      retryAt: null,
      affectedOutlineIds: [],
      triggerIssues: [],
      unknownIssues: [],
    });

    expect(html).toMatch(/>07<\/span><span[^>]*>Scene 7<\/span>/);
    expect(html).toMatch(/>08<\/span><span[^>]*>Scene 8<\/span>/);
    expect(html.indexOf('Scene 7')).toBeLessThan(html.indexOf('Scene 8'));
  });

  it('stops scene 07, exposes task recovery, and names trigger plus unknown pages', () => {
    data.failedOutlines = data.outlines.slice(6);
    data.generationStatus = 'error';
    const html = render({
      status: 'needs_attention',
      executing: false,
      terminal: true,
      stopped: true,
      recovery: 'confirm_unknown',
      retryAt: null,
      affectedOutlineIds: data.outlines.slice(6).map((outline) => outline.id),
      triggerIssues: [
        {
          outlineId: 'scene_7',
          phase: 'actions',
          code: 'PROVIDER_REQUEST_NOT_SENT',
          state: 'retry_wait',
        },
      ],
      unknownIssues: [
        {
          outlineId: 'scene_8',
          phase: 'content',
          code: 'EXTERNAL_RESULT_UNKNOWN',
          state: 'unknown',
        },
        {
          outlineId: 'scene_9',
          phase: 'content',
          code: 'EXTERNAL_RESULT_UNKNOWN',
          state: 'unknown',
        },
      ],
    });

    expect(html).not.toContain('animate-spin');
    expect(html).toContain('generation.retryCourseGeneration');
    expect(html).toContain('generation.classroomStoppedWithTriggerAndUnknown');
    expect(html).toContain('&quot;triggerPages&quot;:&quot;7&quot;');
    expect(html).toContain('&quot;unknownPages&quot;:&quot;8, 9&quot;');
    expect(html).toContain('PROVIDER_REQUEST_NOT_SENT');
  });

  it('shows a bounded retry wait without a spinner or manual recovery', () => {
    data.generationStatus = 'paused';
    const html = render({
      status: 'retry_wait',
      executing: false,
      terminal: false,
      stopped: false,
      recovery: 'none',
      retryAt: '2030-01-02T03:04:05.000Z',
      affectedOutlineIds: [],
      triggerIssues: [],
      unknownIssues: [],
    });
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('generation.retryCourseGeneration');
    expect(html).toContain('generation.classroomRetryScheduledAt');
  });

  it('renders cancellation as a non-retryable terminal state', () => {
    data.generationStatus = 'paused';
    const html = render({
      status: 'cancelled',
      executing: false,
      terminal: true,
      stopped: false,
      recovery: 'none',
      retryAt: null,
      affectedOutlineIds: [],
      triggerIssues: [],
      unknownIssues: [],
    });
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('generation.retryCourseGeneration');
    expect(html).toContain('generation.classroomGenerationCancelled');
  });
});
