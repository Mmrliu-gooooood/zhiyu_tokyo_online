import type { ProModelContext } from '@/types/pro-model';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageRoute, type LlmStage } from '@/lib/server/model-routes';
import { resolveAgentDriverModel } from './agent-driver-model';
import { safeModelError } from './model-errors';

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
    driverModel = driver.connection.modelString;
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
      await resolveModel(getStageRoute(stage) ? { stage } : { ...modelContext, stage });
    }
    return { chatReady: true, generationReady: true, driverModel };
  } catch (error) {
    return { chatReady: true, generationReady: false, driverModel, error: safeModelError(error) };
  }
}
