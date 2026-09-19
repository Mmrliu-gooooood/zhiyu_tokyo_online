import {
  TEACH_BACK_CLIENT_CALL_BUDGET,
  TEACH_BACK_MAX_EXPLANATIONS,
  sameTeachBackSource,
  shouldEndTeachBackTurn,
  type TeachBackCriterionResult,
  type TeachBackErrorCode,
  type TeachBackEvent,
  type TeachBackExplanation,
  type TeachBackFinishReason,
  type TeachBackPhase,
  type TeachBackPlan,
  type TeachBackQuestion,
  type TeachBackRecordPayloadV1,
  type TeachBackSource,
  type TeachBackSummary,
  type TeachBackTurnResult,
} from './contracts';

export type TeachBackCommand =
  | 'submit_explanation'
  | 'retry_evaluation'
  | 'finish'
  | 'suspend'
  | 'resume';

export interface TeachBackProjectedActivity {
  activityId: string;
  lastSeq: number;
  hasStarted: boolean;
  phase: TeachBackPhase;
  logicalPhase: Exclude<TeachBackPhase, 'suspended'>;
  source?: TeachBackSource;
  plan?: TeachBackPlan;
  topic?: string;
  explanations: TeachBackExplanation[];
  results: TeachBackTurnResult[];
  pendingTurnId?: string;
  currentQuestion?: TeachBackQuestion;
  callsInitiated: number;
  finishReason?: TeachBackFinishReason;
  suspendReason?: string;
  remainingExplanations: number;
  summary?: TeachBackSummary;
}

export const EMPTY_TEACH_BACK_ACTIVITY = {
  explanations: [] as TeachBackExplanation[],
  results: [] as TeachBackTurnResult[],
  callsInitiated: 0,
  remainingExplanations: TEACH_BACK_MAX_EXPLANATIONS,
};

export function remainingExplanationSlots(explanations: readonly TeachBackExplanation[]): number {
  return Math.max(0, TEACH_BACK_MAX_EXPLANATIONS - explanations.length);
}

export function latestCriterionStates(
  results: readonly TeachBackTurnResult[],
): TeachBackCriterionResult[] {
  const latest = results.at(-1);
  return latest?.criteria ?? [];
}

export function buildTeachBackSummary(
  activity: Pick<TeachBackProjectedActivity, 'explanations' | 'results' | 'finishReason'>,
): TeachBackSummary | undefined {
  if (activity.explanations.length === 0 && activity.results.length === 0) {
    return {
      criteria: [],
      suggestion: '',
      explanations: [],
      partial: true,
    };
  }
  const latest = latestCriterionStates(activity.results);
  return {
    criteria: latest,
    suggestion: activity.results.at(-1)?.suggestion ?? '',
    explanations: [...activity.explanations],
    partial: activity.finishReason === 'manual_stop' && activity.results.length === 0,
  };
}

export function allowedTeachBackCommands(
  activity: TeachBackProjectedActivity,
): ReadonlySet<TeachBackCommand> {
  const allowed = new Set<TeachBackCommand>();
  if (activity.phase === 'finished' || !activity.hasStarted) return allowed;
  allowed.add('finish');
  if (activity.phase === 'suspended') {
    allowed.add('resume');
    return allowed;
  }
  allowed.add('suspend');
  if (
    activity.phase === 'awaiting_explanation' &&
    activity.remainingExplanations > 0 &&
    !activity.pendingTurnId
  ) {
    allowed.add('submit_explanation');
  }
  if (activity.phase === 'evaluation_pending' && activity.pendingTurnId) {
    allowed.add('retry_evaluation');
  }
  return allowed;
}

export function canInitiateModelCall(activity: TeachBackProjectedActivity): boolean {
  return activity.callsInitiated < TEACH_BACK_CLIENT_CALL_BUDGET && activity.phase !== 'finished';
}

export function bindTeachBackSource(
  activity: TeachBackProjectedActivity,
  current: TeachBackSource,
): TeachBackErrorCode | undefined {
  if (!activity.source) return 'invalid_request';
  if (activity.source.stageId !== current.stageId || activity.source.sceneId !== current.sceneId) {
    return 'source_stale';
  }
  if (!sameTeachBackSource(activity.source, current)) return 'source_stale';
  return undefined;
}

export function nextTurnIndex(explanations: readonly TeachBackExplanation[]): number {
  return explanations.length + 1;
}

