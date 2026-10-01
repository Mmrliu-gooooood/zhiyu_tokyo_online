/**
 * ModelSelection: the client's model intent, validated server-side (plan
 * 3.3.1), and the pure upgrader from the legacy wire / persisted shape
 * (request headers, PRO connection v1, generation snapshots v1/v2), which all
 * carry the same flat `modelString / apiKey / baseUrl / providerType / api /
 * source / platformDefaultId` fields.
 *
 * Deliberate refinement of the plan's type: `legacy-managed` may carry the
 * client connection, because legacy semantics use it when the operator has
 * NOT configured that provider (server config always wins when it has).
 */
import { z } from 'zod';
import type { ThinkingConfig } from '@/lib/types/provider';
import { apiForLegacyProviderType, getDescriptor } from '../catalog/descriptors';
import type { WireApi } from '../types';
import { ModelSelectionError } from './errors';

export const WIRE_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'azure-openai-responses',
  'bedrock-converse-stream',
] as const satisfies readonly WireApi[];

export const thinkingConfigSchema = z
  .object({
    mode: z.enum(['default', 'disabled', 'enabled', 'auto']).optional(),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    level: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    enabled: z.boolean().optional(),
    budgetTokens: z.number().int().min(-1).max(1_000_000).optional(),
    excludeReasoningOutput: z.boolean().optional(),
  })
  .strict();

const PARAM_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const PARAM_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

const endpointParamsSchema = z
  .record(z.string().regex(PARAM_NAME), z.string().regex(PARAM_VALUE))
  .refine((value) => Object.keys(value).length <= 4, 'too many endpoint params');

const baseUrlSchema = z.string().trim().min(1).max(2_048).url();
const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const modelIdSchema = z.string().trim().min(1).max(500);

export const userConnectionSchema = z.discriminatedUnion('auth', [
  z
    .object({
      auth: z.literal('api-key'),
      /** May be empty: the binding then reports `credentialReady: false`. */
      apiKey: z.string().max(16_384),
      baseUrl: baseUrlSchema.optional(),
      api: z.enum(WIRE_APIS).optional(),
      endpointProfile: z.string().max(64).optional(),
      endpointParams: endpointParamsSchema.optional(),
    })
    .strict(),
  z
    .object({
      auth: z.literal('credential'),
      credentialId: z.string().uuid(),
      endpointProfile: z.string().max(64).optional(),
    })
    .strict(),
  z
    .object({
      auth: z.literal('none'),
      baseUrl: baseUrlSchema.optional(),
      api: z.enum(WIRE_APIS).optional(),
    })
    .strict(),
]);

export const modelSelectionSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('platform'),
      defaultId: z.string().trim().min(1).max(200),
      revision: z.string().trim().min(1).max(500).optional(),
      thinking: thinkingConfigSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal('legacy-managed'),
      providerId: providerIdSchema,
      modelId: modelIdSchema,
      /** Used only when the operator has not configured this provider. */
      connection: userConnectionSchema.optional(),
      thinking: thinkingConfigSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal('user'),
      providerId: providerIdSchema,
      modelId: modelIdSchema,
      connection: userConnectionSchema,
      thinking: thinkingConfigSchema.optional(),
    })
    .strict(),
]);

export type UserConnection = z.infer<typeof userConnectionSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * Legacy flat model fields (request headers, PRO connection v1, generation
 * snapshot v1/v2 content). Values are untrusted.
 */
export interface LegacyModelParams {
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  api?: string;
  source?: string;
  platformDefaultId?: string;
  defaultId?: string;
  revision?: string;
  thinkingConfig?: ThinkingConfig;
  /** New wire fields (x-model-credential-id, x-model-endpoint-profile, …). */
  credentialId?: string;
  endpointProfile?: string;
  endpointParams?: Record<string, string>;
}

/** `provider:model`; a bare id is the deprecated OpenAI default (legacy parseModelString). */
export function parseModelString(modelString: string): { providerId: string; modelId: string } {
  const colon = modelString.indexOf(':');
  return colon > 0
    ? { providerId: modelString.slice(0, colon), modelId: modelString.slice(colon + 1) }
    : { providerId: 'openai', modelId: modelString };
}

