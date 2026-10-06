/**
 * homeAgentSelectionDuringVisit: a classroom visit borrows the shared agent
 * selection for playback. The Home choice is persisted while the visit is
 * open, so a reload or closed tab (no unmount) still restores it.
 *
 * A "reload" is a fresh module import over the same stubbed storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const persistKv = new BrowserKVStore({ storage: localStorageStub as unknown as Storage });

async function loadPage(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  if (persistedState) {
    await persistKv.set('settings-storage', { state: persistedState, version: 7 }, 'account');
  }
  const settings = await import('@/lib/store/settings');
  await settings.useSettingsStore.persist.rehydrate();
  return settings;
}

async function persistedState(): Promise<Record<string, unknown>> {
  const blob = await persistKv.get<{ state: Record<string, unknown> }>(
    'settings-storage',
    'account',
  );
  return blob?.state ?? {};
}

const home = {
  agentMode: 'preset' as const,
  selectedAgentIds: ['default-1', 'cm-0123456789abcdef'],
  agentSelectionIsUserSet: true,
};
const classroomRoster = {
  agentMode: 'auto' as const,
  selectedAgentIds: ['gen-teacher', 'gen-student'],
  agentSelectionIsUserSet: false,
};

describe('Home agent selection across classroom visits', () => {
  beforeEach(() => storage.clear());

  it('restores the Home choice on the next load after a visit ended without unmounting', async () => {
    const { useSettingsStore, beginClassroomAgentVisit } = await loadPage(home);
    beginClassroomAgentVisit();
    useSettingsStore.setState(classroomRoster);
    await vi.waitFor(async () => {
      expect(await persistedState()).toMatchObject({
        ...classroomRoster,
        homeAgentSelectionDuringVisit: home,
      });
    });

    // Reload / closed tab: no cleanup ran.
    const next = await loadPage();
    expect(next.useSettingsStore.getState()).toMatchObject({
      ...home,
      homeAgentSelectionDuringVisit: null,
    });
  });

  it('ends a visit by putting the Home choice back', async () => {
    const { useSettingsStore, beginClassroomAgentVisit } = await loadPage(home);
    const end = beginClassroomAgentVisit();
    useSettingsStore.setState(classroomRoster);
    end();
    end();
    expect(useSettingsStore.getState()).toMatchObject({
      ...home,
      homeAgentSelectionDuringVisit: null,
    });
  });

  it('keeps the Home choice recorded by an earlier visit that never ended', async () => {
    // Reloading the classroom itself: the load restores Home first, then the
    // new visit records it again — never the previous classroom's roster.
    await loadPage({ ...classroomRoster, homeAgentSelectionDuringVisit: home });
    const { useSettingsStore, beginClassroomAgentVisit } = await loadPage();
    const end = beginClassroomAgentVisit();
    expect(useSettingsStore.getState().homeAgentSelectionDuringVisit).toEqual(home);
    useSettingsStore.setState(classroomRoster);
    end();
    expect(useSettingsStore.getState()).toMatchObject(home);
  });

  it('does not replace an open visit roster on a mid-visit rehydrate', async () => {
    const { useSettingsStore, beginClassroomAgentVisit } = await loadPage(home);
    const end = beginClassroomAgentVisit();
    useSettingsStore.setState(classroomRoster);
    await vi.waitFor(async () => {
      expect((await persistedState()).agentMode).toBe('auto');
    });
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      ...classroomRoster,
      homeAgentSelectionDuringVisit: home,
    });
    end();
    expect(useSettingsStore.getState()).toMatchObject(home);
  });

  it('ignores a malformed recorded selection', async () => {
    const { useSettingsStore } = await loadPage({
      ...classroomRoster,
      homeAgentSelectionDuringVisit: { agentMode: 'other', selectedAgentIds: 'x' },
    });
    expect(useSettingsStore.getState()).toMatchObject({
      ...classroomRoster,
      homeAgentSelectionDuringVisit: null,
    });
  });
});
