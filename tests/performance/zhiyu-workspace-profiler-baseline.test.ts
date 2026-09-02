// @vitest-environment jsdom

import {
  Profiler,
  act,
  createElement,
  version as reactVersion,
  type ComponentType,
  type ProfilerOnRenderCallback,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { version as reactDomVersion } from 'react-dom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/lib/hooks/use-i18n';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import type { Scene, Stage } from '@/lib/types/stage';
import { createReactProfilerRecorder } from './react-profiler-recorder';

const EVENT_COUNT = 100;
const PROFILER_IDS = ['WorkspaceRail', 'WorkspaceChatPane', 'WorkspaceClassroomPane'] as const;
const SESSION_ID = 'phase0-session';
const COURSE_ID = 'phase0-course';
const SCENE_ID = 'phase0-scene';

const mocks = vi.hoisted(() => ({
  onRender: undefined as ProfilerOnRenderCallback | undefined,
  sources: [] as TestEventSource[],
  navigationPush: vi.fn(),
}));

const stage: Stage = {
  id: COURSE_ID,
  name: 'Phase 0 deterministic course',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const scene: Scene = {
  id: SCENE_ID,
  stageId: COURSE_ID,
  order: 0,
  title: 'Deterministic scene',
  type: 'slide',
  actions: [{ id: 'speech-initial', type: 'speech', text: 'Initial narration.' }],
  content: {
    type: 'slide',
    canvas: {
      id: 'phase0-canvas',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#111111'],
        fontColor: '#111111',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
};

class TestEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly listeners = new Map<string, Set<EventListener>>();
  readonly url: string;
  readyState = TestEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    mocks.sources.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED;
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.navigationPush }),
  useSearchParams: () => new URLSearchParams(`session=${SESSION_ID}&course=${COURSE_ID}`),
}));

vi.mock('@/lib/utils/stage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/stage-storage')>();
  return {
    ...actual,
    listStages: vi.fn(async () => [
      {
        id: COURSE_ID,
        name: stage.name,
        sceneCount: 1,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
      },
    ]),
    listFolders: vi.fn(async () => []),
    loadStageData: vi.fn(async () => ({
      stage,
      scenes: [scene],
      currentSceneId: SCENE_ID,
      chats: [],
      outline: {
        outlines: [],
        generationComplete: true,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
      },
    })),
    saveStageData: vi.fn(async () => undefined),
    saveStageDataIncremental: vi.fn(async () => undefined),
  };
});

function profiled<P extends object>(
  id: (typeof PROFILER_IDS)[number],
  Component: ComponentType<P>,
) {
  return function ProfiledWorkspaceComponent(props: P) {
    return createElement(
      Profiler,
      { id, onRender: (...args) => mocks.onRender?.(...args) },
      createElement(Component, props),
    );
  };
}

vi.mock('@/components/workbench/workspace/WorkspaceRail', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/workbench/workspace/WorkspaceRail')>();
  return { ...actual, WorkspaceRail: profiled('WorkspaceRail', actual.WorkspaceRail) };
});

vi.mock('@/components/workbench/workspace/WorkspaceChatPane', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/workbench/workspace/WorkspaceChatPane')>();
  return {
    ...actual,
    WorkspaceChatPane: profiled('WorkspaceChatPane', actual.WorkspaceChatPane),
  };
});

vi.mock('@/components/workbench/workspace/WorkspaceClassroomPane', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/components/workbench/workspace/WorkspaceClassroomPane')
    >();
  return {
    ...actual,
    WorkspaceClassroomPane: profiled(
      'WorkspaceClassroomPane',
      actual.WorkspaceClassroomPane as ComponentType<
        Parameters<typeof actual.WorkspaceClassroomPane>[0]
      >,
    ),
  };
});

import { WorkspaceShell } from '@/components/workbench/workspace/WorkspaceShell';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function publish(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await flush();
  });
}

