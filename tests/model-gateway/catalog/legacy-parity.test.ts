/**
 * P2-2 / P3-6: the client catalog must not regress the 19 pre-gateway
 * providers. The legacy catalog (lib/ai/providers.ts + model-metadata.ts) was
 * deleted in P3-6 after being frozen into
 * tests/fixtures/model-gateway/legacy-catalog.json; this compares against that
 * snapshot: provider fields, model id sets, every model entry (covers the
 * behavior-checklist catalog items CT-01…CT-06), and every reviewed thinking
 * capability (including manual-id-only entries, aliases and fallbacks).
 */
import { describe, expect, it } from 'vitest';
import legacyCatalog from '@/tests/fixtures/model-gateway/legacy-catalog.json';
import { CLIENT_PROVIDERS, PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';
import { LEGACY_PROVIDER_IDS, PROVIDER_DESCRIPTORS } from '@/lib/model-gateway/catalog/descriptors';
import {
  deriveThinkingCapability,
  reviewedThinkingCapability,
} from '@/lib/model-gateway/catalog/thinking-capability';
import { PI_PROVIDER_IDS } from '@/lib/model-gateway/runtime/pi-registry';

const LEGACY = legacyCatalog.providers as Record<string, Record<string, unknown>>;
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

/**
 * Deliberate changes to a legacy provider since the snapshot, each asserted
 * with its new value. Atlas Cloud had no logo in the legacy catalog.
 */
const INTENDED_CHANGES: Readonly<Record<string, Record<string, unknown>>> = {
  atlascloud: { icon: '/logos/atlascloud.svg' },
};

function pickFields(source: object): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(
    LEGACY_FIELDS.filter((field) => record[field] !== undefined).map((field) => [
      field,
      record[field],
    ]),
  );
}

describe('client catalog parity with the frozen legacy catalog', () => {
  it('lists exactly the 19 legacy providers as legacy ids (and as PROVIDERS)', () => {
    expect([...LEGACY_PROVIDER_IDS].sort()).toEqual(Object.keys(LEGACY).sort());
    expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(LEGACY).sort());
  });

  it.each([...LEGACY_PROVIDER_IDS])('%s keeps every provider field and model entry', (id) => {
    const legacy = LEGACY[id]!;
    const next = CLIENT_PROVIDERS[id]!;
    expect(pickFields(next)).toEqual(pickFields({ ...legacy, ...INTENDED_CHANGES[id] }));
    // Undefined meant "discovery available" in the legacy UI (`!== false`).
    expect(next.supportsModelDiscovery !== false).toBe(legacy.supportsModelDiscovery !== false);
  });

  it('keeps every reviewed thinking capability, including manual-id-only entries', () => {
    expect(legacyCatalog.thinking.length).toBeGreaterThan(50);
    for (const { providerId, modelId, capability } of legacyCatalog.thinking) {
      expect(reviewedThinkingCapability(providerId, modelId), `${providerId}:${modelId}`).toEqual(
        capability ?? undefined,
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
