/**
 * Learning events, preferences and Memory (learning plan B06): wire
 * contracts shared by the study APIs, the agent runner and the Memory page.
 * Pure — no Next.js, browser store or database imports.
 *
 * Three things are kept apart:
 * - learning records: events derived by rule from facts the server saved
 *   (watching a course, submitting a classroom quiz, asking a classmate).
 *   They describe what happened. Watching is a viewing record, never mastery.
 * - preferences and facts: what the student chose or wrote (or confirmed in
 *   a prompt). Nothing here is inferred from chats.
 * - recent state: a rule-based aggregation of recent records (no model call).
 */

// ── learning events ─────────────────────────────────────────────────────────

/**
 * Event types. `hint_used` and `review_done` have no producer yet (hints
 * arrive with practice in B10/B11, reviews with B12): the types and payload
 * shapes are fixed now so those batches only add a producer; no history is
 * invented for them. `exam_graded` comes from B07 subject papers.
 */
export const LEARNING_EVENT_TYPES = [
  'course_started',
  'course_progressed',
  'course_finished',
  'quiz_submitted',
  'quiz_graded',
  'hint_used',
  'review_done',
  'companion_question',
  'exam_graded',
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

export const LEARNING_SOURCE_TYPES = [
  'study_progress',
  'quiz_attempt',
  'companion_chat',
  'exam_attempt',
  // Reserved for a later producer (review tasks, B12).
  'review_task',
] as const;
export type LearningSourceType = (typeof LEARNING_SOURCE_TYPES)[number];

/** Payload v1 per event type. Small on purpose: titles and names are joined at read time. */
export interface LearningEventPayloads {
  course_started: Record<string, never>;
  /** Pages are 1-based for display. */
  course_progressed: { furthestPage: number; pageCount: number };
  /** Watched to the end of the last page. Not completion of learning, not mastery. */
  course_finished: { pageCount: number };
  quiz_submitted: { sceneId: string; questionCount: number };
  quiz_graded: {
    sceneId: string;
    questionCount: number;
    /**
     * Choice questions re-graded on the server against the course as stored
     * (`server_checked`); `unverified` when the quiz changed since or the
     * attempt cannot be matched — then no objective score is reported.
     */
    verification: 'server_checked' | 'unverified';
    objective: { correct: number; total: number } | null;
    /** Open questions graded by the AI grader, as the classroom recorded them. */
    aiGraded: { count: number; earned: number; points: number } | null;
  };
  hint_used: {
    contextKind: 'exam_item' | 'practice' | 'classroom';
    contextId: string;
    level: number;
  };
  review_done: { reviewTaskId: string; outcome: 'done' | 'skipped' | 'postponed' };
  companion_question: { sessionId: string; classmateId: string; preview: string };
  /**
   * A submitted subject paper, graded on the server against its frozen key
   * (objective items only in B07). With open items (B09) it is recorded once
   * each has been graded, and the totals include them (`openItems` of them
   * were graded with assistance). The paper title is joined at read time.
   */
  exam_graded: {
    paperId: string;
    itemCount: number;
    correct: number;
    unanswered: number;
    earned: number;
    totalPoints: number;
    openItems?: number;
  };
}

export interface LearningEventInput<T extends LearningEventType = LearningEventType> {
  type: T;
  payloadVersion: 1;
  sourceType: LearningSourceType;
  sourceId: string;
  /** Unique per owner: the same saved fact always maps to the same key. */
  sourceKey: string;
  stageId: string | null;
  spaceId: string | null;
  occurredAt: string;
  payload: LearningEventPayloads[T];
}

export interface LearningRecordView {
  seq: number;
  type: LearningEventType;
  sourceType: LearningSourceType;
  sourceKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  course: { stageId: string; title: string } | null;
  /** Spaces the record belongs to: the chat's space, or every space the course is in. */
  spaceIds: string[];
  classmate: { id: string; name: string } | null;
  /** A subject paper record: its paper (title null once the paper was deleted). */
  paper: { id: string; title: string | null } | null;
  correction: { factId: string; text: string; updatedAt: string } | null;
}

// ── preferences ─────────────────────────────────────────────────────────────

export const PREFERENCE_CHOICES = {
  explanation_length: ['brief', 'standard', 'detailed'],
  example_order: ['example_first', 'definition_first'],
  hint_mode: ['hint_first', 'direct'],
} as const;
export type ChoicePreferenceKey = keyof typeof PREFERENCE_CHOICES;
export type PreferenceKey = ChoicePreferenceKey | 'learning_goal';
export const PREFERENCE_KEYS: readonly PreferenceKey[] = [
  'explanation_length',
  'example_order',
  'hint_mode',
  'learning_goal',
];
export type PreferenceOrigin = 'settings' | 'confirmed_prompt';

export interface PreferenceEvidence {
  /** The after-class chat the student confirmed the preference in. */
  sessionId?: string;
  /** The student's own words that triggered the prompt (bounded). */
  excerpt?: string;
}

export interface PreferenceView {
  key: PreferenceKey;
  value: string;
  /** null = all subjects. */
  spaceId: string | null;
  origin: PreferenceOrigin;
  evidence: PreferenceEvidence | null;
  revision: number;
  updatedAt: string;
}

// ── facts ───────────────────────────────────────────────────────────────────

export type FactOrigin = 'manual' | 'confirmed_prompt' | 'correction';

export interface FactView {
  id: string;
  spaceId: string | null;
  text: string;
  origin: FactOrigin;
  /** For a correction: the learning record it corrects. */
  correctsKey: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// ── controls ────────────────────────────────────────────────────────────────

export interface MemoryControlView {
  enabled: boolean;
  revision: number;
  enabledSince: string | null;
  updatedAt: string | null;
}

export interface MemorySpaceControlView extends MemoryControlView {
  spaceId: string;
  name: string;
  status: 'active' | 'archived';
}

export const MEMORY_LIMITS = {
  factsPerOwner: 100,
  factChars: 200,
  goalChars: 200,
  /** Records the Memory page lists. */
  recordsListed: 80,
  /** What one after-class turn may receive. */
  injectItems: 8,
  injectFacts: 4,
  injectTokens: 300,
  /** Recent-state window. */
  recentDays: 14,
  /** Characters of a chat question kept in its learning record. */
  questionPreview: 60,
} as const;

// ── suppressions ────────────────────────────────────────────────────────────

export type SuppressionKind = 'event' | 'preference' | 'suggestion' | 'summary';

/** The key that blocks one preference value from being suggested again. */
export function preferenceSuppressionKey(key: PreferenceKey, value: string): string {
  return `${key}=${value}`;
}

// ── validation ──────────────────────────────────────────────────────────────

export function isPreferenceKey(value: unknown): value is PreferenceKey {
  return typeof value === 'string' && (PREFERENCE_KEYS as readonly string[]).includes(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text || Array.from(text).length > max) return null;
  return text;
}

/** A valid stored value for the key, or null. */
export function parsePreferenceValue(key: PreferenceKey, value: unknown): string | null {
  if (key === 'learning_goal') return cleanText(value, MEMORY_LIMITS.goalChars);
  return typeof value === 'string' && (PREFERENCE_CHOICES[key] as readonly string[]).includes(value)
    ? value
    : null;
}

export function parseFactText(value: unknown): string | null {
  return cleanText(value, MEMORY_LIMITS.factChars);
}

export function parseEvidence(value: unknown): PreferenceEvidence | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const evidence: PreferenceEvidence = {};
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.sessionId)) {
      return undefined;
    }
    evidence.sessionId = raw.sessionId;
  }
  if (raw.excerpt !== undefined) {
    const excerpt =
      typeof raw.excerpt === 'string'
        ? Array.from(raw.excerpt.replace(/\s+/gu, ' ').trim()).slice(0, 120).join('')
        : null;
    if (!excerpt) return undefined;
    evidence.excerpt = excerpt;
  }
  return evidence;
}

