/**
 * Route-facing shortcuts over readModelSelection + resolveBinding. They replace
 * the legacy resolveModelFromRequest / resolveModelFromHeaders / resolveModel
 * entry points with the same resolution order (stage route > client choice >
 * DEFAULT_MODEL).
 */
import type { ThinkingConfig } from '@/lib/types/provider';
import type { ModelBinding } from '../types';
import { ModelSelectionError } from './errors';
import { readModelSelection, type RequestModelSelection } from './read-request';
import { resolveBinding } from './resolve-binding';
import { thinkingConfigSchema, upgradeLegacyModelParams, type LegacyModelParams } from './schema';

interface HeaderSource {
  headers: { get(name: string): string | null };
}

/** Headers + body thinking (`thinkingConfig` / `thinking`), as resolveModelFromRequest did. */
export function resolveRequestBinding(
  req: HeaderSource,
  body?: unknown,
  stage?: string,
): Promise<ModelBinding> {
  return resolveBinding({ request: readModelSelection(req, body), stage });
}

/** Headers with an explicit thinking config, as resolveModelFromHeaders did. */
export function resolveHeaderBinding(
  req: HeaderSource,
  stage?: string,
  thinking?: ThinkingConfig,
): Promise<ModelBinding> {
  return resolveBinding({ request: readModelSelection(req, undefined, thinking), stage });
}

/**
 * Flat legacy fields (request body, PRO connection context, generation job
 * input) as a deferred request selection. Errors surface only when no stage
 * route overrides the client's choice.
 */
export function selectionFromParams(params: LegacyModelParams): RequestModelSelection {
  try {
    let thinking: ThinkingConfig | undefined;
    if (params.thinkingConfig) {
      const parsed = thinkingConfigSchema.safeParse(params.thinkingConfig);
      if (!parsed.success) {
        throw new ModelSelectionError(
          'INVALID_MODEL_SELECTION',
          400,
          'Invalid thinking configuration.',
        );
      }
      thinking = parsed.data;
    }
    const selection = upgradeLegacyModelParams({ ...params, thinkingConfig: thinking });
    return { ...(selection ? { selection } : {}), ...(thinking ? { thinking } : {}) };
  } catch (error) {
    if (error instanceof ModelSelectionError) return { error };
    throw error;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Object-shaped values pass through; the selection schema validates their entries. */
function objectValue(value: unknown): Record<string, string> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : undefined;
}

/**
 * The model-selection fields of a JSON request body (/api/chat, coach,
 * teach-back): the body counterpart of the request headers.
 */
export function modelParamsFromBody(body: object): LegacyModelParams {
  const raw = body as Record<string, unknown>;
  const thinking = raw.thinkingConfig ?? raw.thinking;
  return {
    modelString: optionalString(raw.model),
    apiKey: optionalString(raw.apiKey),
    baseUrl: optionalString(raw.baseUrl),
    providerType: optionalString(raw.providerType),
    source: optionalString(raw.modelSource),
    platformDefaultId: optionalString(raw.platformDefaultId),
    api: optionalString(raw.api),
    endpointProfile: optionalString(raw.endpointProfile) || undefined,
    endpointParams: objectValue(raw.endpointParams),
    credentialId: optionalString(raw.credentialId) || undefined,
    thinkingConfig:
      thinking && typeof thinking === 'object' ? (thinking as ThinkingConfig) : undefined,
  };
}

/** resolveModel({ ...params, stage }) equivalent. */
export function resolveParamsBinding(
  params: LegacyModelParams = {},
  stage?: string,
): Promise<ModelBinding> {
  return resolveBinding({ request: selectionFromParams(params), stage });
}
