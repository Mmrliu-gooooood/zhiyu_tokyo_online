/**
 * Hosted mode: account-scoped stores cannot read at module load (the account
 * namespace is unknown until /api/auth/me answers). The shell rehydrates them
 * once the account is known, before account UI mounts and writes to them, so
 * the stored value is loaded and later writes are admitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const backing = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => void backing.set(k, v),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const USER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const accountKv = new BrowserKVStore({
  storage: localStorageStub,
  namespace: `zhiyu:openmaic:${USER_ID}`,
});

beforeEach(() => {
  backing.clear();
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
  vi.stubEnv('AUTH_MODE', 'supabase');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedAccount() {
  const settings = await import('@/lib/store/settings');
  const persistVersion = settings.useSettingsStore.persist.getOptions().version ?? 0;
  await accountKv.set(
    'settings-storage',
    { state: { playbackSpeed: 1.75 }, version: persistVersion },
    'account',
  );
  await accountKv.set(
    'user-profile-storage',
    { state: { nickname: '小林' }, version: 0 },
    'account',
  );
}

describe('rehydrateAccountStores', () => {
  it('loads the account namespace before account UI writes', async () => {
    await seedAccount();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { useSettingsStore } = await import('@/lib/store/settings');
    const { useUserProfileStore } = await import('@/lib/store/user-profile');
    const { setAccountUserId } = await import('@/lib/auth/account-environment');
    const { rehydrateAccountStores } = await import('@/lib/store/account-stores');

    // Module-load hydration could not run: still defaults.
    expect(useSettingsStore.getState().playbackSpeed).not.toBe(1.75);
    expect(useUserProfileStore.getState().nickname).toBe('');

    setAccountUserId(USER_ID);
    await rehydrateAccountStores(USER_ID);

    expect(useSettingsStore.getState().playbackSpeed).toBe(1.75);
    expect(useUserProfileStore.getState().nickname).toBe('小林');

    useSettingsStore.getState().setPlaybackSpeed(1.25);
    await vi.waitFor(async () => {
      const blob = await accountKv.get<{ state: { playbackSpeed: number } }>(
        'settings-storage',
        'account',
      );
      expect(blob?.state.playbackSpeed).toBe(1.25);
    });
    const refused = errors.mock.calls.filter((call) =>
      call.some((part) => String(part).includes('Refusing to persist')),
    );
    expect(refused).toEqual([]);
  });

  it('rehydrates once per account', async () => {
    await seedAccount();
    const { useSettingsStore } = await import('@/lib/store/settings');
    const { setAccountUserId } = await import('@/lib/auth/account-environment');
    const { rehydrateAccountStores } = await import('@/lib/store/account-stores');
    const rehydrate = vi.spyOn(useSettingsStore.persist, 'rehydrate');

    setAccountUserId(USER_ID);
    await rehydrateAccountStores(USER_ID);
    await rehydrateAccountStores(USER_ID);

    expect(rehydrate).toHaveBeenCalledTimes(1);
  });
});