// ── confirm prompts (explicit statements only) ─────────────────────────────

export interface PreferenceSuggestion {
  key: ChoicePreferenceKey;
  value: string;
}

/**
 * Words that make a statement a standing wish rather than a one-off request
 * ("以后先举例" vs. "这题先举个例子").
 */
const STANDING =
  /(以后|今后|之后都|往后|每次|每回|总是|一直|默认|平时|我(更)?喜欢|我(更)?习惯|我(更)?希望|我想要你|请你以后|from now on|always|in future|i prefer|i like it when)/iu;

const STATEMENTS: Array<{ pattern: RegExp; suggestion: PreferenceSuggestion }> = [
  {
    pattern:
      /(先|多)(举|给|来)(一?个|几个|点)?(具体的?)?例子|先举例|example first|start with an example/iu,
    suggestion: { key: 'example_order', value: 'example_first' },
  },
  {
    pattern: /先(讲|给|说|写)(出)?(定义|概念|公式)|definition first|start with the definition/iu,
    suggestion: { key: 'example_order', value: 'definition_first' },
  },
  {
    pattern:
      /先给(我)?(一?点|一些)?提示|别直接(告诉|给)(我)?答案|不要直接(告诉|给)(我)?答案|hints? first|don'?t give (me )?the answer/iu,
    suggestion: { key: 'hint_mode', value: 'hint_first' },
  },
  {
    pattern: /直接(告诉|给)(我)?(答案|解答)|不(用|要)(给)?(我)?提示|just give me the answer/iu,
    suggestion: { key: 'hint_mode', value: 'direct' },
  },
  {
    pattern:
      /(讲|说|解释|回答)(得)?(简短|简单|短|简洁)一?(点|些)|(简短|简洁)(一?点|些)?(地)?(讲|说|回答)|keep it short|be brief/iu,
    suggestion: { key: 'explanation_length', value: 'brief' },
  },
  {
    pattern:
      /(讲|说|解释|回答)(得)?(详细|细|仔细)一?(点|些)|(详细|仔细)(地)?(讲|说|解释)|more detail/iu,
    suggestion: { key: 'explanation_length', value: 'detailed' },
  },
];

