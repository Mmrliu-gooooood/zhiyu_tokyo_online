import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cloud course library gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('stays tied to Pro runtime in legacy mode', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://local');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', '');
    const { isCloudCourseLibraryEnabled, isAgentRuntimeConfigured } = await import(
      '@/lib/config/feature-flags'
    );
    expect(isAgentRuntimeConfigured()).toBe(false);
    expect(isCloudCourseLibraryEnabled()).toBe(false);
  });

  it('keeps /api/stages available when hosted even if Pro is off', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://local');
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', '');
    const { isCloudCourseLibraryEnabled, isAgentRuntimeConfigured } = await import(
      '@/lib/config/feature-flags'
    );
    expect(isAgentRuntimeConfigured()).toBe(false);
    expect(isCloudCourseLibraryEnabled()).toBe(true);
  });
});
