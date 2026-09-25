import type { RuntimePayloadValidator } from '@openmaic/storage';
import type { SceneType } from '@/lib/types/stage';

export const TEACH_BACK_SCHEMA_VERSION = 1 as const;
export const TEACH_BACK_MAX_EXPLANATIONS = 3 as const;
export const TEACH_BACK_CLIENT_CALL_BUDGET = 8 as const;
export const TEACH_BACK_MAX_CRITERIA = 3 as const;
export const TEACH_BACK_MIN_CRITERIA = 1 as const;

export const TEACH_BACK_LIMITS = Object.freeze({
  requestBytes: 128 * 1024,
  fragmentCharacters: 2_000,
  explanationCharacters: 4_000,
  topicCharacters: 120,
  questionCharacters: 300,
  reasonCharacters: 300,
  criterionDescriptionCharacters: 400,
  quoteCharacters: 400,
  suggestionCharacters: 400,
  peerNameCharacters: 80,
  peerPersonaCharacters: 4_000,
  idCharacters: 256,
  minSourceCharacters: 40,
  perCallTimeoutMs: 30_000,
  clientWaitMs: 35_000,
  maxOutputTokens: 1_600,
});

export type TeachBackPhase =
  | 'awaiting_explanation'
  | 'evaluation_pending'
  | 'summary_ready'
  | 'suspended'
  | 'finished';

export type TeachBackUiTransient =
  | 'idle'
  | 'preparing'
  | 'submitting'
  | 'retrying'
  | 'saving'
  | 'paused';

export type TeachBackCriterionStatus = 'explained' | 'needs_supplement' | 'not_addressed';

export type TeachBackEventKind =
  | 'prepare_requested'
  | 'activity_prepared'
  | 'explanation_submitted'
  | 'evaluation_requested'
  | 'turn_evaluated'
  | 'activity_suspended'
  | 'activity_resumed'
  | 'activity_finished';

export type TeachBackAppendStatus = 'applied' | 'replayed' | 'conflict';

export type TeachBackErrorCode =
  | 'feature_disabled'
  | 'invalid_request'
  | 'insufficient_source'
  | 'quiz_in_progress'
  | 'model_unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'source_stale'
  | 'storage_conflict'
  | 'budget_exhausted'
  | 'save_failed'
  | 'no_peer';

export type TeachBackFinishReason =
  | 'completed'
  | 'manual_stop'
  | 'source_changed'
  | 'budget_exhausted';

export type TeachBackSuspendReason =
  | 'reload'
  | 'hidden'
  | 'scene_switch'
  | 'edit'
  | 'cancelled_request';

export interface TeachBackFragment {
  id: string;
  digest: string;
  text: string;
}

export interface TeachBackSource {
  stageId: string;
  sceneId: string;
  sceneType: SceneType;
  title: string;
  courseTitle: string;
  snapshotAlgorithmVersion: string;
  sourceRevision: string;
  fragments: TeachBackFragment[];
  coverageLimited: boolean;
}

export interface TeachBackPeer {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
}

export interface TeachBackCriterion {
  criterionId: string;
  description: string;
  quote: string;
  fragmentId: string;
}

export interface TeachBackQuestion {
  questionId: string;
  text: string;
  criterionId: string;
}

export interface TeachBackPlan {
  topic: string;
  criteria: TeachBackCriterion[];
  peer: TeachBackPeer;
  openingQuestion: TeachBackQuestion;
}

export interface TeachBackExplanation {
  turnId: string;
  turnIndex: number;
  text: string;
  submittedAt: string;
  questionId: string;
}

export interface TeachBackCitation {
  turnId: string;
  excerpt: string;
}

export interface TeachBackCriterionResult {
  criterionId: string;
  status: TeachBackCriterionStatus;
  reason: string;
  citation?: TeachBackCitation;
}

export interface TeachBackTurnResult {
  turnId: string;
  criteria: TeachBackCriterionResult[];
  nextQuestion?: TeachBackQuestion;
  endReason?: 'all_explained' | 'answer_correct' | 'max_turns';
  suggestion: string;
}

export interface TeachBackSummary {
  criteria: TeachBackCriterionResult[];
  suggestion: string;
  explanations: TeachBackExplanation[];
  partial: boolean;
}

export type TeachBackEvent =
  | {
      kind: 'prepare_requested';
      createdAt: string;
      requestId: string;
      source: TeachBackSource;
      topic: string;
      peer: TeachBackPeer;
    }
  | {
      kind: 'activity_prepared';
      createdAt: string;
      plan: TeachBackPlan;
      source: TeachBackSource;
    }
  | {
      kind: 'explanation_submitted';
      createdAt: string;
      explanation: TeachBackExplanation;
    }
  | {
      kind: 'evaluation_requested';
      createdAt: string;
      requestId: string;
      turnId: string;
    }
  | {
      kind: 'turn_evaluated';
      createdAt: string;
      result: TeachBackTurnResult;
    }
  | {
      kind: 'activity_suspended';
      createdAt: string;
      reason: TeachBackSuspendReason;
    }
  | {
      kind: 'activity_resumed';
      createdAt: string;
    }
  | {
      kind: 'activity_finished';
      createdAt: string;
      reason: TeachBackFinishReason;
    };

