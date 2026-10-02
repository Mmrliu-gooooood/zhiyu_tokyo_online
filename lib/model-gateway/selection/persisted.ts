/**
 * Persisted model selections (plan 3.14): generation snapshot v3 and PRO
 * connection v2 store a validated ModelSelection instead of the legacy flat
 * `modelString / apiKey / providerType / api` fields. Secrets stay inside the
 * encrypted envelope of their store; this module only defines the shape and
 * how a stored selection becomes a resolver request.
 */
import { ModelSelectionError } from './errors';
import { isTextPlatformDefaultId } from './platform';
import type { RequestModelSelection } from './read-request';
import { selectionFromParams } from './request-binding';
import {
  modelSelectionSchema,
  thinkingConfigSchema,
  type LegacyModelParams,
  type ModelSelection,
} from './schema';

/**
 * Version of the gateway's execution contract (request codec, thinking
 * mapping, usage semantics) recorded next to persisted selections. Bump it
 * when a change would make an in-flight job behave differently on resume.
 */
export const GATEWAY_VERSION = 'model-gateway/1';

/** Marker for selections upgraded from data written before the gateway. */
export const LEGACY_SELECTION_VERSION = 'legacy';

/**
 * A stored selection: platform selections name a text platform default and
 * pin the revision they were accepted at.
 */
export const persistedSelectionSchema = modelSelectionSchema.superRefine((selection, context) => {
  if (selection.source !== 'platform') return;
  if (!isTextPlatformDefaultId(selection.defaultId)) {
    context.addIssue({ code: 'custom', message: 'Not a text platform default' });
  }
  if (!selection.revision) {
    context.addIssue({ code: 'custom', message: 'Platform selection requires a revision' });
  }
});

export function selectionModelString(selection: ModelSelection): string {
  return selection.source === 'platform'
    ? `platform:${selection.defaultId}`
    : `${selection.providerId}:${selection.modelId}`;
}

/**
 * Resolver request for a run: the stored selection when there is one (its
 * thinking wins, the job's thinking fills in), otherwise the job's own flat
 * model fields.
 */
export function storedSelectionRequest(
  stored: ModelSelection | undefined,
  fallback: LegacyModelParams = {},
): RequestModelSelection {
  if (!stored) return selectionFromParams(fallback);
  if (stored.thinking || !fallback.thinkingConfig) return { selection: stored };
  const thinking = thinkingConfigSchema.safeParse(fallback.thinkingConfig);
  if (!thinking.success) {
    return {
      error: new ModelSelectionError(
        'INVALID_MODEL_SELECTION',
        400,
        'Invalid thinking configuration.',
      ),
    };
  }
  return { selection: { ...stored, thinking: thinking.data } };
}
