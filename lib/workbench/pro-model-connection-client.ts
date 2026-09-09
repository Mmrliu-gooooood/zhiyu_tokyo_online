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
    const response = await fetch('/api/agent/model-connections', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...config, ...(ref ? { ref } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
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
      throw new Error(proModelConfigurationMessage(body.error));
    }
    local?.setItem(REF_KEY, JSON.stringify(body.ref));
    return body.ref;
  }
  throw new Error(proModelConfigurationMessage());
}

/** Only known safe codes are presented; arbitrary proxy bodies never reach the UI. */
export function proModelConfigurationMessage(code?: unknown): string {
  const keys: Record<string, WorkbenchCopyKey> = {
    PRO_MODEL_KEY_REQUIRED: 'workbench.system.modelKeyRequired',
    PRO_MODEL_PROTOCOL_REQUIRED: 'workbench.system.modelProtocolRequired',
    PRO_MODEL_ENCRYPTION_UNAVAILABLE: 'workbench.system.modelEncryptionUnavailable',
    PRO_MODEL_CONNECTION_UNAVAILABLE: 'workbench.system.modelConnectionUnavailable',
    PRO_MODEL_UNSAFE_ENDPOINT: 'workbench.system.modelUnsafeEndpoint',
  };
  return defaultWorkbenchTranslator(
    typeof code === 'string' && keys[code]
      ? keys[code]
      : 'workbench.system.modelConfigurationRequired',
  );
}