export interface TeachBackRecordPayloadV1 {
  payloadVersion: typeof TEACH_BACK_SCHEMA_VERSION;
  activityId: string;
  commandId: string;
  event: TeachBackEvent;
}

export interface TeachBackPrepareApiInput {
  operation: 'prepare';
  activityId: string;
  requestId: string;
  source: TeachBackSource;
  topic: string;
  peer: TeachBackPeer;
}

export interface TeachBackEvaluateApiInput {
  operation: 'evaluate';
  activityId: string;
  requestId: string;
  source: TeachBackSource;
  plan: TeachBackPlan;
  explanations: TeachBackExplanation[];
  priorResults: TeachBackTurnResult[];
  turnId: string;
  locale?: string;
}

export type TeachBackApiInput = TeachBackPrepareApiInput | TeachBackEvaluateApiInput;

export interface TeachBackPrepareApiOutput {
  operation: 'prepare';
  plan: TeachBackPlan;
}

export interface TeachBackEvaluateApiOutput {
  operation: 'evaluate';
  result: TeachBackTurnResult;
}

export type TeachBackApiOutput = TeachBackPrepareApiOutput | TeachBackEvaluateApiOutput;

const SCENE_TYPES: ReadonlySet<string> = new Set(['slide', 'quiz', 'interactive', 'pbl']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function boundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isContiguousExcerpt(source: string, excerpt: string): boolean {
  return excerpt.length > 0 && source.includes(excerpt);
}

export function readableSourceLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function parseFragment(value: unknown): TeachBackFragment {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'digest', 'text']) ||
    !boundedString(value.id, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.digest, 128) ||
    !boundedString(value.text, TEACH_BACK_LIMITS.fragmentCharacters, true)
  ) {
    throw new Error('Invalid teach-back fragment');
  }
  return {
    id: value.id,
    digest: value.digest,
    text: value.text,
  };
}

export function parseTeachBackSource(value: unknown): TeachBackSource {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'stageId',
      'sceneId',
      'sceneType',
      'title',
      'courseTitle',
      'snapshotAlgorithmVersion',
      'sourceRevision',
      'fragments',
      'coverageLimited',
    ]) ||
    !boundedString(value.stageId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.sceneId, TEACH_BACK_LIMITS.idCharacters) ||
    typeof value.sceneType !== 'string' ||
    !SCENE_TYPES.has(value.sceneType) ||
    !boundedString(value.title, 200, true) ||
    !boundedString(value.courseTitle, 200) ||
    !boundedString(value.snapshotAlgorithmVersion, 64) ||
    !boundedString(value.sourceRevision, 128) ||
    typeof value.coverageLimited !== 'boolean' ||
    !Array.isArray(value.fragments) ||
    value.fragments.length > 8
  ) {
    throw new Error('Invalid teach-back source');
  }
  return {
    stageId: value.stageId,
    sceneId: value.sceneId,
    sceneType: value.sceneType as SceneType,
    title: value.title,
    courseTitle: value.courseTitle,
    snapshotAlgorithmVersion: value.snapshotAlgorithmVersion,
    sourceRevision: value.sourceRevision,
    fragments: value.fragments.map(parseFragment),
    coverageLimited: value.coverageLimited,
  };
}

export function parseTeachBackPeer(value: unknown): TeachBackPeer {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'name', 'role', 'persona', 'avatar', 'color']) ||
    !boundedString(value.id, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.name, TEACH_BACK_LIMITS.peerNameCharacters) ||
    !boundedString(value.role, 64) ||
    !boundedString(value.persona, TEACH_BACK_LIMITS.peerPersonaCharacters, true) ||
    !boundedString(value.avatar, 512, true) ||
    !boundedString(value.color, 32, true)
  ) {
    throw new Error('Invalid teach-back peer');
  }
  if (value.role === 'teacher') {
    throw new Error('Teach-back peer cannot be the classroom teacher');
  }
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    persona: value.persona,
    avatar: value.avatar,
    color: value.color,
  };
}

function parseCriterion(
  value: unknown,
  fragments: readonly TeachBackFragment[],
): TeachBackCriterion {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['criterionId', 'description', 'quote', 'fragmentId']) ||
    !boundedString(value.criterionId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.description, TEACH_BACK_LIMITS.criterionDescriptionCharacters) ||
    !boundedString(value.quote, TEACH_BACK_LIMITS.quoteCharacters) ||
    !boundedString(value.fragmentId, TEACH_BACK_LIMITS.idCharacters)
  ) {
    throw new Error('Invalid teach-back criterion');
  }
  const fragment = fragments.find((item) => item.id === value.fragmentId);
  if (!fragment || !isContiguousExcerpt(fragment.text, value.quote)) {
    throw new Error('Teach-back criterion quote is not in the course fragment');
  }
  return {
    criterionId: value.criterionId,
    description: value.description,
    quote: value.quote,
    fragmentId: value.fragmentId,
  };
}

