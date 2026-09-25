import {
  boundedString,
  parseTeachBackPlan,
  parseTeachBackTurnResult,
  readableSourceLength,
  TEACH_BACK_LIMITS,
  TEACH_BACK_MAX_EXPLANATIONS,
  type TeachBackApiInput,
  type TeachBackApiOutput,
  type TeachBackErrorCode,
  type TeachBackPeer,
  type TeachBackSource,
} from '@/lib/learning/teach-back/contracts';

export class TeachBackModelError extends Error {
  constructor(
    readonly code: TeachBackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TeachBackModelError';
  }
}

export interface TeachBackModelCall {
  system: string;
  prompt: string;
  signal: AbortSignal;
  maxRetries: 0;
  maxOutputTokens: number;
}

export type TeachBackCallModel = (request: TeachBackModelCall) => Promise<{ text: string }>;

export interface TeachBackServerDependencies {
  callModel: TeachBackCallModel;
  signal?: AbortSignal;
  perCallTimeoutMs?: number;
}

const PREPARE_SYSTEM = `You help a classroom companion prepare one reverse-teaching activity.
The student will explain a current lesson page to the companion. You only use the supplied course fragments.
Return JSON only, no markdown, no tools, no hidden reasoning, no extra keys.

Schema:
{
  "topic": string,
  "criteria": [{"criterionId":"criterion-1","description":string,"quote":string,"fragmentId":string}],
  "openingQuestion": {"questionId":"question-open","text":string,"criterionId":"criterion-1"}
}

Rules:
- Choose 1 to 3 criteria that the course fragments can support with exact contiguous quotes.
- quote must be copied verbatim from the named fragment.
- openingQuestion asks one concrete question about the first incomplete idea. Do not give the answer.
- Do not invent facts that are not in the fragments.
- Do not mention quizzes answers, hidden keys, or tool calls.
- Keep topic <= 120 characters and each question <= 300 characters.`;

