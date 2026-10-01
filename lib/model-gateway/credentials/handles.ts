/**
 * Credential handles are kept in a module-private WeakMap keyed by the frozen
 * binding, so JSON.stringify, object spread and logging never see them
 * (plan D10).
 */
import { createHash } from 'node:crypto';
import type { ModelBinding, TextPlatformDefaultId, ThinkingConfig } from '../types';

export type CredentialHandle =
  | { kind: 'inline-key'; apiKey: string }
  | { kind: 'operator'; providerId: string; apiKey?: string }
  | { kind: 'platform'; defaultId: TextPlatformDefaultId; revision: string; apiKey: string }
  | { kind: 'vault'; ownerId: string; credentialId: string }
  | { kind: 'none' };

const handles = new WeakMap<ModelBinding, CredentialHandle>();

export type BindingFields = Omit<ModelBinding, 'fingerprint' | 'credentialReady'>;

function fingerprintOf(fields: BindingFields): string {
  const material = JSON.stringify([
    fields.source,
    fields.providerId,
    fields.modelId,
    fields.model.api,
    fields.model.baseUrl,
    fields.endpoint,
    fields.funding.kind,
    fields.revision ?? null,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function credentialReady(handle: CredentialHandle): boolean {
  switch (handle.kind) {
    case 'inline-key':
      return handle.apiKey.length > 0;
    case 'operator':
      return handle.apiKey === undefined || handle.apiKey.length > 0;
    case 'platform':
      return handle.apiKey.length > 0;
    case 'vault':
    case 'none':
      return true;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Freeze a binding and attach its credential handle privately. `endpointReady`
 * is false when a required non-secret endpoint value is missing.
 */
export function createBinding(
  fields: BindingFields,
  handle: CredentialHandle,
  endpointReady = true,
): ModelBinding {
  const binding = deepFreeze({
    ...structuredClone(fields),
    credentialReady: endpointReady && credentialReady(handle),
    fingerprint: fingerprintOf(fields),
  }) as ModelBinding;
  handles.set(binding, Object.freeze({ ...handle }));
  return binding;
}

export function getCredentialHandle(binding: ModelBinding): CredentialHandle {
  const handle = handles.get(binding);
  if (!handle) throw new Error('Model binding was not created by the gateway');
  return handle;
}

/** A new binding with a different effective thinking configuration (PRO driver). */
export function withThinking(
  binding: ModelBinding,
  thinking: ThinkingConfig | undefined,
): ModelBinding {
  const { fingerprint: _fingerprint, credentialReady: ready, ...fields } = binding;
  const handle = getCredentialHandle(binding);
  return createBinding({ ...fields, thinking }, handle, ready || !credentialReady(handle));
}