function parseQuestion(value: unknown, criterionIds: ReadonlySet<string>): TeachBackQuestion {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['questionId', 'text', 'criterionId']) ||
    !boundedString(value.questionId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.text, TEACH_BACK_LIMITS.questionCharacters) ||
    !boundedString(value.criterionId, TEACH_BACK_LIMITS.idCharacters) ||
    !criterionIds.has(value.criterionId)
  ) {
    throw new Error('Invalid teach-back question');
  }
  return {
    questionId: value.questionId,
    text: value.text,
    criterionId: value.criterionId,
  };
}

export function parseTeachBackPlan(value: unknown, source: TeachBackSource): TeachBackPlan {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['topic', 'criteria', 'peer', 'openingQuestion']) ||
    !boundedString(value.topic, TEACH_BACK_LIMITS.topicCharacters) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length < TEACH_BACK_MIN_CRITERIA ||
    value.criteria.length > TEACH_BACK_MAX_CRITERIA
  ) {
    throw new Error('Invalid teach-back plan');
  }
  const criteria = value.criteria.map((item) => parseCriterion(item, source.fragments));
  const ids = criteria.map((item) => item.criterionId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Teach-back criteria must have unique ids');
  }
  return {
    topic: value.topic,
    criteria,
    peer: parseTeachBackPeer(value.peer),
    openingQuestion: parseQuestion(value.openingQuestion, new Set(ids)),
  };
}

export function parseTeachBackExplanation(
  value: unknown,
  allowedQuestionIds?: ReadonlySet<string>,
): TeachBackExplanation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['turnId', 'turnIndex', 'text', 'submittedAt', 'questionId']) ||
    !boundedString(value.turnId, TEACH_BACK_LIMITS.idCharacters) ||
    !Number.isInteger(value.turnIndex) ||
    (value.turnIndex as number) < 1 ||
    (value.turnIndex as number) > TEACH_BACK_MAX_EXPLANATIONS ||
    !boundedString(value.text, TEACH_BACK_LIMITS.explanationCharacters) ||
    !boundedString(value.submittedAt, 64) ||
    !boundedString(value.questionId, TEACH_BACK_LIMITS.idCharacters)
  ) {
    throw new Error('Invalid teach-back explanation');
  }
  if (allowedQuestionIds && !allowedQuestionIds.has(value.questionId)) {
    throw new Error('Teach-back explanation cites an unknown question');
  }
  return {
    turnId: value.turnId,
    turnIndex: value.turnIndex as number,
    text: value.text,
    submittedAt: value.submittedAt,
    questionId: value.questionId,
  };
}

function parseCitation(
  value: unknown,
  explanations: readonly TeachBackExplanation[],
): TeachBackCitation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['turnId', 'excerpt']) ||
    !boundedString(value.turnId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.excerpt, TEACH_BACK_LIMITS.quoteCharacters)
  ) {
    throw new Error('Invalid teach-back citation');
  }
  const explanation = explanations.find((item) => item.turnId === value.turnId);
  if (!explanation || !isContiguousExcerpt(explanation.text, value.excerpt)) {
    throw new Error('Teach-back citation is not in a student explanation');
  }
  return { turnId: value.turnId, excerpt: value.excerpt };
}

function parseCriterionResult(
  value: unknown,
  criterionIds: ReadonlySet<string>,
  explanations: readonly TeachBackExplanation[],
): TeachBackCriterionResult {
  if (
    !isRecord(value) ||
    !boundedString(value.criterionId, TEACH_BACK_LIMITS.idCharacters) ||
    !criterionIds.has(value.criterionId) ||
    (value.status !== 'explained' &&
      value.status !== 'needs_supplement' &&
      value.status !== 'not_addressed') ||
    !boundedString(value.reason, TEACH_BACK_LIMITS.reasonCharacters)
  ) {
    throw new Error('Invalid teach-back criterion result');
  }
  const allowed =
    value.citation === undefined
      ? ['criterionId', 'status', 'reason']
      : ['criterionId', 'status', 'reason', 'citation'];
  if (!hasOnlyKeys(value, allowed)) {
    throw new Error('Invalid teach-back criterion result');
  }
  if (value.status === 'not_addressed' && value.citation !== undefined) {
    throw new Error('Unaddressed criteria cannot invent student citations');
  }
  if (value.status === 'needs_supplement' && value.reason.trim().length === 0) {
    throw new Error('Needs-supplement results require a gap description');
  }
  return {
    criterionId: value.criterionId,
    status: value.status,
    reason: value.reason,
    ...(value.citation === undefined
      ? {}
      : { citation: parseCitation(value.citation, explanations) }),
  };
}

