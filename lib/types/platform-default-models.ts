import type { ThinkingConfig } from '@/lib/types/provider';

/** Public contract for ZHIYU platform-provided default models. */

export type PlatformDefaultCapability = 'text' | 'image' | 'video' | 'tts';

export type PlatformDefaultId =
  | 'zhiyu-default-text'
  | 'zhiyu-default-image'
  | 'zhiyu-default-video'
  | 'zhiyu-default-tts';

export type ModelSelection =
  | {
      source: 'platform';
      defaultId: PlatformDefaultId;
    }
  | {
      source: 'user';
      providerId: string;
      modelId?: string;
    }
  | {
      source: 'legacy-managed';
      providerId: string;
      modelId?: string;
    };

export interface PlatformDefaultParameters {
  textTools?: true;
  textThinking?: {
    control: 'effort';
    requestAdapter: 'deepseek';
    effortValues: readonly ['none', 'high', 'max'];
    defaultEffort: 'high';
  };
  textContextWindow?: 1048576;
  textOutputWindow?: 393216;
  imageCount?: 1;
  videoResolution?: '768P';
  videoDurationSeconds?: 6;
  ttsVoice?: string;
}

export interface PlatformDefaultCatalogEntry {
  defaultId: PlatformDefaultId;
  capability: PlatformDefaultCapability;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  available: boolean;
  status: 'available' | 'not_configured' | 'disabled';
  revision: string;
  parameters: PlatformDefaultParameters;
  /** Platform policy, separate from the model's supported thinking controls. */
  defaultThinkingConfig?: ThinkingConfig;
}

export interface PlatformDefaultCatalog {
  version: 2;
  entries: PlatformDefaultCatalogEntry[];
}

export function platformModelString(defaultId: PlatformDefaultId): string {
  return `platform:${defaultId}`;
}