export function projectTeachBackActivity(
  activityId: string,
  records: readonly { seq: number; payload: TeachBackRecordPayloadV1 }[],
): TeachBackProjectedActivity {
  let lastSeq = -1;
  let hasStarted = false;
  let logicalPhase: Exclude<TeachBackPhase, 'suspended'> = 'awaiting_explanation';
  let phase: TeachBackPhase = 'awaiting_explanation';
  let source: TeachBackSource | undefined;
  let plan: TeachBackPlan | undefined;
  let topic: string | undefined;
  const explanations: TeachBackExplanation[] = [];
  const results: TeachBackTurnResult[] = [];
  let pendingTurnId: string | undefined;
  let currentQuestion: TeachBackQuestion | undefined;
  let callsInitiated = 0;
  let finishReason: TeachBackFinishReason | undefined;
  let suspendReason: string | undefined;
  const evaluatedTurns = new Set<string>();

  for (const record of records) {
    if (record.payload.activityId !== activityId) continue;
    lastSeq = record.seq;
    const event: TeachBackEvent = record.payload.event;
    switch (event.kind) {
      case 'prepare_requested':
        callsInitiated += 1;
        topic = event.topic;
        source = source ?? event.source;
        break;
      case 'activity_prepared':
        hasStarted = true;
        source = event.source;
        plan = event.plan;
        topic = event.plan.topic;
        currentQuestion = event.plan.openingQuestion;
        logicalPhase = 'awaiting_explanation';
        phase = 'awaiting_explanation';
        suspendReason = undefined;
        break;
      case 'explanation_submitted':
        if (explanations.some((item) => item.turnId === event.explanation.turnId)) break;
        explanations.push(event.explanation);
        pendingTurnId = event.explanation.turnId;
        logicalPhase = 'evaluation_pending';
        phase = 'evaluation_pending';
        break;
      case 'evaluation_requested':
        callsInitiated += 1;
        pendingTurnId = event.turnId;
        logicalPhase = 'evaluation_pending';
        phase = 'evaluation_pending';
        break;
      case 'turn_evaluated': {
        if (evaluatedTurns.has(event.result.turnId)) break;
        evaluatedTurns.add(event.result.turnId);
        results.push(event.result);
        pendingTurnId = undefined;
        const explanation = explanations.find((item) => item.turnId === event.result.turnId);
        const ended = explanation
          ? shouldEndTeachBackTurn({
              turnIndex: explanation.turnIndex,
              criteria: event.result.criteria,
            })
          : Boolean(event.result.endReason);
        if (ended) {
          currentQuestion = undefined;
          logicalPhase = 'summary_ready';
          phase = 'summary_ready';
        } else {
          currentQuestion = event.result.nextQuestion;
          logicalPhase = 'awaiting_explanation';
          phase = 'awaiting_explanation';
        }
        break;
      }
      case 'activity_suspended':
        if (logicalPhase !== 'finished') {
          phase = 'suspended';
          suspendReason = event.reason;
        }
        break;
      case 'activity_resumed':
        if (logicalPhase !== 'finished') {
          phase = logicalPhase;
          suspendReason = undefined;
        }
        break;
      case 'activity_finished':
        finishReason = event.reason;
        logicalPhase = 'finished';
        phase = 'finished';
        pendingTurnId = undefined;
        currentQuestion = undefined;
        break;
    }
  }

  const remainingExplanations = remainingExplanationSlots(explanations);
  const projected: TeachBackProjectedActivity = {
    activityId,
    lastSeq,
    hasStarted,
    phase,
    logicalPhase,
    source,
    plan,
    topic,
    explanations,
    results,
    pendingTurnId,
    currentQuestion,
    callsInitiated,
    finishReason,
    suspendReason,
    remainingExplanations,
  };
  if (logicalPhase === 'summary_ready' || logicalPhase === 'finished') {
    projected.summary = buildTeachBackSummary(projected);
  }
  return projected;
}

export function assertCanSubmitExplanation(activity: TeachBackProjectedActivity): void {
  if (!allowedTeachBackCommands(activity).has('submit_explanation')) {
    throw new Error('Teach-back is not waiting for an explanation');
  }
  if (activity.explanations.some((item) => !activity.results.some((result) => result.turnId === item.turnId))) {
    throw new Error('Teach-back already has an unevaluated explanation');
  }
}

export function assertCanRetryEvaluation(activity: TeachBackProjectedActivity, turnId: string): void {
  if (!allowedTeachBackCommands(activity).has('retry_evaluation')) {
    throw new Error('Teach-back has no pending explanation to retry');
  }
  if (activity.pendingTurnId !== turnId) {
    throw new Error('Retry must target the pending explanation');
  }
  if (activity.results.some((result) => result.turnId === turnId)) {
    throw new Error('This explanation already has a formal result');
  }
}

export function assertCanFinish(activity: TeachBackProjectedActivity): void {
  if (activity.phase === 'finished' || !activity.hasStarted) {
    throw new Error('Teach-back cannot finish in its current state');
  }
}
