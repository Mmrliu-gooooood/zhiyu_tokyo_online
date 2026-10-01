/**
 * The only place routes read model choice from a request (plan 3.3.1):
 * the legacy headers (`x-model`, `x-api-key`, `x-base-url`, `x-provider-type`,
 * `x-model-source`, `x-platform-default-id`), the new ones (`x-model-api`,
 * `x-model-credential-id`, `x-model-endpoint-profile`,
 * `x-model-endpoint-params`) and the body's `thinkingConfig` / `thinking`.
 *
 * Invalid input is returned, not thrown: a configured stage route ignores the
 * client's choice entirely (legacy order), so resolveBinding decides whether
 * the error matters.
 */
import type { ThinkingConfig } from '@/lib/types/provider';
import { ModelSelectionError } from './errors';
import { thinkingConfigSchema, upgradeLegacyModelParams, type ModelSelection } from './schema';

export interface RequestModelSelection {
  selection?: ModelSelection;
  error?: ModelSelectionError;
}

interface HeaderSource {
  headers: { get(name: string): string | null };
}

function header(req: HeaderSource, name: string): string | undefined {
  return req.headers.get(name)?.trim() || undefined;
}

/** Body `thinkingConfig` (or the legacy / eval field `thinking`). */
export function thinkingFromBody(body: unknown): ThinkingConfig | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { thinkingConfig?: unknown; thinking?: unknown };
  const config = record.thinkingConfig ?? record.thinking;
  if (!config || typeof config !== 'object') return undefined;
  const parsed = thinkingConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ModelSelectionError(
      'INVALID_MODEL_SELECTION',
      400,
      'Invalid thinking configuration.',
    );
  }
  return parsed.data;
}

function endpointParams(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, string>;
    }
  } catch {
    // fall through
  }
  throw new ModelSelectionError(
    'INVALID_MODEL_SELECTION',
    400,
    'Invalid model endpoint parameters.',
  );
}

export function readModelSelection(
  req: HeaderSource,
  body?: unknown,
  thinkingOverride?: ThinkingConfig,
): RequestModelSelection {
  try {
    return {
      selection: upgradeLegacyModelParams({
        modelString: header(req, 'x-model'),
        apiKey: header(req, 'x-api-key'),
        baseUrl: header(req, 'x-base-url'),
        providerType: header(req, 'x-provider-type'),
        api: header(req, 'x-model-api'),
        source: header(req, 'x-model-source'),
        platformDefaultId: header(req, 'x-platform-default-id'),
        credentialId: header(req, 'x-model-credential-id'),
        endpointProfile: header(req, 'x-model-endpoint-profile'),
        endpointParams: endpointParams(header(req, 'x-model-endpoint-params')),
        thinkingConfig: thinkingOverride ?? thinkingFromBody(body),
      }),
    };
  } catch (error) {
    if (error instanceof ModelSelectionError) return { error };
    throw error;
  }
}