/**
 * Preferences the student explicitly stated as a standing wish in one
 * message (rule-based, no model call). The chat page offers them as a
 * confirm prompt; nothing is stored unless the student confirms.
 */
export function detectPreferenceStatements(text: string): PreferenceSuggestion[] {
  if (!STANDING.test(text)) return [];
  const found: PreferenceSuggestion[] = [];
  for (const { pattern, suggestion } of STATEMENTS) {
    if (!pattern.test(text)) continue;
    if (found.some((item) => item.key === suggestion.key)) continue;
    found.push(suggestion);
  }
  return found;
}

/**
 * The statements worth a confirm prompt: not already the effective value in
 * this subject, and not deleted or declined before (suppressed).
 */
export function suggestionsToOffer(
  text: string,
  preferences: ReadonlyArray<Pick<PreferenceView, 'key' | 'value' | 'spaceId'>>,
  suppressedKeys: ReadonlySet<string>,
  spaceId: string | null,
): PreferenceSuggestion[] {
  return detectPreferenceStatements(text).filter((suggestion) => {
    if (suppressedKeys.has(preferenceSuppressionKey(suggestion.key, suggestion.value))) {
      return false;
    }
    return effectivePreference(preferences, suggestion.key, spaceId)?.value !== suggestion.value;
  });
}

/** The value that applies in a subject: the subject's own wins over the global one. */
export function effectivePreference<P extends Pick<PreferenceView, 'key' | 'spaceId'>>(
  preferences: readonly P[],
  key: PreferenceKey,
  spaceId: string | null,
): P | undefined {
  return (
    (spaceId
      ? preferences.find((item) => item.key === key && item.spaceId === spaceId)
      : undefined) ?? preferences.find((item) => item.key === key && !item.spaceId)
  );
}

// ── what a turn receives ────────────────────────────────────────────────────

export type MemoryContextState =
  /** Preferences/facts were selected (possibly none existed). */
  | 'on'
  /** The student turned Memory off globally. */
  | 'off'
  /** Memory is off for this subject. */
  | 'space_off'
  /** The feature is off or the tables are missing: nothing read. */
  | 'unavailable';

export interface MemoryContextItem {
  /** Stable reference, e.g. `pref:example_order@global`, `fact:mf-…`, `goal:space`. */
  ref: string;
  kind: 'preference' | 'fact' | 'goal';
  text: string;
}

/** Recorded with each after-class turn (`study_companion_turn.memory`). */
export interface MemoryTurnInfo {
  state: MemoryContextState;
  /** References of what was put in the model context (empty unless `on`). */
  refs: string[];
  tokens: number;
}

/** One instruction line per choice; every choice must have one. */
type PreferenceLines = {
  [K in ChoicePreferenceKey]: Record<(typeof PREFERENCE_CHOICES)[K][number], string>;
};

