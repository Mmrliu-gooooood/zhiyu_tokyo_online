/**
 * Plan P4-4 / 3.14: the generation config digest pins only server-side
 * provider configuration. A catalog update (new pi data) and a subscription
 * token refresh must not change it, or every in-flight job would fail with
 * GENERATION_CONFIG_CHANGED. Model snapshots hold a credential reference,
 * never the token, so a refresh leaves them (and their intent digest) as is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@/lib/model-gateway';

const CREDENTIAL_ID = '6f1c2e9a-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

async function digestWith(catalogVersion?: string): Promise<{
  digest: string;
  requestHash: string;
}> {
  vi.resetModules();
  if (catalogVersion) {
    vi.doMock('@/lib/model-gateway/catalog/client-catalog', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/model-gateway/catalog/client-catalog')>()),
      CATALOG_VERSION: catalogVersion,
    }));
  }
  const { generationProviderConfigVersion, generationRequestHash } =
    await import('@/lib/server/generation-jobs/config-snapshot');
  const { parseGenerationInput } = await import('@/lib/server/generation-jobs/contracts');
  const input = parseGenerationInput({
    version: 1,
    requirements: { requirement: 'stable digest' },
    model: { source: 'user', modelString: 'openai:gpt-5.4' },
    modelConfigRef: { id: CREDENTIAL_ID, revision: 1 },
  });
  return { digest: generationProviderConfigVersion(), requestHash: generationRequestHash(input) };
}

afterEach(() => {
  vi.doUnmock('@/lib/model-gateway/catalog/client-catalog');
  vi.unstubAllEnvs();
});

describe('generation config digest stability', () => {
  it('does not change when the model catalog version changes', async () => {
    const before = await digestWith();
    const after = await digestWith('9.9.9+0000000000000000');
    expect(after).toEqual(before);
  });

  it('a credential-backed snapshot carries no token, so a refresh changes nothing', async () => {
    vi.stubEnv('GENERATION_MODEL_ENCRYPTION_KEY', '11'.repeat(32));
    const { generationModelSnapshotContent, sealGenerationModelSnapshot } =
      await import('@/lib/server/generation-model-snapshots');
    const selection: ModelSelection = {
      source: 'user',
      providerId: 'github-copilot',
      modelId: 'gpt-5.4',
      connection: { auth: 'credential', credentialId: CREDENTIAL_ID },
    };
    const ref = { id: CREDENTIAL_ID, revision: 1 };
    // The vault row's token rotates on refresh; the snapshot input is the same reference.
    const beforeRefresh = generationModelSnapshotContent({ selection });
    const afterRefresh = generationModelSnapshotContent({ selection: { ...selection } });
    expect(afterRefresh).toEqual(beforeRefresh);
    expect(JSON.stringify(beforeRefresh)).not.toMatch(/token|apiKey/i);
    expect(sealGenerationModelSnapshot(afterRefresh, 'owner-a', ref).intentDigest).toBe(
      sealGenerationModelSnapshot(beforeRefresh, 'owner-a', ref).intentDigest,
    );
    const { digest } = await digestWith();
    expect(digest).toBe((await digestWith()).digest);
  });

  it('still changes when server provider configuration changes', async () => {
    const before = await digestWith();
    vi.stubEnv('DEFAULT_MODEL', 'deepseek:deepseek-flash-changed');
    const after = await digestWith();
    expect(after.digest).not.toBe(before.digest);
    expect(after.requestHash).toBe(before.requestHash);
  });
});