function invalidSource(message: string): ModelSelectionError {
  return new ModelSelectionError('INVALID_MODEL_SOURCE', 400, message);
}

function connectionFrom(params: LegacyModelParams, providerId: string): UserConnection {
  const descriptor = getDescriptor(providerId);
  // Unknown dialect strings were ignored by the legacy adapter; keep that leniency.
  const requestedApi = (WIRE_APIS as readonly string[]).includes(params.api ?? '')
    ? (params.api as WireApi)
    : undefined;
  const api =
    requestedApi ?? (descriptor ? undefined : apiForLegacyProviderType(params.providerType));
  if (params.credentialId && params.apiKey) {
    throw invalidSource('A model selection cannot carry both an API key and a credential.');
  }
  if (params.credentialId) {
    return {
      auth: 'credential',
      credentialId: params.credentialId,
      ...(params.endpointProfile ? { endpointProfile: params.endpointProfile } : {}),
    };
  }
  if (descriptor?.auth.includes('none') && !params.apiKey) {
    return {
      auth: 'none',
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(api ? { api } : {}),
    };
  }
  return {
    auth: 'api-key',
    apiKey: params.apiKey ?? '',
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(api ? { api } : {}),
    ...(params.endpointProfile ? { endpointProfile: params.endpointProfile } : {}),
    ...(params.endpointParams ? { endpointParams: params.endpointParams } : {}),
  };
}

/**
 * Upgrade legacy flat fields to a validated selection. Mirrors the unrouted
 * branch of the legacy resolver: `undefined` means "no client choice" (the
 * resolver then uses DEFAULT_MODEL). Throws ModelSelectionError (400) for the
 * same inputs the legacy resolver rejected.
 */
export function upgradeLegacyModelParams(params: LegacyModelParams): ModelSelection | undefined {
  const source = params.source;
  if (source && source !== 'platform' && source !== 'user' && source !== 'legacy-managed') {
    throw invalidSource(`Invalid model source: ${source}`);
  }
  if (params.platformDefaultId && source !== 'platform') {
    throw invalidSource('A platform default ID can only be used with the platform model source.');
  }
  const thinking = params.thinkingConfig;

  let candidate: unknown;
  if (source === 'platform') {
    const defaultId = params.platformDefaultId || params.defaultId;
    if (!defaultId)
      throw invalidSource('A platform model selection requires a platform default ID.');
    candidate = {
      source,
      defaultId,
      ...(params.revision ? { revision: params.revision } : {}),
      ...(thinking ? { thinking } : {}),
    };
  } else {
    const modelString = params.modelString?.trim();
    if (!modelString) return undefined;
    if (modelString.startsWith('platform:')) {
      if (source === 'user') {
        throw invalidSource('A user model selection cannot reference a platform default.');
      }
      candidate = {
        source: 'platform',
        defaultId: modelString.slice('platform:'.length),
        ...(params.revision ? { revision: params.revision } : {}),
        ...(thinking ? { thinking } : {}),
      };
    } else {
      const { providerId, modelId } = parseModelString(modelString);
      const descriptor = getDescriptor(providerId);
      const expectedType = descriptor?.legacyProviderType;
      if (params.providerType && expectedType && params.providerType !== expectedType) {
        throw new ModelSelectionError(
          'INVALID_MODEL_SELECTION',
          400,
          `Provider type mismatch for ${providerId}: expected ${expectedType}, received ${params.providerType}.`,
        );
      }
      const hasConnection = Boolean(
        params.apiKey || params.baseUrl || params.api || params.providerType || params.credentialId,
      );
      candidate = {
        source: source === 'user' ? 'user' : 'legacy-managed',
        providerId,
        modelId,
        ...(source === 'user' || hasConnection
          ? { connection: connectionFrom(params, providerId) }
          : {}),
        ...(thinking ? { thinking } : {}),
      };
    }
  }
  const parsed = modelSelectionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ModelSelectionError('INVALID_MODEL_SELECTION', 400, 'Invalid model selection.');
  }
  return parsed.data;
}
