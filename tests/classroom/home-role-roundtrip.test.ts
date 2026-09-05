// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';
import ClassroomDetailPage from '@/app/classroom/[id]/page';

const boundary = vi.hoisted(() => ({
  stop: vi.fn(),
  generateRemaining: vi.fn(),
  retrySingleOutline: vi.fn(),
  classroomId: 'preset-course',
  router: { replace: vi.fn() },
}));

vi.mock('@/components/stage', () => ({ Stage: () => null }));
vi.mock('@/lib/store', async () => import('@/lib/store/stage'));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/hooks/use-scene-generator', () => ({ useSceneGenerator: () => boundary }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: boundary.classroomId }),
  useRouter: () => boundary.router,
}));
vi.mock('@/lib/classroom/stage-meta-client', () => ({
  fetchStageMeta: vi.fn().mockResolvedValue({ outcome: 'absent' }),
}));
vi.mock('@/lib/audio/agent-voice', () => ({ warmUpAgentVoices: vi.fn() }));
vi.mock('@/lib/utils/stage-storage', () => ({
  loadStageData: vi.fn().mockResolvedValue(null),
  saveStageDataIncremental: vi.fn().mockResolvedValue({ failedChanges: [] }),
}));
vi.mock('@/lib/classroom/load-classroom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classroom/load-classroom')>();
  return {
    ...actual,
    defaultClassroomLoadDeps: {
      ...actual.defaultClassroomLoadDeps,
      loadRestoredMediaTasks: vi.fn().mockResolvedValue({}),
      applyRestoredMediaTasks: vi.fn(),
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([]),
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each([
  { name: 'hosted classroom', Classroom: ClassroomSurface },
  {
    name: 'standalone classroom',
    Classroom: ({ classroomId }: { classroomId: string }) => {
      boundary.classroomId = classroomId;
      return createElement(ClassroomDetailPage);
    },
  },
])('Home role preferences across $name visits', ({ Classroom }) => {
  let container: HTMLDivElement;
  let root: Root;
  const initialSettings = useSettingsStore.getState();

  beforeEach(() => {
    boundary.router.replace.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useSettingsStore.setState(initialSettings);
    useStageStore.setState({
      stage: {
        id: 'preset-course',
        name: 'Existing course',
        createdAt: 1,
        updatedAt: 1,
        agentIds: ['default-1', 'default-4'],
        generatedAgentConfigs: [],
      },
      outlines: [],
      scenes: [],
      loadFromStorage: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useSettingsStore.setState(initialSettings);
    useStageStore.setState(useStageStore.getInitialState());
    // Legacy/local courses never enter the new server-job review route.
    expect(boundary.router.replace).not.toHaveBeenCalled();
  });

  it('restores the explicit auto choice after a preset classroom temporarily selects its roster', async () => {
    useSettingsStore.setState({
      agentMode: 'auto',
      selectedAgentIds: [],
      agentSelectionIsUserSet: true,
    });
    await act(async () => {
      root.render(createElement(Classroom, { classroomId: 'preset-course' }));
    });
    expect(useSettingsStore.getState()).toMatchObject({
      agentMode: 'preset',
      selectedAgentIds: ['default-1', 'default-4'],
      agentSelectionIsUserSet: false,
    });

    await act(async () => root.render(null));

    expect(useSettingsStore.getState()).toMatchObject({
      agentMode: 'auto',
      selectedAgentIds: [],
      agentSelectionIsUserSet: true,
    });
  });

  it.each([
    { agentMode: 'auto' as const, selectedAgentIds: [], agentSelectionIsUserSet: true },
    {
      agentMode: 'preset' as const,
      selectedAgentIds: ['default-1', 'default-3', 'default-5'],
      agentSelectionIsUserSet: true,
    },
    {
      agentMode: 'auto' as const,
      selectedAgentIds: ['default-1', 'default-2', 'default-3'],
      agentSelectionIsUserSet: false,
    },
  ])(
    'preserves $agentMode selection through Strict Mode and repeated visits',
    async (selection) => {
      useSettingsStore.setState(selection);
      for (let visit = 0; visit < 2; visit += 1) {
        await act(async () => {
          root.render(
            createElement(
              StrictMode,
              null,
              createElement(Classroom, { classroomId: 'preset-course' }),
            ),
          );
        });
        await act(async () => root.render(null));
        expect(useSettingsStore.getState()).toMatchObject(selection);
      }
    },
  );

  it('does not let a delayed classroom load overwrite the restored choice after leaving', async () => {
    let finishLoad!: () => void;
    const pendingLoad = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const selection = {
      agentMode: 'auto' as const,
      selectedAgentIds: [],
      agentSelectionIsUserSet: true,
    };
    useSettingsStore.setState(selection);
    useStageStore.setState({ loadFromStorage: () => pendingLoad });
    await act(async () => {
      root.render(createElement(Classroom, { classroomId: 'preset-course' }));
    });
    await act(async () => root.render(null));
    await act(async () => finishLoad());
    expect(useSettingsStore.getState()).toMatchObject(selection);
  });

  it.each(['preset', 'auto'] as const)(
    'keeps the Home %s choice after a course with generated roles',
    async (agentMode) => {
      const selection = {
        agentMode,
        selectedAgentIds: agentMode === 'preset' ? ['default-1', 'default-3', 'default-5'] : [],
        agentSelectionIsUserSet: true,
      };
      useSettingsStore.setState(selection);
      useStageStore.setState({
        stage: {
          id: 'generated-course',
          name: 'Generated course',
          createdAt: 1,
          updatedAt: 1,
          generatedAgentConfigs: [
            {
              id: 'gen-teacher',
              name: 'Course teacher',
              role: 'teacher',
              persona: 'Teach this course',
              avatar: '/avatars/teacher.png',
              color: '#123456',
              priority: 10,
            },
          ],
        },
      });
      await act(async () => {
        root.render(createElement(Classroom, { classroomId: 'generated-course' }));
      });
      expect(useSettingsStore.getState().selectedAgentIds).toEqual(
        agentMode === 'preset' ? ['default-1', 'default-3', 'default-5'] : ['gen-teacher'],
      );
      await act(async () => root.render(null));
      expect(useSettingsStore.getState()).toMatchObject(selection);
    },
  );

  it('cancels an error retry before its late result can replace the restored Home preference', async () => {
    let finishRetry!: () => void;
    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const selection = {
      agentMode: 'auto' as const,
      selectedAgentIds: [],
      agentSelectionIsUserSet: true,
    };
    useSettingsStore.setState(selection);
    const loadFromStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
      .mockImplementationOnce(() => pendingRetry);
    useStageStore.setState({ loadFromStorage });
    await act(async () => {
      root.render(createElement(Classroom, { classroomId: 'preset-course' }));
    });
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'common.retry',
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(loadFromStorage).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    await act(async () => finishRetry());
    expect(useSettingsStore.getState()).toMatchObject(selection);
  });
});