export function shouldEndTeachBackTurn(input: {
  turnIndex: number;
  currentTurnId: string;
  criteria: readonly TeachBackCriterionResult[];
}): boolean {
  if (input.turnIndex >= TEACH_BACK_MAX_EXPLANATIONS) return true;
  return input.criteria.some(
    (item) => item.status === 'explained' && item.citation?.turnId === input.currentTurnId,
  );
}

function clipBoundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function coerceCriterionResultDraft(
  value: unknown,
  criterionIds: ReadonlySet<string>,
  explanations: readonly TeachBackExplanation[],
  fallbackReason: string,
): TeachBackCriterionResult {
  if (
    !isRecord(value) ||
    typeof value.criterionId !== 'string' ||
    !criterionIds.has(value.criterionId) ||
    (value.status !== 'explained' &&
      value.status !== 'needs_supplement' &&
      value.status !== 'not_addressed')
  ) {
    throw new Error('Invalid teach-back criterion result');
  }
  const reason =
    typeof value.reason === 'string' && value.reason.trim()
      ? clipBoundedText(value.reason.trim(), TEACH_BACK_LIMITS.reasonCharacters)
      : clipBoundedText(fallbackReason, TEACH_BACK_LIMITS.reasonCharacters);
  const draft: TeachBackCriterionResult = {
    criterionId: value.criterionId,
    status: value.status,
    reason,
  };
  if (value.status !== 'not_addressed' && value.citation !== undefined) {
    try {
      draft.citation = parseCitation(value.citation, explanations);
    } catch {
      // Model slop must not discard a usable round; drop the bad citation.
    }
  }
  return draft;
}

