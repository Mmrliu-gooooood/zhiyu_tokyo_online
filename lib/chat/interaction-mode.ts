/**
 * Shared classroom interaction modes. Chat session config owns this union so
 * guided learning does not become the type home for every later activity.
 */
export type InteractionMode = 'standard' | 'guided' | 'teach_back';

export const INTERACTION_MODES = ['standard', 'guided', 'teach_back'] as const;

export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === 'standard' || value === 'guided' || value === 'teach_back';
}
