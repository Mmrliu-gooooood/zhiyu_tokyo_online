function enabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Build/runtime gate shared by the learning-check UI and API route. */
export function isLearningChecksEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED);
}

/** Independent gate for the optional guided-learning flow. */
export function isGuidedLearningEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_GUIDED_LEARNING_ENABLED);
}

export function getLearningUiCapabilities(
  learningChecksEnabled = isLearningChecksEnabled(),
  guidedLearningEnabled = isGuidedLearningEnabled(),
) {
  return {
    showChecks: learningChecksEnabled,
    showQuizRemediation: learningChecksEnabled,
    allowGuidedDiscussion: learningChecksEnabled && guidedLearningEnabled,
  } as const;
}