function coerceNextQuestionDraft(
  value: unknown,
  criterionIds: ReadonlySet<string>,
  criteria: readonly Pick<TeachBackCriterionResult, 'criterionId' | 'status'>[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const incomplete = criteria.find((item) => item.status !== 'explained');
  if (!incomplete) return undefined;
  const text =
    typeof value.text === 'string' && value.text.trim()
      ? clipBoundedText(value.text.trim(), TEACH_BACK_LIMITS.questionCharacters)
      : '';
  if (!text) return undefined;
  const requested =
    typeof value.criterionId === 'string' && criterionIds.has(value.criterionId)
      ? value.criterionId
      : incomplete.criterionId;
  const target = criteria.find((item) => item.criterionId === requested);
  const criterionId = target && target.status !== 'explained' ? requested : incomplete.criterionId;
  const questionId =
    typeof value.questionId === 'string' && value.questionId.trim()
      ? clipBoundedText(value.questionId.trim(), TEACH_BACK_LIMITS.idCharacters)
      : `question-${criterionId}`;
  return { questionId, text, criterionId };
}

function suggestionFromCriteria(
  criteria: readonly Pick<TeachBackCriterionResult, 'criterionId' | 'status' | 'reason'>[],
  plan: TeachBackPlan,
): string {
  const incomplete = criteria.filter((item) => item.status !== 'explained');
  if (incomplete.length === 0) {
    const reasons = criteria.map((item) => item.reason.trim()).filter(Boolean);
    return clipBoundedText(reasons.join(' ') || plan.topic, TEACH_BACK_LIMITS.suggestionCharacters);
  }
  const parts = incomplete.map((item) => {
    const criterion = plan.criteria.find((entry) => entry.criterionId === item.criterionId);
    return [item.reason.trim(), criterion?.quote ?? criterion?.description ?? '']
      .filter(Boolean)
      .join(' ');
  });
  return clipBoundedText(parts.join(' ') || plan.topic, TEACH_BACK_LIMITS.suggestionCharacters);
}

const TEACH_BACK_CLOSING_COPY: Readonly<
  Record<string, { affirmation: string; correctionPrefix: string }>
> = Object.freeze({
  'zh-CN': { affirmation: '回答正确，讲得很好。', correctionPrefix: '正确解释：' },
  'zh-TW': { affirmation: '回答正確，講得很好。', correctionPrefix: '正確解釋：' },
  'en-US': { affirmation: 'Correct — well explained. ', correctionPrefix: 'Correct explanation: ' },
  'ja-JP': { affirmation: '正解です。よく説明できました。', correctionPrefix: '正しい説明：' },
  'ru-RU': {
    affirmation: 'Ответ верный — отлично объяснено. ',
    correctionPrefix: 'Правильное объяснение: ',
  },
  'ar-SA': { affirmation: 'إجابتك صحيحة، شرح رائع. ', correctionPrefix: 'الشرح الصحيح: ' },
  'pt-BR': {
    affirmation: 'Resposta correta, muito bem explicado. ',
    correctionPrefix: 'Explicação correta: ',
  },
  'ko-KR': { affirmation: '정답입니다. 잘 설명했어요. ', correctionPrefix: '올바른 설명: ' },
  'es-MX': {
    affirmation: 'Respuesta correcta, muy bien explicado. ',
    correctionPrefix: 'Explicación correcta: ',
  },
  'fr-FR': {
    affirmation: 'Bonne réponse, très bien expliqué. ',
    correctionPrefix: 'Explication correcte : ',
  },
  'vi-VN': {
    affirmation: 'Câu trả lời đúng, bạn giải thích rất tốt. ',
    correctionPrefix: 'Lời giải đúng: ',
  },
  'de-DE': {
    affirmation: 'Richtig beantwortet, gut erklärt. ',
    correctionPrefix: 'Richtige Erklärung: ',
  },
});

function teachBackClosingCopy(locale: string) {
  return TEACH_BACK_CLOSING_COPY[locale] ?? TEACH_BACK_CLOSING_COPY['en-US']!;
}

function courseGroundedCorrection(
  criteria: readonly Pick<TeachBackCriterionResult, 'criterionId' | 'status'>[],
  plan: TeachBackPlan,
  correctionPrefix: string,
): string {
  const answers = criteria
    .filter((item) => item.status !== 'explained')
    .map((item) => plan.criteria.find((entry) => entry.criterionId === item.criterionId))
    .filter((item): item is TeachBackCriterion => Boolean(item))
    .map((item) => item.quote.trim() || item.description.trim())
    .filter(Boolean);
  const prefix = correctionPrefix;
  if (answers.length === 0) return prefix + plan.topic;
  const separatorsLength = Math.max(0, answers.length - 1);
  const budget = Math.max(
    1,
    Math.floor(
      (TEACH_BACK_LIMITS.suggestionCharacters - prefix.length - separatorsLength) / answers.length,
    ),
  );
  return `${prefix}${answers.map((answer) => clipBoundedText(answer, budget)).join('；')}`;
}

export function teachBackClosingSpeech(result: TeachBackTurnResult, plan: TeachBackPlan): string {
  const spoken = result.suggestion.trim() || suggestionFromCriteria(result.criteria, plan);
  return clipBoundedText(spoken, TEACH_BACK_LIMITS.suggestionCharacters);
}

export function coerceTeachBackModelTurnResult(
  value: unknown,
  plan: TeachBackPlan,
  explanations: readonly TeachBackExplanation[],
  turnId: string,
  locale = 'zh-CN',
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid teach-back turn result');
  const explanation = explanations.find((item) => item.turnId === turnId);
  if (!explanation) throw new Error('Teach-back turn result is missing its explanation');
  if (!Array.isArray(value.criteria)) {
    throw new Error('Teach-back turn result must cover every frozen criterion');
  }

  const criterionIds = new Set(plan.criteria.map((item) => item.criterionId));
  const byId = new Map<string, unknown>();
  for (const item of value.criteria) {
    if (isRecord(item) && typeof item.criterionId === 'string' && !byId.has(item.criterionId)) {
      byId.set(item.criterionId, item);
    }
  }
  const criteria = plan.criteria.map((criterion) => {
    const raw = byId.get(criterion.criterionId);
    if (!raw) throw new Error('Teach-back turn result omitted a criterion');
    return coerceCriterionResultDraft(raw, criterionIds, explanations, criterion.description);
  });

  const ended = shouldEndTeachBackTurn({
    turnIndex: explanation.turnIndex,
    currentTurnId: turnId,
    criteria,
  });
  let suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : '';
  if (!suggestion) {
    suggestion = suggestionFromCriteria(criteria, plan);
  }
  const answeredCorrectly = criteria.some(
    (item) => item.status === 'explained' && item.citation?.turnId === turnId,
  );
  const allExplained =
    answeredCorrectly &&
    criteria.length > 0 &&
    criteria.every((item) => item.status === 'explained');
  const closingCopy = teachBackClosingCopy(locale);
  if (ended && answeredCorrectly) {
    const affirmation = closingCopy.affirmation;
    suggestion = suggestion.startsWith(affirmation) ? suggestion : `${affirmation}${suggestion}`;
  } else if (ended) {
    // The third failed explanation must end with the course-grounded answer,
    // independent of untrusted model feedback and within the fixed output budget.
    const grounded = courseGroundedCorrection(criteria, plan, closingCopy.correctionPrefix);
    const remaining = TEACH_BACK_LIMITS.suggestionCharacters - grounded.length - 1;
    suggestion =
      remaining > 0 && suggestion && !grounded.includes(suggestion)
        ? `${grounded} ${clipBoundedText(suggestion, remaining)}`
        : grounded;
  }
  suggestion = clipBoundedText(suggestion, TEACH_BACK_LIMITS.suggestionCharacters);

  const coerced: Record<string, unknown> = {
    turnId,
    criteria,
    suggestion,
  };
  if (ended) {
    coerced.endReason = allExplained
      ? 'all_explained'
      : answeredCorrectly
        ? 'answer_correct'
        : 'max_turns';
    return coerced;
  }
  const nextQuestion = coerceNextQuestionDraft(value.nextQuestion, criterionIds, criteria);
  if (nextQuestion) coerced.nextQuestion = nextQuestion;
  return coerced;
}

export function parseTeachBackTurnResult(
  value: unknown,
  plan: TeachBackPlan,
  explanations: readonly TeachBackExplanation[],
  turnId: string,
  locale = 'zh-CN',
): TeachBackTurnResult {
  const coerced = coerceTeachBackModelTurnResult(value, plan, explanations, turnId, locale);
  if (
    !boundedString(coerced.turnId, TEACH_BACK_LIMITS.idCharacters) ||
    coerced.turnId !== turnId ||
    !Array.isArray(coerced.criteria) ||
    !boundedString(coerced.suggestion, TEACH_BACK_LIMITS.suggestionCharacters, true)
  ) {
    throw new Error('Invalid teach-back turn result');
  }
  const explanation = explanations.find((item) => item.turnId === turnId);
  if (!explanation) throw new Error('Teach-back turn result is missing its explanation');

  const criterionIds = new Set(plan.criteria.map((item) => item.criterionId));
  if (coerced.criteria.length !== plan.criteria.length) {
    throw new Error('Teach-back turn result must cover every frozen criterion');
  }
  const criteria = coerced.criteria.map((item) =>
    parseCriterionResult(item, criterionIds, explanations),
  );
  const resultIds = criteria.map((item) => item.criterionId);
  if (new Set(resultIds).size !== resultIds.length) {
    throw new Error('Teach-back turn result repeats a criterion');
  }
  for (const expected of criterionIds) {
    if (!resultIds.includes(expected)) {
      throw new Error('Teach-back turn result omitted a criterion');
    }
  }

  const ended = shouldEndTeachBackTurn({
    turnIndex: explanation.turnIndex,
    currentTurnId: turnId,
    criteria,
  });
  const hasNext = coerced.nextQuestion !== undefined && coerced.nextQuestion !== null;
  if (ended && hasNext) {
    throw new Error('Ended teach-back turns cannot ask another question');
  }
  if (!ended && !hasNext) {
    throw new Error('Open teach-back turns must include exactly one next question');
  }
  if (
    ended &&
    coerced.endReason !== 'all_explained' &&
    coerced.endReason !== 'answer_correct' &&
    coerced.endReason !== 'max_turns'
  ) {
    throw new Error('Ended teach-back turns require an end reason');
  }
  if (!ended && coerced.endReason !== undefined) {
    throw new Error('Open teach-back turns cannot include an end reason');
  }

  const allowed = ['turnId', 'criteria', 'suggestion'];
  if (hasNext) allowed.push('nextQuestion');
  if (coerced.endReason !== undefined) allowed.push('endReason');
  if (!hasOnlyKeys(coerced, allowed)) {
    throw new Error('Invalid teach-back turn result');
  }

  const nextQuestion = hasNext ? parseQuestion(coerced.nextQuestion, criterionIds) : undefined;
  if (nextQuestion) {
    const target = criteria.find((item) => item.criterionId === nextQuestion.criterionId);
    if (!target || target.status === 'explained') {
      throw new Error('Next teach-back question must target an incomplete criterion');
    }
  }

  return {
    turnId,
    criteria,
    suggestion: coerced.suggestion as string,
    ...(nextQuestion ? { nextQuestion } : {}),
    ...(ended
      ? {
          endReason: coerced.endReason as 'all_explained' | 'answer_correct' | 'max_turns',
        }
      : {}),
  };
}

function parseStoredQuestion(value: unknown): TeachBackQuestion {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['questionId', 'text', 'criterionId']) ||
    !boundedString(value.questionId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.text, TEACH_BACK_LIMITS.questionCharacters) ||
    !boundedString(value.criterionId, TEACH_BACK_LIMITS.idCharacters)
  ) {
    throw new Error('Invalid stored teach-back question');
  }
  return {
    questionId: value.questionId,
    text: value.text,
    criterionId: value.criterionId,
  };
}

