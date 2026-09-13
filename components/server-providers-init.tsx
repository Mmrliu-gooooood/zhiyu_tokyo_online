'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    // Account settings hydrate asynchronously and can restore an older catalog
    // after the mount request, or invalidate that request while it is in flight.
    // Refresh after hydration so new runs always bind the current model revision.
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      void fetchServerProviders();
    });
    void fetchServerProviders();
    return unsubscribe;
  }, [fetchServerProviders]);

  return null;
}