const EVALUATE_SYSTEM = `You are one classroom companion listening to a student's explanation.
Judge only the frozen criteria against the student's actual words and the supplied course fragments.
Return JSON only, no markdown, no tools, no hidden reasoning, no extra keys.

Schema:
{
  "turnId": string,
  "criteria": [{"criterionId":string,"status":"explained"|"needs_supplement"|"not_addressed","reason":string,"citation":{"turnId":string,"excerpt":string}}],
  "nextQuestion": {"questionId":string,"text":string,"criterionId":string} | null,
  "endReason": "all_explained"|"answer_correct"|"max_turns"|null,
  "suggestion": string
}

Rules:
- Cover every frozen criterion exactly once. Do not add criteria.
- explained / needs_supplement citations must be contiguous excerpts from a real student explanation turnId. If you cannot quote the student exactly, omit citation. A criterion counts as correctly answered on this turn only when its explained citation uses the exact Evaluate turnId.
- not_addressed must omit citation and must not invent student wording.
- needs_supplement must say what is missing (reason, condition, or example).
- Re-evaluate from the full explanation history; later corrections may change earlier judgments.
- suggestion is spoken aloud to the student as your turn. It is not an internal note.
- If the current answer correctly explains any frozen criterion, prove that with an explained citation from the exact Evaluate turnId, stop immediately, and affirm it. Use endReason "all_explained" when every criterion is explained, otherwise "answer_correct". nextQuestion must be null.
- If this is the third explanation and the current answer does not correctly explain any criterion: nextQuestion must be null, endReason "max_turns", and suggestion must give the correct explanation from the course fragments for the remaining gaps. Never ask a fourth question.
- Otherwise nextQuestion is required, points at one incomplete criterion, and endReason must be null.
- Ask only one targeted follow-up while the round is still open. Do not lecture, do not call tools, do not rewrite the course.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new TeachBackModelError('invalid_output', 'Model did not return JSON');
  }
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!isRecord(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new TeachBackModelError('invalid_output', 'Model returned invalid JSON');
  }
}

export function assertUsableSource(source: TeachBackSource): void {
  const usable = source.fragments.some(
    (fragment) => readableSourceLength(fragment.text) >= TEACH_BACK_LIMITS.minSourceCharacters,
  );
  if (!usable) {
    throw new TeachBackModelError(
      'insufficient_source',
      'Current page has no usable course excerpt',
    );
  }
}

function abortError(signal?: AbortSignal): DOMException {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : new DOMException('The teach-back request was aborted.', 'AbortError');
}

async function once(
  dependencies: TeachBackServerDependencies,
  system: string,
  prompt: string,
): Promise<string> {
  const caller = dependencies.signal;
  if (caller?.aborted) throw abortError(caller);
  const timeout = AbortSignal.timeout(
    dependencies.perCallTimeoutMs ?? TEACH_BACK_LIMITS.perCallTimeoutMs,
  );
  const signals = [timeout, ...(caller ? [caller] : [])];
  const signal = AbortSignal.any(signals);
  try {
    const result = await dependencies.callModel({
      system,
      prompt,
      signal,
      maxRetries: 0,
      maxOutputTokens: TEACH_BACK_LIMITS.maxOutputTokens,
    });
    if (!boundedString(result.text, 8_000, true) || result.text.trim().length === 0) {
      throw new TeachBackModelError('invalid_output', 'Model returned an empty result');
    }
    return result.text;
  } catch (error) {
    if (caller?.aborted) throw abortError(caller);
    if (error instanceof TeachBackModelError) throw error;
    if (
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new TeachBackModelError('timeout', 'Teach-back model call timed out');
    }
    throw new TeachBackModelError(
      'model_unavailable',
      error instanceof Error ? error.message : 'Teach-back model call failed',
    );
  }
}

function fragmentsBlock(source: TeachBackSource): string {
  return source.fragments
    .map((fragment) => `FRAGMENT ${fragment.id}\n${fragment.text}`)
    .join('\n\n');
}

export async function runTeachBackPrepare(
  input: Extract<TeachBackApiInput, { operation: 'prepare' }>,
  peer: TeachBackPeer,
  dependencies: TeachBackServerDependencies,
): Promise<Extract<TeachBackApiOutput, { operation: 'prepare' }>> {
  assertUsableSource(input.source);
  if (peer.id !== input.peer.id || peer.role === 'teacher') {
    throw new TeachBackModelError(
      'invalid_request',
      'Teach-back peer is not a configured companion',
    );
  }
  const prompt = [
    `Course title: ${input.source.courseTitle}`,
    `Page title: ${input.source.title}`,
    `Requested topic: ${input.topic}`,
    `Companion: ${peer.name} (${peer.role})`,
    'Course fragments:',
    fragmentsBlock(input.source),
  ].join('\n');
  const raw = extractJsonObject(await once(dependencies, PREPARE_SYSTEM, prompt));
  raw.peer = peer;
  try {
    const plan = parseTeachBackPlan(raw, input.source);
    return { operation: 'prepare', plan };
  } catch (error) {
    throw new TeachBackModelError(
      'invalid_output',
      error instanceof Error ? error.message : 'Prepare result failed validation',
    );
  }
}

export async function runTeachBackEvaluate(
  input: Extract<TeachBackApiInput, { operation: 'evaluate' }>,
  dependencies: TeachBackServerDependencies,
): Promise<Extract<TeachBackApiOutput, { operation: 'evaluate' }>> {
  assertUsableSource(input.source);
  const current = input.explanations.find((item) => item.turnId === input.turnId);
  if (!current) {
    throw new TeachBackModelError('invalid_request', 'Missing current explanation');
  }
  if (current.turnIndex > TEACH_BACK_MAX_EXPLANATIONS) {
    throw new TeachBackModelError('invalid_request', 'Teach-back already used three explanations');
  }
  if (input.priorResults.some((item) => item.turnId === input.turnId)) {
    throw new TeachBackModelError('invalid_request', 'This explanation already has a result');
  }
  const prompt = [
    `Frozen topic: ${input.plan.topic}`,
    `Criteria: ${JSON.stringify(input.plan.criteria)}`,
    `Opening question: ${JSON.stringify(input.plan.openingQuestion)}`,
    `Prior official results: ${JSON.stringify(input.priorResults)}`,
    `Student explanations: ${JSON.stringify(input.explanations)}`,
    `Evaluate turnId: ${input.turnId}`,
    'Course fragments:',
    fragmentsBlock(input.source),
  ].join('\n');
  const raw = extractJsonObject(await once(dependencies, EVALUATE_SYSTEM, prompt));
  raw.turnId = input.turnId;
  if (raw.nextQuestion === null) delete raw.nextQuestion;
  if (raw.endReason === null) delete raw.endReason;
  try {
    const result = parseTeachBackTurnResult(
      raw,
      input.plan,
      input.explanations,
      input.turnId,
      input.locale,
    );
    return { operation: 'evaluate', result };
  } catch (error) {
    throw new TeachBackModelError(
      'invalid_output',
      error instanceof Error ? error.message : 'Evaluate result failed validation',
    );
  }
}