function parseStoredTurnResult(value: unknown): TeachBackTurnResult {
  if (
    !isRecord(value) ||
    !boundedString(value.turnId, TEACH_BACK_LIMITS.idCharacters) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length < TEACH_BACK_MIN_CRITERIA ||
    value.criteria.length > TEACH_BACK_MAX_CRITERIA ||
    !boundedString(value.suggestion, TEACH_BACK_LIMITS.suggestionCharacters, true)
  ) {
    throw new Error('Invalid stored teach-back turn result');
  }
  const criteria = value.criteria.map((item): TeachBackCriterionResult => {
    if (
      !isRecord(item) ||
      !boundedString(item.criterionId, TEACH_BACK_LIMITS.idCharacters) ||
      (item.status !== 'explained' &&
        item.status !== 'needs_supplement' &&
        item.status !== 'not_addressed') ||
      !boundedString(item.reason, TEACH_BACK_LIMITS.reasonCharacters)
    ) {
      throw new Error('Invalid stored criterion result');
    }
    const citation =
      item.citation === undefined
        ? undefined
        : isRecord(item.citation) &&
            boundedString(item.citation.turnId, TEACH_BACK_LIMITS.idCharacters) &&
            boundedString(item.citation.excerpt, TEACH_BACK_LIMITS.quoteCharacters)
          ? { turnId: item.citation.turnId, excerpt: item.citation.excerpt }
          : (() => {
              throw new Error('Invalid stored citation');
            })();
    return {
      criterionId: item.criterionId,
      status: item.status,
      reason: item.reason,
      ...(citation ? { citation } : {}),
    };
  });
  const nextQuestion =
    value.nextQuestion === undefined || value.nextQuestion === null
      ? undefined
      : parseStoredQuestion(value.nextQuestion);
  if (
    value.endReason !== undefined &&
    value.endReason !== 'all_explained' &&
    value.endReason !== 'answer_correct' &&
    value.endReason !== 'max_turns'
  ) {
    throw new Error('Invalid stored end reason');
  }
  return {
    turnId: value.turnId,
    criteria,
    suggestion: value.suggestion,
    ...(nextQuestion ? { nextQuestion } : {}),
    ...(value.endReason ? { endReason: value.endReason } : {}),
  };
}

