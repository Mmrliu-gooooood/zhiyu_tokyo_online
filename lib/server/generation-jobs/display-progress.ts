import type {
  GenerationDisplayPhase,
  GenerationDisplayProgress,
  GenerationInput,
  GenerationJobStatus,
} from './contracts';

export interface GenerationDisplayStepFact extends Record<string, unknown> {
  key: string;
  kind: string;
  outlineId: string | null;
  status: string;
  errorCode: string | null;
  startedAt: Date | string | null;
}

export interface GenerationDisplaySceneFact extends Record<string, unknown> {
  outlineId: string;
  status: string;
  actions: unknown;
}

const phaseOrder: GenerationDisplayPhase[] = [
  'preparing',
  'research',
  'outlines',
  'agents',
  'content',
  'actions',
  'tts',
  'media',
  'finalizing',
];

export function normalizeGenerationDisplayPhase(value: {
  key?: string | null;
  kind?: string | null;
  phase?: string | null;
}): GenerationDisplayPhase {
  for (const candidate of [value.key, value.kind, value.phase]) {
    const prefix = candidate?.trim().toLowerCase().split(':')[0];
    if (!prefix) continue;
    if (['research', 'researching'].includes(prefix)) return 'research';
    if (['plan', 'outline', 'outlines'].includes(prefix)) return 'outlines';
    if (['agent', 'agents'].includes(prefix)) return 'agents';
    if (['content', 'scene_content'].includes(prefix)) return 'content';
    if (['action', 'actions', 'scene', 'scene_actions'].includes(prefix)) return 'actions';
    if (['tts', 'speech'].includes(prefix)) return 'tts';
    if (prefix === 'media') return 'media';
    if (prefix === 'finalizing') return 'finalizing';
    if (['prepare', 'preparing', 'queued'].includes(prefix)) return 'preparing';
  }
  return 'preparing';
}

function outlineIdOf(step: GenerationDisplayStepFact): string | null {
  if (step.outlineId) return step.outlineId;
  return /^(?:content|actions|scene|media|tts):([^:]+)/.exec(step.key)?.[1] ?? null;
}

function isLogicalCheckpoint(step: GenerationDisplayStepFact, phase: GenerationDisplayPhase) {
  const outlineId = outlineIdOf(step);
  return Boolean(outlineId && step.key === `${phase}:${outlineId}`);
}

function activeOutlines(
  steps: GenerationDisplayStepFact[],
  phase: GenerationDisplayPhase,
  currentOutlineIds: Set<string>,
) {
  return new Set(
    steps
      .filter(
        (step) => step.status === 'running' && normalizeGenerationDisplayPhase(step) === phase,
      )
      .map(outlineIdOf)
      .filter((id): id is string => Boolean(id && currentOutlineIds.has(id))),
  );
}

function completedOutlines(
  steps: GenerationDisplayStepFact[],
  phase: GenerationDisplayPhase,
  currentOutlineIds: Set<string>,
) {
  return new Set(
    steps
      .filter(
        (step) =>
          step.status === 'succeeded' &&
          normalizeGenerationDisplayPhase(step) === phase &&
          isLogicalCheckpoint(step, phase),
      )
      .map(outlineIdOf)
      .filter((id): id is string => Boolean(id && currentOutlineIds.has(id))),
  );
}

function speechCount(actions: unknown): number {
  return Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === 'object' && action.type === 'speech')
        .length
    : 0;
}

