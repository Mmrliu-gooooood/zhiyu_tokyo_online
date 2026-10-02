import type { ProModelContext } from '@/types/pro-model';
import { GatewayError, resolveBinding, type ModelBinding } from '@/lib/model-gateway';
import type { LlmStage } from '@/lib/server/model-routes';
import { resolveAgentDriverModel } from './agent-driver-model';
import { safeModelError } from './model-errors';

/** A binding that would be refused before sending (missing credential / endpoint value). */
function assertCredentialReady(binding: ModelBinding): void {
  if (!binding.credentialReady) {
    throw new GatewayError('MODEL_CONFIGURATION', {
      providerId: binding.providerId,
      modelId: binding.modelId,
    });
  }
}

/** Static resolution only: upstream key acceptance/tool support still require a real call. */
export async function preflightProModel(modelContext?: ProModelContext): Promise<{
  chatReady: boolean;
  generationReady: boolean;
  driverModel?: string;
  error?: string;
}> {
  let driverModel: string | undefined;
  try {
    const driver = await resolveAgentDriverModel(modelContext);
    assertCredentialReady(driver.binding);
    driverModel = driver.binding.modelString;
  } catch (error) {
    return { chatReady: false, generationReady: false, error: safeModelError(error) };
  }
  try {
    await modelContext?.assertActive?.();
    for (const stage of [
      'scene-content',
      'scene-content:slide',
      'scene-content:quiz',
      'scene-content:interactive',
      'scene-content:pbl',
      'scene-actions',
    ] as LlmStage[]) {
      // A configured stage route ignores the connection context (resolveBinding).
      assertCredentialReady(await resolveBinding({ selection: modelContext?.selection, stage }));
    }
    return { chatReady: true, generationReady: true, driverModel };
  } catch (error) {
    return { chatReady: true, generationReady: false, driverModel, error: safeModelError(error) };
  }
}