function parseEvent(value: unknown): TeachBackEvent {
  if (!isRecord(value) || !boundedString(value.kind, 32) || !boundedString(value.createdAt, 64)) {
    throw new Error('Invalid teach-back event');
  }
  switch (value.kind) {
    case 'prepare_requested': {
      if (
        !hasOnlyKeys(value, ['kind', 'createdAt', 'requestId', 'source', 'topic', 'peer']) ||
        !boundedString(value.requestId, TEACH_BACK_LIMITS.idCharacters) ||
        !boundedString(value.topic, TEACH_BACK_LIMITS.topicCharacters)
      ) {
        throw new Error('Invalid prepare_requested event');
      }
      return {
        kind: 'prepare_requested',
        createdAt: value.createdAt,
        requestId: value.requestId,
        source: parseTeachBackSource(value.source),
        topic: value.topic,
        peer: parseTeachBackPeer(value.peer),
      };
    }
    case 'activity_prepared': {
      if (!hasOnlyKeys(value, ['kind', 'createdAt', 'plan', 'source'])) {
        throw new Error('Invalid activity_prepared event');
      }
      const source = parseTeachBackSource(value.source);
      return {
        kind: 'activity_prepared',
        createdAt: value.createdAt,
        source,
        plan: parseTeachBackPlan(value.plan, source),
      };
    }
    case 'explanation_submitted': {
      if (!hasOnlyKeys(value, ['kind', 'createdAt', 'explanation'])) {
        throw new Error('Invalid explanation_submitted event');
      }
      return {
        kind: 'explanation_submitted',
        createdAt: value.createdAt,
        explanation: parseTeachBackExplanation(value.explanation),
      };
    }
    case 'evaluation_requested': {
      if (
        !hasOnlyKeys(value, ['kind', 'createdAt', 'requestId', 'turnId']) ||
        !boundedString(value.requestId, TEACH_BACK_LIMITS.idCharacters) ||
        !boundedString(value.turnId, TEACH_BACK_LIMITS.idCharacters)
      ) {
        throw new Error('Invalid evaluation_requested event');
      }
      return {
        kind: 'evaluation_requested',
        createdAt: value.createdAt,
        requestId: value.requestId,
        turnId: value.turnId,
      };
    }
    case 'turn_evaluated': {
      if (!hasOnlyKeys(value, ['kind', 'createdAt', 'result'])) {
        throw new Error('Invalid turn_evaluated event');
      }
      return {
        kind: 'turn_evaluated',
        createdAt: value.createdAt,
        result: parseStoredTurnResult(value.result),
      };
    }
    case 'activity_suspended': {
      if (
        !hasOnlyKeys(value, ['kind', 'createdAt', 'reason']) ||
        (value.reason !== 'reload' &&
          value.reason !== 'hidden' &&
          value.reason !== 'scene_switch' &&
          value.reason !== 'edit' &&
          value.reason !== 'cancelled_request')
      ) {
        throw new Error('Invalid activity_suspended event');
      }
      return {
        kind: 'activity_suspended',
        createdAt: value.createdAt,
        reason: value.reason,
      };
    }
    case 'activity_resumed': {
      if (!hasOnlyKeys(value, ['kind', 'createdAt'])) {
        throw new Error('Invalid activity_resumed event');
      }
      return { kind: 'activity_resumed', createdAt: value.createdAt };
    }
    case 'activity_finished': {
      if (
        !hasOnlyKeys(value, ['kind', 'createdAt', 'reason']) ||
        (value.reason !== 'completed' &&
          value.reason !== 'manual_stop' &&
          value.reason !== 'source_changed' &&
          value.reason !== 'budget_exhausted')
      ) {
        throw new Error('Invalid activity_finished event');
      }
      return {
        kind: 'activity_finished',
        createdAt: value.createdAt,
        reason: value.reason,
      };
    }
    default:
      throw new Error('Unknown teach-back event');
  }
}

