import type { ProModelRef } from '@/types/pro-model';
import { parseProModelRef, resolveProModelContext } from './model-connections';
import { preflightProModel } from './model-preflight';

export class SessionModelConfigurationError extends Error {
  readonly code = 'PRO_MODEL_CONFIGURATION_REQUIRED';
}

/** Verify the owner's immutable reference before accepting any durable input. */
export async function validateSessionModelBinding(
  ownerId: string,
  value: unknown,
  previousRef?: ProModelRef,
): Promise<ProModelRef | undefined> {
  const ref = value === undefined ? previousRef : parseProModelRef(value);
  if (value !== undefined && !ref) {
    throw new SessionModelConfigurationError(
      'PRO_MODEL_CONFIGURATION_REQUIRED: Open model settings and recheck the connection.',
    );
  }
  const context = ref ? await resolveProModelContext(ownerId, ref) : undefined;
  const status = await preflightProModel(context);
  if (!status.chatReady || !status.generationReady) {
    throw new SessionModelConfigurationError(
      status.error ||
        'PRO_MODEL_CONFIGURATION_REQUIRED: Open model settings and recheck the connection.',
    );
  }
  return ref;
}
