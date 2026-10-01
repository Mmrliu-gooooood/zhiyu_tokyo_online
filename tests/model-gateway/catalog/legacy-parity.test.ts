/**
 * P2-2: the new client catalog must not regress the 19 pre-gateway providers.
 * Until the legacy catalog is deleted (P3-6) this compares against it
 * directly: provider fields, model id sets, every model entry, and every
 * reviewed thinking capability (including manual-id-only entries).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/ai/providers';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import { CLIENT_PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';
import { LEGACY_PROVIDER_IDS, PROVIDER_DESCRIPTORS } from '@/lib/model-gateway/catalog/descriptors';
import {
  deriveThinkingCapability,
  reviewedThinkingCapability,
} from '@/lib/model-gateway/catalog/thinking-capability';
import { PI_PROVIDER_IDS } from '@/lib/model-gateway/runtime/pi-registry';

const LEGACY_FIELDS = [
  'id',
  'name',
  'type',
  'defaultBaseUrl',
  'baseUrlPlaceholder',
  'alternateBaseUrls',
  'requiresApiKey',
  'icon',
  'models',
] as const;

function pickFields(source: object): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(
    LEGACY_FIELDS.filter((field) => record[field] !== undefined).map((field) => [
      field,
      record[field],
    ]),
  );
}

describe('client catalog parity with the legacy catalog (P2-2)', () => {
  it('lists exactly the 19 legacy providers as legacy ids', () => {
    expect([...LEGACY_PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it.each([...LEGACY_PROVIDER_IDS])('%s keeps every provider field and model entry', (id) => {
    const legacy = PROVIDERS[id];
    const next = CLIENT_PROVIDERS[id]!;
    expect(pickFields(next)).toEqual(pickFields(legacy));
    // Undefined meant "discovery available" in the legacy UI (`!== false`).
    expect(next.supportsModelDiscovery !== false).toBe(legacy.supportsModelDiscovery !== false);
  });

  it('keeps every reviewed thinking capability, including manual-id-only entries', () => {
    const source = readFileSync('lib/ai/model-metadata.ts', 'utf8');
    const keys = [...source.matchAll(/getModelMetadataKey\('([^']+)', '([^']+)'\)/g)];
    expect(keys.length).toBeGreaterThan(50);
    for (const [, providerId, modelId] of keys) {
      expect(reviewedThinkingCapability(providerId!, modelId!), `${providerId}:${modelId}`).toEqual(
        getCatalogThinkingCapability(providerId!, modelId!),
      );
    }
    // Aliases and the Lemonade provider-wide fallback.
    for (const [providerId, modelId] of [
      ['openai', 'gpt-5.6-sol'],
      ['lemonade', 'some-local-model-GGUF'],
      ['deepseek', 'not-a-catalog-model'],
    ] as const) {
      expect(reviewedThinkingCapability(providerId, modelId)).toEqual(
        getCatalogThinkingCapability(providerId, modelId),
      );
    }
  });
});

describe('descriptors and new providers', () => {
  it('maps every pi-backed descriptor to a provider the registry can load', () => {
    for (const descriptor of Object.values(PROVIDER_DESCRIPTORS)) {
      if (descriptor.upstream.kind !== 'pi') continue;
      expect(PI_PROVIDER_IDS, descriptor.id).toContain(descriptor.upstream.piProviderId);
      for (const profile of Object.values(descriptor.upstream.profiles ?? {})) {
        expect(PI_PROVIDER_IDS, descriptor.id).toContain(profile.piProviderId);
      }
    }
  });

  it('gives every new API-key provider a non-empty model list', () => {
    for (const config of Object.values(CLIENT_PROVIDERS)) {
      if ((LEGACY_PROVIDER_IDS as readonly string[]).includes(config.id)) continue;
      expect(config.models.length, config.id).toBeGreaterThan(0);
      expect(config.name, config.id).toBeTruthy();
    }
  });

  it('marks operator-only providers as not user-configurable', () => {
    expect(CLIENT_PROVIDERS.bedrock?.userConfigurable).toBe(false);
    expect(CLIENT_PROVIDERS['google-vertex']?.userConfigurable).toBe(false);
    expect(CLIENT_PROVIDERS.google?.allowCustomBaseUrl).toBe(false);
  });

  it('derives an effort capability from pi data for unreviewed models', () => {
    expect(deriveThinkingCapability({ reasoning: false })).toBeUndefined();
    expect(
      deriveThinkingCapability({
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
      }),
    ).toMatchObject({
      control: 'effort',
      effortValues: ['none', 'low', 'high', 'max'],
      defaultEffort: 'max',
      toggleable: true,
    });
    expect(
      deriveThinkingCapability({ reasoning: true, thinkingLevelMap: { off: null } }),
    ).toMatchObject({
      effortValues: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      toggleable: false,
    });
  });
});
