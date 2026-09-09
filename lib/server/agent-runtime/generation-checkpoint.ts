import { createHash } from 'node:crypto';

export interface GenerationContentDependency {
  stageId: string;
  order: number;
  title: string;
  type: string;
  brief: string;
  instruction?: string;
  materialFacts?: readonly string[];
  media?: readonly { src: string; description: string; width?: number; height?: number }[];
  agents?: unknown;
  languageDirective?: string;
  model?: unknown;
  skill?: unknown;
  baseline?: unknown;
}

export function generationInputHash(input: GenerationContentDependency): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
