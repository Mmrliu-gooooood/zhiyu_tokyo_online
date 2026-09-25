import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_POOL_DEFAULTS } from '@/lib/db/app-pool';
import { generationConfig } from '@/lib/server/generation-jobs/config';

describe('Pro lease deployment settings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_LEASE_TTL_MS', undefined);
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_HEARTBEAT_MS', undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('preserves the legacy lease and heartbeat defaults', async () => {
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig).toMatchObject({ leaseTtlMs: 10_000, heartbeatIntervalMs: 2_000 });
  });

  it('gives every Supabase claimant and admission reader the same remote-DB margin', async () => {
    const compose = load(readFileSync('docker-compose.supabase.yml', 'utf8')) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const ordinary = generationConfig({ NODE_ENV: 'test' });
    for (const service of ['openmaic', 'generation-worker', 'supabase-readiness']) {
      const environment = compose.services[service]!.environment;
      vi.stubEnv(
        'OPENMAIC_AGENT_RUNTIME_LEASE_TTL_MS',
        environment.OPENMAIC_AGENT_RUNTIME_LEASE_TTL_MS,
      );
      vi.stubEnv(
        'OPENMAIC_AGENT_RUNTIME_HEARTBEAT_MS',
        environment.OPENMAIC_AGENT_RUNTIME_HEARTBEAT_MS,
      );
      vi.resetModules();
      const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
      expect(agentRuntimeConfig.leaseTtlMs).toBe(90_000);
      expect(agentRuntimeConfig.heartbeatIntervalMs).toBe(10_000);
      expect(agentRuntimeConfig.leaseTtlMs).toBe(ordinary.leaseMs);
      expect(agentRuntimeConfig.heartbeatIntervalMs).toBe(ordinary.heartbeatMs);
      expect(agentRuntimeConfig.leaseTtlMs).toBeGreaterThan(
        3 * agentRuntimeConfig.heartbeatIntervalMs + HOSTED_POOL_DEFAULTS.connectionTimeoutMillis!,
      );
    }
  });
});