function sourceFor(part: string): TestEventSource {
  const source = mocks.sources.find((candidate) => candidate.url.includes(part));
  if (!source) throw new Error(`Expected EventSource containing ${part}`);
  return source;
}

describe('Phase 0 Workspace integration Profiler evidence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalInnerWidthDescriptor: PropertyDescriptor | undefined;
  let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined;
  let originalUrl: string;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.sources.length = 0;
    mocks.navigationPush.mockReset();
    localStorage.clear();
    localStorage.setItem('openmaic:workspace:rail-tab', 'sessions');
    sessionStorage.clear();
    originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState({}, '', `/workspace?session=${SESSION_ID}&course=${COURSE_ID}`);
    originalInnerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubEnv('NEXT_PUBLIC_PRO_WORKBENCH_ENABLED', 'true');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly root = null;
        readonly rootMargin = '0px';
        readonly thresholds = [0];
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agent/sessions') {
          return response([
            {
              id: SESSION_ID,
              stageId: COURSE_ID,
              prompt: 'Build the deterministic course',
              title: 'Phase 0 session',
              status: 'running',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
            },
          ]);
        }
        if (url === `/api/agent/sessions/${SESSION_ID}`) {
          return response({
            id: SESSION_ID,
            stageId: COURSE_ID,
            prompt: 'Build the deterministic course',
            title: 'Phase 0 session',
            status: 'running',
          });
        }
        if (url === '/api/agent/runtime') return response({ enabled: true });
        if (url === `/api/stages/${COURSE_ID}/manifest`) {
          return response({ rev: 1, scenes: [{ id: SCENE_ID, order: 0, rev: 1 }] });
        }
        if (url.startsWith(`/api/stages/${COURSE_ID}/scenes?`)) {
          return response({ scenes: [scene] });
        }
        throw new Error(`Unexpected performance-harness request: ${url}`);
      }),
    );

    useWorkbenchStore.getState().detach();
    useStageStore.getState().clearStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useWorkbenchStore.getState().detach();
    useStageStore.getState().clearStore();
    mocks.onRender = undefined;
    container.remove();
    window.history.replaceState({}, '', originalUrl);
    if (originalInnerWidthDescriptor) {
      Object.defineProperty(window, 'innerWidth', originalInnerWidthDescriptor);
    } else {
      Reflect.deleteProperty(window, 'innerWidth');
    }
    if (originalScrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollIntoView',
        originalScrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('profiles the real Rail, Chat, and Classroom under a fixed owner/session stress sequence', async () => {
    const recorder = createReactProfilerRecorder();
    mocks.onRender = recorder.onRender;
    await preloadEditor();

    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          null,
          createElement(ThemeProvider, null, createElement(WorkspaceShell)),
        ),
      );
      await flush();
    });

    await act(async () => {
      await vi.waitFor(
        () => {
          expect(container.querySelector('[data-testid="workspace-chat-pane"]')).not.toBeNull();
          expect(
            container.querySelector('[data-testid="workspace-classroom-pane"]'),
          ).not.toBeNull();
          expect(container.querySelector('[data-testid="zhiyu-workspace-rail"]')).not.toBeNull();
          expect(
            container.querySelector(`[data-testid="pro-nav-session-${SESSION_ID}"]`),
          ).not.toBeNull();
          expect(container.querySelector('[data-testid="workbench-chat"]')).not.toBeNull();
          expect(container.querySelector('[data-testid="zhiyu-editor-shell"]')).not.toBeNull();
          expect(useStageStore.getState().stage?.id).toBe(COURSE_ID);
        },
        { timeout: 5_000 },
      );
    });

    const owner = sourceFor('/api/agent/owner-events');
    const session = sourceFor(`/api/agent/sessions/${SESSION_ID}/events`);
    await publish(() =>
      session.emit('session_start', {
        id: 1,
        ts: 1_700_000_000_000,
        attempt: 1,
        type: 'session_start',
        data: { prompt: 'Build the deterministic course', workerId: 'phase0-worker' },
      }),
    );
    await publish(() =>
      session.emit('message_start', {
        id: 2,
        ts: 1_700_000_000_001,
        attempt: 1,
        type: 'message_start',
        data: { message: { role: 'assistant', content: [] } },
      }),
    );
    await publish(() => session.emit('caught_up', { type: 'caught_up' }));

    recorder.reset();
    for (let index = 1; index <= EVENT_COUNT; index += 1) {
      await publish(() =>
        owner.emit('session_status', {
          id: String(index),
          type: 'session_status',
          sessionId: SESSION_ID,
          ts: 1_700_000_000_000 + index,
          status: index % 2 === 0 ? 'running' : 'queued',
          phase: 'live',
          attempt: 1,
        }),
      );
      await publish(() =>
        session.emit('message_update', {
          id: index * 2 + 2,
          ts: 1_700_000_001_000 + index,
          attempt: 1,
          type: 'message_update',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `Deterministic answer ${index}` }],
            },
          },
        }),
      );
      await publish(() =>
        session.emit('tool_execution_end', {
          id: index * 2 + 3,
          ts: 1_700_000_002_000 + index,
          attempt: 1,
          type: 'tool_execution_end',
          data: {
            toolName: 'generate_tts',
            toolCallId: `tts-${index}`,
            result: {
              details: {
                sceneId: SCENE_ID,
                sceneActions: [
                  {
                    id: `speech-${index}`,
                    type: 'speech',
                    text: `Narration ${index}`,
                    audioId: `audio-${index}`,
                    audioUrl: `/fixture/audio-${index}.mp3`,
                  },
                ],
              },
            },
          },
        }),
      );
    }

    const scenario = recorder.report(
      'owner-session-fixed-stress-sequence-v1',
      EVENT_COUNT * 3,
      PROFILER_IDS,
    );

    for (const id of PROFILER_IDS) {
      expect(scenario.islands[id]?.commits).toBeGreaterThan(0);
      expect(scenario.islands[id]?.p50Ms).not.toBeNull();
      expect(scenario.islands[id]?.p95Ms).not.toBeNull();
    }
    expect(
      useWorkbenchStore.getState().chat.some((node) => node.text === 'Deterministic answer 100'),
    ).toBe(true);
    expect(useStageStore.getState().scenes[0]?.actions?.[0]?.id).toBe('speech-100');

    if (process.env.PHASE0_PROFILER_REPORT === '1') {
      process.stdout.write(
        `ZHIYU_PHASE0_WORKSPACE_PROFILER ${JSON.stringify({
          schemaVersion: 1,
          baselineKind: 'workspace-integration',
          componentPolicy:
            'real WorkspaceShell, WorkspaceRail, WorkspaceChatPane, WorkspaceClassroomPane; external boundaries only mocked',
          mockedExternalBoundaries: [
            'Next navigation adapter',
            'stage persistence',
            'fetch',
            'EventSource',
            'IndexedDB',
            'browser observers and scheduling',
          ],
          runtime: {
            node: process.version,
            react: reactVersion,
            reactDom: reactDomVersion,
            platform: process.platform,
            arch: process.arch,
          },
          mode: 'vitest-jsdom-development-react',
          strictMode: false,
          syntheticViewport: 1366,
          fixedFixture: { sessionId: SESSION_ID, courseId: COURSE_ID, sceneId: SCENE_ID },
          eventSequenceVersion: 1,
          eventSequenceKind: 'fixed-stress-sequence',
          eventSequence: {
            iterations: EVENT_COUNT,
            perIteration: [
              'owner.session_status',
              'session.message_update',
              'session.tool_execution_end(generate_tts; no matching tool_start)',
            ],
          },
          scenario,
        })}\n`,
      );
    }
  }, 30_000);
});
