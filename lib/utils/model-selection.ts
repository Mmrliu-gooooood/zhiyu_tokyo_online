import {
  upgradeLegacyModelParams,
  type ModelSelection,
} from '@/lib/model-gateway/selection/schema';
import type { ModelConfigInput } from '@/types/pro-model';

/**
 * The Home model configuration as the gateway ModelSelection the server
 * stores (plan P4-2). Platform selections never carry provider fields.
 * Returns undefined when the configuration does not name a valid model.
 */
export function modelConfigSelection(config: ModelConfigInput): ModelSelection | undefined {
  try {
    return upgradeLegacyModelParams(
      config.source === 'platform'
        ? {
            source: config.source,
            defaultId: config.defaultId,
            revision: config.revision,
            thinkingConfig: config.thinkingConfig,
          }
        : {
            source: config.source,
            modelString: config.modelString,
            apiKey: config.apiKey?.trim() ? config.apiKey : undefined,
            baseUrl: config.baseUrl?.trim() || undefined,
            providerType: config.providerType,
            api: config.api,
            thinkingConfig: config.thinkingConfig,
          },
    );
  } catch {
    return undefined;
  }
}