export function isTeachBackRecordPayloadV1(value: unknown): value is TeachBackRecordPayloadV1 {
  try {
    parseTeachBackRecordPayload(value);
    return true;
  } catch {
    return false;
  }
}

export function parseTeachBackRecordPayload(value: unknown): TeachBackRecordPayloadV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['payloadVersion', 'activityId', 'commandId', 'event']) ||
    value.payloadVersion !== TEACH_BACK_SCHEMA_VERSION ||
    !boundedString(value.activityId, TEACH_BACK_LIMITS.idCharacters) ||
    !boundedString(value.commandId, TEACH_BACK_LIMITS.idCharacters)
  ) {
    throw new Error('Invalid teach-back record payload');
  }
  return {
    payloadVersion: TEACH_BACK_SCHEMA_VERSION,
    activityId: value.activityId,
    commandId: value.commandId,
    event: parseEvent(value.event),
  };
}

export const teachBackRuntimePayloadValidator: RuntimePayloadValidator = (payload) =>
  isTeachBackRecordPayloadV1(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [{ path: '/payload', message: 'teachBack payload must match version 1' }],
      };

export function parseTeachBackApiInput(value: unknown): TeachBackApiInput {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw new Error('Invalid teach-back request');
  }
  if (value.operation === 'prepare') {
    if (
      !boundedString(value.activityId, TEACH_BACK_LIMITS.idCharacters) ||
      !boundedString(value.requestId, TEACH_BACK_LIMITS.idCharacters) ||
      !boundedString(value.topic, TEACH_BACK_LIMITS.topicCharacters)
    ) {
      throw new Error('Invalid teach-back prepare request');
    }
    return {
      operation: 'prepare',
      activityId: value.activityId,
      requestId: value.requestId,
      source: parseTeachBackSource(value.source),
      topic: value.topic,
      peer: parseTeachBackPeer(value.peer),
    };
  }
  if (value.operation === 'evaluate') {
    if (
      !boundedString(value.activityId, TEACH_BACK_LIMITS.idCharacters) ||
      !boundedString(value.requestId, TEACH_BACK_LIMITS.idCharacters) ||
      !boundedString(value.turnId, TEACH_BACK_LIMITS.idCharacters) ||
      (value.locale !== undefined && !boundedString(value.locale, 16)) ||
      !Array.isArray(value.explanations) ||
      value.explanations.length > TEACH_BACK_MAX_EXPLANATIONS ||
      !Array.isArray(value.priorResults) ||
      value.priorResults.length > TEACH_BACK_MAX_EXPLANATIONS
    ) {
      throw new Error('Invalid teach-back evaluate request');
    }
    const source = parseTeachBackSource(value.source);
    const plan = parseTeachBackPlan(value.plan, source);
    const questionIds = new Set<string>([
      plan.openingQuestion.questionId,
      ...((value.priorResults as unknown[])
        .map((item) =>
          isRecord(item) && isRecord(item.nextQuestion) ? String(item.nextQuestion.questionId) : '',
        )
        .filter(Boolean) as string[]),
    ]);
    const explanations = value.explanations.map((item) =>
      parseTeachBackExplanation(item, questionIds),
    );
    if (!explanations.some((item) => item.turnId === value.turnId)) {
      throw new Error('Evaluate request turnId is not in the submitted explanations');
    }
    const priorResults = (value.priorResults as unknown[]).map((item, index) => {
      const priorTurn = explanations[index];
      if (!isRecord(item) || !priorTurn || item.turnId !== priorTurn.turnId) {
        throw new Error('Prior teach-back results must follow submitted turns');
      }
      return parseTeachBackTurnResult(
        item,
        plan,
        explanations.slice(0, index + 1),
        priorTurn.turnId,
        typeof value.locale === 'string' ? value.locale : 'zh-CN',
      );
    });
    return {
      operation: 'evaluate',
      activityId: value.activityId,
      requestId: value.requestId,
      source,
      plan,
      explanations,
      priorResults,
      turnId: value.turnId,
      ...(typeof value.locale === 'string' ? { locale: value.locale } : {}),
    };
  }
  throw new Error('Invalid teach-back operation');
}

export function sameTeachBackSource(left: TeachBackSource, right: TeachBackSource): boolean {
  return (
    left.stageId === right.stageId &&
    left.sceneId === right.sceneId &&
    left.sourceRevision === right.sourceRevision &&
    left.snapshotAlgorithmVersion === right.snapshotAlgorithmVersion
  );
}
