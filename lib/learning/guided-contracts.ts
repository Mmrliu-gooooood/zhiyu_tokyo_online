export type GuidedInteractionMode = 'standard' | 'guided';

export type GuidedReviewVerdict = 'no_issue_found' | 'issue_found' | 'insufficient_evidence';

export interface GuidedEvidence {
  ref: string;
  content: string;
}

export type GuidedSource =
  | { kind: 'scene'; sceneId: string }
  | {
      kind: 'learning_attempt' | 'quiz_attempt';
      attemptId: string;
      questionId: string;
    };

export interface GuidedPublishedContent {
  explanation: string;
  reviewNote: string;
}

export interface GuidedLearningOutcome {
  schemaVersion: 1;
  requestId: string;
  phase: 'wait_student' | 'feedback';
  published: GuidedPublishedContent;
  checkPrompt?: string;
  review: {
    verdict: GuidedReviewVerdict;
    evidenceRefs: string[];
  };
  budget: {
    callsUsed: number;
    callLimit: 1 | 4;
    stopReason?: 'completed' | 'timeout' | 'aborted' | 'invalid_output' | 'budget_exhausted';
  };
  usage: { status: 'unknown' } | { status: 'reported'; inputTokens: number; outputTokens: number };
}

export interface GuidedLearningContext {
  schemaVersion: 1;
  requestId: string;
  chatSessionId: string;
  stageId: string;
  contentRevision: string;
  scopedRevision: string;
  phase: 'explain' | 'feedback';
  source: GuidedSource;
  evidence: GuidedEvidence[];
  studentAnswer?: string;
  priorOutcome?: GuidedLearningOutcome;
}

const MAX_EVIDENCE_ITEMS = 12;
const MAX_TOTAL_EVIDENCE_LENGTH = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function parseSource(value: unknown): GuidedSource {
  if (!isRecord(value) || !boundedString(value.kind, 32)) {
    throw new Error('Invalid guided learning source');
  }
  if (value.kind === 'scene') {
    if (!hasOnlyKeys(value, ['kind', 'sceneId']) || !boundedString(value.sceneId, 256)) {
      throw new Error('Invalid guided learning source');
    }
    return value as unknown as GuidedSource;
  }
  if (value.kind === 'learning_attempt' || value.kind === 'quiz_attempt') {
    if (
      !hasOnlyKeys(value, ['kind', 'attemptId', 'questionId']) ||
      !boundedString(value.attemptId, 256) ||
      !boundedString(value.questionId, 256)
    ) {
      throw new Error('Invalid guided learning source');
    }
    return value as unknown as GuidedSource;
  }
  throw new Error('Invalid guided learning source');
}

export function parseGuidedLearningOutcome(
  value: unknown,
  allowedEvidenceRefs?: ReadonlySet<string>,
): GuidedLearningOutcome {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'requestId',
      'phase',
      'published',
      'checkPrompt',
      'review',
      'budget',
      'usage',
    ]) ||
    value.schemaVersion !== 1 ||
    !boundedString(value.requestId, 256) ||
    (value.phase !== 'wait_student' && value.phase !== 'feedback') ||
    !isRecord(value.published) ||
    !hasOnlyKeys(value.published, ['explanation', 'reviewNote']) ||
    !boundedString(value.published.explanation, 4_000) ||
    !boundedString(value.published.reviewNote, 1_000) ||
    (value.checkPrompt !== undefined && !boundedString(value.checkPrompt, 1_000)) ||
    !isRecord(value.review) ||
    !hasOnlyKeys(value.review, ['verdict', 'evidenceRefs']) ||
    !['no_issue_found', 'issue_found', 'insufficient_evidence'].includes(
      String(value.review.verdict),
    ) ||
    !Array.isArray(value.review.evidenceRefs) ||
    value.review.evidenceRefs.length > MAX_EVIDENCE_ITEMS ||
    !value.review.evidenceRefs.every((ref) => boundedString(ref, 512)) ||
    !isRecord(value.budget) ||
    !hasOnlyKeys(value.budget, ['callsUsed', 'callLimit', 'stopReason']) ||
    !Number.isInteger(value.budget.callsUsed) ||
    (value.budget.callLimit !== 1 && value.budget.callLimit !== 4) ||
    (value.budget.callsUsed as number) < 0 ||
    (value.budget.callsUsed as number) > (value.budget.callLimit as number) ||
    (value.budget.stopReason !== undefined &&
      !['completed', 'timeout', 'aborted', 'invalid_output', 'budget_exhausted'].includes(
        String(value.budget.stopReason),
      )) ||
    !isRecord(value.usage) ||
    !hasOnlyKeys(value.usage, ['status', 'inputTokens', 'outputTokens']) ||
    (value.usage.status !== 'unknown' && value.usage.status !== 'reported')
  ) {
    throw new Error('Invalid guided learning outcome or call budget');
  }

  if (
    value.usage.status === 'reported' &&
    (!Number.isInteger(value.usage.inputTokens) ||
      (value.usage.inputTokens as number) < 0 ||
      !Number.isInteger(value.usage.outputTokens) ||
      (value.usage.outputTokens as number) < 0)
  ) {
    throw new Error('Invalid guided learning usage');
  }
  if (
    value.usage.status === 'unknown' &&
    (value.usage.inputTokens !== undefined || value.usage.outputTokens !== undefined)
  ) {
    throw new Error('Invalid guided learning usage');
  }
  if (
    allowedEvidenceRefs &&
    !value.review.evidenceRefs.every((ref) => allowedEvidenceRefs.has(ref))
  ) {
    throw new Error('Invalid guided learning evidence reference');
  }

  return value as unknown as GuidedLearningOutcome;
}

export function parseGuidedLearningContext(value: unknown): GuidedLearningContext {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'requestId',
      'chatSessionId',
      'stageId',
      'contentRevision',
      'scopedRevision',
      'phase',
      'source',
      'evidence',
      'studentAnswer',
      'priorOutcome',
    ]) ||
    value.schemaVersion !== 1 ||
    !boundedString(value.requestId, 256) ||
    !boundedString(value.chatSessionId, 256) ||
    !boundedString(value.stageId, 256) ||
    !boundedString(value.contentRevision, 512) ||
    !boundedString(value.scopedRevision, 512) ||
    (value.phase !== 'explain' && value.phase !== 'feedback') ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_EVIDENCE_ITEMS
  ) {
    throw new Error('Invalid guided learning context');
  }

  const source = parseSource(value.source);
  let totalEvidenceLength = 0;
  const evidence = value.evidence.map((item) => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['ref', 'content']) ||
      !boundedString(item.ref, 512) ||
      !boundedString(item.content, 12_000)
    ) {
      throw new Error('Invalid guided learning context evidence');
    }
    totalEvidenceLength += item.content.length;
    return item as unknown as GuidedEvidence;
  });
  if (totalEvidenceLength > MAX_TOTAL_EVIDENCE_LENGTH) {
    throw new Error('Invalid guided learning context evidence');
  }

  if (value.phase === 'feedback') {
    if (!boundedString(value.studentAnswer, 4_000)) {
      throw new Error('Invalid guided learning student answer');
    }
    const refs = new Set(evidence.map((item) => item.ref));
    const priorOutcome = parseGuidedLearningOutcome(value.priorOutcome, refs);
    if (priorOutcome.phase !== 'wait_student') {
      throw new Error('Invalid guided learning prior outcome');
    }
  } else if (value.studentAnswer !== undefined || value.priorOutcome !== undefined) {
    throw new Error('Invalid guided learning context');
  }

  return { ...(value as unknown as GuidedLearningContext), source, evidence };
}