const PREFERENCE_LINES: PreferenceLines = {
  explanation_length: {
    brief: '讲解尽量简短：先给结论和关键步骤，学生追问再展开。',
    standard: '讲解长度适中。',
    detailed: '讲解详细一些：把推导步骤和理由写完整。',
  },
  example_order: {
    example_first: '先举一个具体例子，再讲定义或一般规律。',
    definition_first: '先给出定义或一般规律，再举例说明。',
  },
  hint_mode: {
    hint_first: '先给提示或引导性问题，让学生自己想；学生明确要求时再给完整解答。',
    direct: '直接给出完整的解释和答案，不必先设问。',
  },
};

function quote(text: string): string {
  return text.replace(/[\u0000-\u001f]/gu, ' ').replace(/["“”]/gu, '＂');
}

/** Rough token count: CJK characters ~1 token each, other text ~4 characters per token. */
export function approximateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[⺀-鿿가-힯豈-﫿＀-￯]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export interface MemoryContextInput {
  /** Global and this-subject preferences; the subject's value wins for the same key. */
  preferences: ReadonlyArray<Pick<PreferenceView, 'key' | 'value' | 'spaceId'>>;
  /** Global and this-subject facts (corrections excluded), newest first. */
  facts: ReadonlyArray<Pick<FactView, 'id' | 'text' | 'spaceId' | 'origin'>>;
  /** The study space's own goal and exam date (B01), when set. */
  spaceGoal: { goal: string | null; examDate: string | null } | null;
  spaceId: string;
}

function preferenceRef(item: Pick<PreferenceView, 'key' | 'spaceId'>): string {
  return `pref:${item.key}@${item.spaceId ? 'space' : 'global'}`;
}

/** The explanation-style preferences in effect, one line each (no learning goal). */
function preferenceItems(
  preferences: MemoryContextInput['preferences'],
  spaceId: string | null,
  lines: PreferenceLines,
): MemoryContextItem[] {
  const items: MemoryContextItem[] = [];
  for (const key of Object.keys(PREFERENCE_CHOICES) as ChoicePreferenceKey[]) {
    const chosen = effectivePreference(preferences, key, spaceId);
    const text = chosen ? (lines[key] as Record<string, string>)[chosen.value] : undefined;
    if (chosen && text) items.push({ ref: preferenceRef(chosen), kind: 'preference', text });
  }
  return items;
}

/**
 * Pick the few items one turn receives: preferences first (subject over
 * global), then the subject goal, then facts (subject before global,
 * newest first), within the item and token caps.
 */
export function selectMemoryContext(
  input: MemoryContextInput,
  limits: { items: number; facts: number; tokens: number } = {
    items: MEMORY_LIMITS.injectItems,
    facts: MEMORY_LIMITS.injectFacts,
    tokens: MEMORY_LIMITS.injectTokens,
  },
): MemoryContextItem[] {
  const candidates: MemoryContextItem[] = [];
  candidates.push(...preferenceItems(input.preferences, input.spaceId, PREFERENCE_LINES));
  const goal = effectivePreference(input.preferences, 'learning_goal', input.spaceId);
  if (goal) {
    candidates.push({
      ref: preferenceRef(goal),
      kind: 'preference',
      text: `学生的学习目标：「${quote(goal.value)}」`,
    });
  }
  if (input.spaceGoal?.goal || input.spaceGoal?.examDate) {
    const parts = [
      input.spaceGoal.goal ? `本学科目标：「${quote(input.spaceGoal.goal)}」` : '',
      input.spaceGoal.examDate ? `考试日期 ${input.spaceGoal.examDate}` : '',
    ].filter(Boolean);
    candidates.push({ ref: 'goal:space', kind: 'goal', text: parts.join('；') });
  }
  const facts = [
    ...input.facts.filter((fact) => fact.spaceId === input.spaceId),
    ...input.facts.filter((fact) => !fact.spaceId),
  ]
    .filter((fact) => fact.origin !== 'correction')
    .slice(0, limits.facts);
  for (const fact of facts) {
    candidates.push({
      ref: `fact:${fact.id}`,
      kind: 'fact',
      text: `学生说过：「${quote(fact.text)}」`,
    });
  }
  const chosen: MemoryContextItem[] = [];
  let tokens = 0;
  for (const item of candidates) {
    if (chosen.length >= limits.items) break;
    const cost = approximateTokens(item.text) + 2;
    if (tokens + cost > limits.tokens) continue;
    tokens += cost;
    chosen.push(item);
  }
  return chosen;
}

/** The system-prompt block for the chosen items ('' when none). */
export function renderMemoryBlock(items: readonly MemoryContextItem[]): string {
  if (items.length === 0) return '';
  return [
    '学生在 Memory 里设定的偏好与情况（由学生本人填写或确认；所有学伴共用）：',
    ...items.map((item) => `- ${item.text}`),
    '直接按这些偏好来讲；学生在本轮另有要求时以本轮要求为准。不要提到偏好或设定本身（不要说“按你的偏好”“根据你的设定”之类的话），也不要向学生复述这段内容，更不要把它当作学生已经掌握某个知识点的证据。',
  ].join('\n');
}

// ── what a classroom reply receives ─────────────────────────────────────────

/**
 * The live classroom (/api/chat, /api/chat/pi) receives the explanation-style
 * preferences only — no facts, goals or records: several agents speak there,
 * and none should repeat personal details aloud. The lines are English like
 * the rest of the classroom prompts; the course's language rule still decides
 * the language of the reply.
 */
const CLASSROOM_PREFERENCE_LINES: PreferenceLines = {
  explanation_length: {
    brief: 'Keep explanations short: the conclusion and key step first; expand only when asked.',
    standard: 'Use a moderate explanation length.',
    detailed: 'Explain in more detail: give the full reasoning steps, within your length limit.',
  },
  example_order: {
    example_first: 'Start with one concrete example, then give the definition or general rule.',
    definition_first: 'Give the definition or general rule first, then an example.',
  },
  hint_mode: {
    hint_first:
      'Give a hint or guiding question first and let the student think; give the full answer when they ask for it.',
    direct: 'Explain directly and completely; no need to ask a guiding question first.',
  },
};

export interface ClassroomSubject {
  spaceId: string;
  /** This subject's Memory switch. */
  enabled: boolean;
}

/**
 * Which subject's preferences a classroom uses. A course in no subject uses
 * the global ones; a course whose subjects all have Memory off gets nothing
 * (`space_off`). A subject's own preferences apply when exactly one of the
 * course's subjects has Memory on; with several, only the global ones do,
 * since no single subject's choice is clearly the one for this course.
 */
export function classroomPreferenceScope(
  subjects: readonly ClassroomSubject[],
): { state: 'on'; spaceId: string | null } | { state: 'space_off' } {
  if (subjects.length === 0) return { state: 'on', spaceId: null };
  const enabled = subjects.filter((subject) => subject.enabled);
  if (enabled.length === 0) return { state: 'space_off' };
  return { state: 'on', spaceId: enabled.length === 1 ? enabled[0].spaceId : null };
}

export function selectClassroomPreferences(
  preferences: MemoryContextInput['preferences'],
  spaceId: string | null,
): MemoryContextItem[] {
  return preferenceItems(preferences, spaceId, CLASSROOM_PREFERENCE_LINES);
}

/** The classroom system-prompt section for the chosen preferences ('' when none). */
export function renderClassroomPreferenceBlock(items: readonly MemoryContextItem[]): string {
  if (items.length === 0) return '';
  return [
    '# Learner Preferences',
    'Set or confirmed by the student in Memory; they apply to every teacher and classmate:',
    ...items.map((item) => `- ${item.text}`),
    'Just explain this way, within your role and length limits. If the student asks for something different in this message, follow the message. Never mention preferences or settings aloud (do not say things like "as you prefer").',
  ].join('\n');
}

// ── B12 interface: summaries rebuilt only on change ─────────────────────────

/**
 * What a derived summary (B12) is computed from. A summary is regenerated
 * only when `inputHash` differs from the stored one; `sourceWatermark` is the
 * highest event `seq` it covered. B06 computes these for the rule-based
 * recent state and stores no summary.
 */
export interface MemorySummaryBasis {
  spaceId: string | null;
  sourceWatermark: number | null;
  inputHash: string;
  policyVersion: string;
}

export function summaryNeedsRefresh(
  previous: MemorySummaryBasis | null,
  next: MemorySummaryBasis,
): boolean {
  return (
    !previous ||
    previous.inputHash !== next.inputHash ||
    previous.policyVersion !== next.policyVersion
  );
}
