import { defaultWorkbenchTranslator, type WorkbenchCopyKey } from '@/lib/i18n/workbench';
import type { ProModelContext, ProModelRef } from '@/types/pro-model';

const REF_KEY = 'openmaic:pro-model-ref';
const REVOKE_KEY = 'openmaic:pro-model-revoke-pending';
let pendingRevocation: Promise<void> | undefined;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Settings removal revokes persisted credentials, even after a page reload. */
export function revokeProModelConnection(): Promise<void> {
  const local = storage();
  local?.setItem(REVOKE_KEY, '1');
  if (pendingRevocation) return pendingRevocation;
  pendingRevocation = (async () => {
    const response = await fetch('/api/agent/model-connections', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok)
      throw new Error('PRO_MODEL_REVOKE_FAILED: Open model settings and recheck the connection.');
    local?.removeItem(REF_KEY);
    local?.removeItem(REVOKE_KEY);
  })().finally(() => {
    pendingRevocation = undefined;
  });
  return pendingRevocation;
}

/** A cleared Home selection must wait for revocation before using any old session. */
export async function flushProModelRevocation(): Promise<void> {
  if (pendingRevocation) await pendingRevocation;
  if (storage()?.getItem(REVOKE_KEY)) await revokeProModelConnection();
}

/** Only the opaque reference is cached; credentials travel directly to the owner API. */
export async function syncProModelConnection(config: ProModelContext): Promise<ProModelRef> {
  const local = storage();
  await flushProModelRevocation();
  let ref: ProModelRef | undefined;
  try {
    ref = JSON.parse(local?.getItem(REF_KEY) || 'null') || undefined;
  } catch {
    /* stale cache */
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload =
      config.source === 'platform'
        ? {
            source: config.source,
            defaultId: config.defaultId,
            ...(config.revision ? { revision: config.revision } : {}),
            ...(config.thinkingConfig ? { thinkingConfig: config.thinkingConfig } : {}),
          }
        : config;
    const response = await fetch('/api/agent/model-connections', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, ...(ref ? { ref } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (
      response.status === 409 &&
      body.error === 'PRO_MODEL_CONNECTION_STALE' &&
      config.source === 'platform' &&
      attempt === 0
    ) {
      const { refreshPlatformModelConfig } = await import('@/lib/utils/model-config');
      const refreshed = await refreshPlatformModelConfig(config);
      if (refreshed) {
        config = refreshed;
        // Keep the previous ref: a catalog refresh must not bypass connection
        // revision conflicts or overwrite another tab's newer connection.
        continue;
      }
    }
    if (
      response.status === 409 &&
      body.error === 'PRO_MODEL_CONNECTION_UNAVAILABLE' &&
      ref &&
      attempt === 0
    ) {
      local?.removeItem(REF_KEY);
      ref = undefined;
      continue;
    }
    if (!response.ok || !body.ref?.id || !Number.isInteger(body.ref?.revision)) {
      throw new Error(proModelConfigurationMessage(body.error ?? body.errorCode, response.status));
    }
    local?.setItem(REF_KEY, JSON.stringify(body.ref));
    return body.ref;
  }
  throw new Error(proModelConfigurationMessage());
}

/** Only known safe codes are presented; arbitrary proxy bodies never reach the UI. */
export function proModelConfigurationMessage(code?: unknown, status?: number): string {
  const keys: Record<string, WorkbenchCopyKey> = {
    INVALID_GENERATION_SESSION: 'workbench.system.modelSessionInvalid',
    GENERATION_SESSION_REQUIRED: 'workbench.system.modelSessionInvalid',
    PRO_MODEL_CONNECTION_STALE: 'workbench.system.modelConfigurationStale',
    GENERATION_SESSION_UNAVAILABLE: 'workbench.system.modelServiceUnavailable',
    PRO_MODEL_DATABASE_UNAVAILABLE: 'workbench.system.modelServiceUnavailable',
    PRO_MODEL_KEY_REQUIRED: 'workbench.system.modelKeyRequired',
    PRO_MODEL_PROTOCOL_REQUIRED: 'workbench.system.modelProtocolRequired',
    PRO_MODEL_ENCRYPTION_UNAVAILABLE: 'workbench.system.modelEncryptionUnavailable',
    PRO_MODEL_CONNECTION_UNAVAILABLE:
      status !== undefined && status >= 500
        ? 'workbench.system.modelServiceUnavailable'
        : 'workbench.system.modelConnectionUnavailable',
    PRO_MODEL_UNSAFE_ENDPOINT: 'workbench.system.modelUnsafeEndpoint',
  };
  return defaultWorkbenchTranslator(
    typeof code === 'string' && keys[code]
      ? keys[code]
      : status !== undefined && status >= 500
        ? 'workbench.system.modelServiceUnavailable'
        : 'workbench.system.modelConfigurationRequired',
  );
}
