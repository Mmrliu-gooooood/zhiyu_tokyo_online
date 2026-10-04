'use client';

import { createLogger } from '@/lib/logger';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';

const log = createLogger('AccountStores');

let hydratedUserId: string | undefined;

/**
 * Re-read every account-scoped persisted store once the signed-in account is
 * known. Their KV namespace comes from the account, so the read they attempt
 * at module load either fails (hosted: no namespace yet) or reads the signed-out
 * namespace. Called before account UI mounts, so nothing writes into a store
 * that has not hydrated from the right namespace. Once per account: the shell
 * re-checks the account on every navigation.
 */
export async function rehydrateAccountStores(userId: string): Promise<void> {
  if (hydratedUserId === userId) return;
  const results = await Promise.allSettled([
    useSettingsStore.persist.rehydrate(),
    useUserProfileStore.persist.rehydrate(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      log.error('Could not rehydrate an account store:', result.reason);
    }
  }
  hydratedUserId = userId;
}
