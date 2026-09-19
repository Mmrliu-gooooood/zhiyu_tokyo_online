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

/** Independent gate for reverse-teaching / teach-back practice. */
export function isTeachBackEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_TEACH_BACK_ENABLED);
}

export function getLearningUiCapabilities(
  learningChecksEnabled = isLearningChecksEnabled(),
  guidedLearningEnabled = isGuidedLearningEnabled(),
  teachBackEnabled = isTeachBackEnabled(),
) {
  return {
    showChecks: learningChecksEnabled,
    showQuizRemediation: learningChecksEnabled,
    allowGuidedDiscussion: learningChecksEnabled && guidedLearningEnabled,
    showTeachBack: teachBackEnabled,
    showLearningFeedback: learningChecksEnabled || teachBackEnabled,
  } as const;
}