function failedStepOf(
  steps: GenerationDisplayStepFact[],
  lastErrorCode: string | null,
): GenerationDisplayProgress['failedStep'] {
  if (!lastErrorCode) return undefined;
  const candidates = steps
    .filter((step) => ['failed', 'uncertain', 'retry_wait', 'cancelled'].includes(step.status))
    .sort((left, right) => {
      const uncertainTtsPriority =
        Number(right.status === 'uncertain' && normalizeGenerationDisplayPhase(right) === 'tts') -
        Number(left.status === 'uncertain' && normalizeGenerationDisplayPhase(left) === 'tts');
      if (uncertainTtsPriority) return uncertainTtsPriority;
      const errorMatch =
        Number(right.errorCode === lastErrorCode) - Number(left.errorCode === lastErrorCode);
      if (errorMatch) return errorMatch;
      return new Date(right.startedAt ?? 0).getTime() - new Date(left.startedAt ?? 0).getTime();
    });
  const failed = candidates[0];
  if (!failed) return undefined;
  const outlineId = outlineIdOf(failed);
  return {
    key: failed.key,
    phase: normalizeGenerationDisplayPhase(failed),
    ...(outlineId ? { outlineId } : {}),
    code: failed.errorCode ?? lastErrorCode,
  };
}

export function projectGenerationDisplayProgress(input: {
  phase: string;
  status: GenerationJobStatus;
  totalScenes: number;
  lastErrorCode: string | null;
  generationInput: GenerationInput;
  steps: GenerationDisplayStepFact[];
  scenes: GenerationDisplaySceneFact[];
}): GenerationDisplayProgress {
  const currentOutlineIds = new Set(input.scenes.map((scene) => scene.outlineId));
  const total = currentOutlineIds.size || input.totalScenes;
  const contentCompleted = completedOutlines(input.steps, 'content', currentOutlineIds);
  const actionsCompleted = completedOutlines(input.steps, 'actions', currentOutlineIds);
  const contentActive = activeOutlines(input.steps, 'content', currentOutlineIds);
  const actionsActive = activeOutlines(input.steps, 'actions', currentOutlineIds);
  const failedStep =
    input.status === 'cancelled' ? undefined : failedStepOf(input.steps, input.lastErrorCode);
  const activePhases = input.steps
    .filter((step) => step.status === 'running')
    .map((step) => normalizeGenerationDisplayPhase(step));
  const phase =
    failedStep?.phase ??
    activePhases.reduce(
      (latest, current) =>
        phaseOrder.indexOf(current) > phaseOrder.indexOf(latest) ? current : latest,
      normalizeGenerationDisplayPhase({ phase: input.phase }),
    );
  const speechesByOutline = new Map(
    input.scenes.map((scene) => [scene.outlineId, speechCount(scene.actions)]),
  );
  const discoveredSpeechTotal = [...speechesByOutline.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const ttsDisabled = input.generationInput.tts?.enabled === false;
  let completedSpeech = 0;
  let activeSpeech = 0;
  for (const outlineId of currentOutlineIds) {
    const steps = input.steps.filter(
      (step) => outlineIdOf(step) === outlineId && normalizeGenerationDisplayPhase(step) === 'tts',
    );
    const discovered = speechesByOutline.get(outlineId) ?? 0;
    const topLevel = steps.find((step) => step.key === `tts:${outlineId}`);
    const calls = steps.filter((step) => step.key.startsWith(`tts:${outlineId}:call:`));
    if (topLevel?.status === 'succeeded') completedSpeech += discovered;
    else
      completedSpeech += Math.min(
        discovered,
        calls.filter((step) => step.status === 'succeeded').length,
      );
    if (!ttsDisabled) {
      const activeCalls = new Set(
        calls.filter((step) => step.status === 'running').map((step) => step.key),
      ).size;
      activeSpeech += activeCalls || (topLevel?.status === 'running' ? 1 : 0);
    }
  }

  return {
    phase,
    content: {
      completed: contentCompleted.size,
      total,
      active: contentActive.size,
    },
    actions: {
      completed: actionsCompleted.size,
      total,
      active: actionsActive.size,
    },
    speech: {
      completed: ttsDisabled ? 0 : completedSpeech,
      total: total > 0 && actionsCompleted.size === total ? discoveredSpeechTotal : null,
      active: activeSpeech,
      skipped: ttsDisabled ? discoveredSpeechTotal : 0,
    },
    published: {
      completed: input.scenes.filter((scene) => scene.status === 'ready').length,
      total,
    },
    ...(failedStep ? { failedStep } : {}),
  };
}
