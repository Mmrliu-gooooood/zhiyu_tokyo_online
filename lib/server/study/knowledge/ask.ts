/**
 * Cited answers over a space's materials (learning plan B03).
 *
 * One question = one budgeted operation on the server:
 *   1. scope: the space's live materials (current versions, or the pinned
 *      ones) with a usable index — computed here, never taken from the client;
 *   2. at most one query embedding through the gateway (operator-funded); if
 *      the embedding model is unavailable the search is keyword-only and the
 *      answer says so — nothing more expensive is attempted instead;
 *   3. hybrid search (≤ 8 passages, ≤ 8000 characters of evidence);
 *   4. no passages → "not found" without any model call; otherwise at most two
 *      calls of the user's selected model (the second only to repair output
 *      that was not valid JSON), ≤ 1500 output tokens each;
 *   5. the model may cite only the passage ids it was given: unknown ids are
 *      dropped, a "grounded" segment left without a valid id is shown as a
 *      supplement, and "answered" without any grounded segment becomes
 *      "not found". Citations are stored from the server's own passages
 *      (version, parse, page, block, quote, hash), never from model output.
 *
 * Cancellation: the request signal (client abort) and the heavy-task lease
 * signal stop every call; nothing is saved for a cancelled question.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  GatewayError,
  embeddingGateway,
  gateway,
  userText,
  type EmbeddingBinding,
  type EmbeddingGateway,
  type GatewayResult,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  STUDY_QA_LIMITS,
  type StudyAnswerSegment,
  type StudyAnswerUsage,
  type StudyAnswerView,
  type StudySearchResult,
} from '@/lib/study/knowledge/contracts';

import { questionTerms } from './query-terms';
import {
  createStudyAnswerId,
  listStudyAnswers,
  recentAnswerCount,
  resolveQuestionScope,
  saveStudyAnswer,
  searchStudyKnowledge,
  type StudySearchHit,
} from './repository';

export interface AskDependencies {
  gateway?: Pick<ModelGateway, 'complete'>;
  embeddings?: EmbeddingGateway;
}

export interface AskInput {
  ownerId: string;
  spaceId: string;
  question: string;
  pinnedVersionIds: string[];
  /** The user's selected model (resolved from the request). */
  model: ModelBinding;
  /** Null when no embedding model is configured: keyword-only retrieval. */
  embedding: EmbeddingBinding | null;
  /** Embedding signature the indexes must have been built with. */
  signature: string;
  signal: AbortSignal;
  requestId: string;
}

/** A retrieval-only request: no answer model. */
export type SearchInput = Omit<AskInput, 'model'>;

/** Owner-bound transaction runner of the web pool. */
export type Transact = <T>(body: (tx: Queryable) => Promise<T>) => Promise<T>;

const MAX_SEGMENTS = 12;
const MAX_SEGMENT_CHARS = 2000;
const QUOTE_CHARS = 300;

const SYSTEM_PROMPT = `你是“智域”学习平台的资料答疑助手。你会收到学生的问题和若干资料片段，每个片段以 [E数字] 标出编号、资料名、版本和页码。

规则：
1. 只能把资料片段里明确写着的内容作为“资料依据”(grounded)，并在 citations 中列出支持它的片段编号；不要引用没有给出的编号。
2. 为了帮助理解而补充的、片段里没有写的解释、例子或常识，放在“补充说明”(supplement)，不带编号。
3. 如果片段不能回答问题，status 用 "not_found"，在 not_found_note 中简短说明资料缺少什么；此时不要编造资料依据，可以给出简短的补充说明。
4. 不同片段说法不一致时，分别陈述并各自引用；片段写明更正、勘误或更新的，指出以哪一份为准。
5. 用学生提问的语言回答，简洁准确；公式保留原写法。
6. 只输出一个 JSON 对象，不要输出 Markdown 代码块或其他文字：
{"status":"answered"|"not_found","segments":[{"kind":"grounded","text":"…","citations":["E1"]},{"kind":"supplement","text":"…"}],"not_found_note":"…"}`;

function evidenceBlock(ref: string, hit: StudySearchHit): string {
  const where = [
    `《${hit.index.title}》`,
    `第 ${hit.index.versionNo} 版${hit.index.isCurrent ? '' : '（非当前版本）'}`,
    hit.pageNumber ? `第 ${hit.pageNumber} 页` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `[${ref}] ${where}\n${hit.text}`;
}

/** Top passages within the evidence character budget. */
export function selectEvidence(hits: readonly StudySearchHit[]): StudySearchHit[] {
  const selected: StudySearchHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (selected.length >= STUDY_QA_LIMITS.evidenceChunks) break;
    if (used + hit.text.length > STUDY_QA_LIMITS.maxEvidenceChars && selected.length > 0) break;
    selected.push(hit);
    used += hit.text.length;
  }
  return selected;
}

export interface ParsedAnswer {
  status: 'answered' | 'not_found';
  segments: StudyAnswerSegment[];
  notFoundNote: string | null;
  /** Model-supplied ids the server did not accept. */
  rejectedRefs: string[];
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1]!;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Strict reading of the model's JSON against the passage ids it was given.
 * Returns null when the output is not a usable answer object at all.
 */
export function parseModelAnswer(
  text: string,
  allowedRefs: ReadonlySet<string>,
): ParsedAnswer | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const object = raw as Record<string, unknown>;
  if (object.status !== 'answered' && object.status !== 'not_found') return null;
  if (!Array.isArray(object.segments)) return null;
  const rejected = new Set<string>();
  const segments: StudyAnswerSegment[] = [];
  for (const item of object.segments.slice(0, MAX_SEGMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const segment = item as Record<string, unknown>;
    const segmentText =
      typeof segment.text === 'string' ? segment.text.trim().slice(0, MAX_SEGMENT_CHARS) : '';
    if (!segmentText) continue;
    if (segment.kind === 'grounded') {
      const refs = Array.isArray(segment.citations)
        ? segment.citations.filter((ref): ref is string => typeof ref === 'string')
        : [];
      const valid = [...new Set(refs.filter((ref) => allowedRefs.has(ref)))];
      for (const ref of refs) if (!allowedRefs.has(ref)) rejected.add(ref.slice(0, 20));
      segments.push(
        valid.length > 0
          ? { kind: 'grounded', text: segmentText, citations: valid }
          : // A claim without an accepted source is not presented as evidence.
            { kind: 'supplement', text: segmentText },
      );
    } else if (segment.kind === 'supplement') {
      segments.push({ kind: 'supplement', text: segmentText });
    }
  }
  const grounded = segments.some((segment) => segment.kind === 'grounded');
  const note =
    typeof object.not_found_note === 'string' && object.not_found_note.trim()
      ? object.not_found_note.trim().slice(0, 500)
      : null;
  return {
    status: grounded ? 'answered' : 'not_found',
    segments,
    notFoundNote: grounded ? null : note,
    rejectedRefs: [...rejected],
  };
}

function quoteOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat;
}

function gatewayFailure(error: unknown): never {
  if (error instanceof GatewayError) {
    if (error.code === 'MODEL_ABORTED') throw error;
    throw new StudyError('STUDY_QA_MODEL_UNAVAILABLE', { reason: error.code });
  }
  throw error;
}

/** Embed the question, or null (keyword-only) when embeddings cannot be used. */
async function embedQuestion(
  input: SearchInput,
  deps: AskDependencies,
  usage: StudyAnswerUsage,
): Promise<number[] | null> {
  if (!input.embedding) return null;
  try {
    usage.embeddingCalls += 1;
    const result = await (deps.embeddings ?? embeddingGateway).embed(
      input.embedding,
      [input.question],
      {
        source: 'study-query',
        signal: input.signal,
        ownerId: input.ownerId,
        usage: { requestId: input.requestId, eventKey: `${input.requestId}:query` },
      },
    );
    usage.embeddingInputTokens =
      result.inputTokens === null ? null : (usage.embeddingInputTokens ?? 0) + result.inputTokens;
    return result.vectors[0] ?? null;
  } catch (error) {
    if (input.signal.aborted) throw error;
    usage.embeddingInputTokens = null;
    return null;
  }
}

/** Retrieval only (no model call): the scoped hybrid or keyword hits. */
export async function searchSpace(
  transact: Transact,
  input: SearchInput,
  deps: AskDependencies = {},
): Promise<StudySearchResult> {
  const scope = await transact((tx) =>
    resolveQuestionScope(tx, input.ownerId, input.spaceId, input.signature, input.pinnedVersionIds),
  );
  if (scope.length === 0) throw new StudyError('STUDY_QA_NOT_INDEXED');
  const usage = emptyUsage(null);
  const vector = await embedQuestion(input, deps, usage);
  const hits = await transact((tx) =>
    searchStudyKnowledge(tx, input.ownerId, scope, questionTerms(input.question), vector, 10),
  );
  return {
    retrieval: vector ? 'hybrid' : 'lexical',
    hits: hits.map((hit) => ({
      chunkId: hit.chunkId,
      materialId: hit.index.materialId,
      materialTitle: hit.index.title,
      versionId: hit.index.versionId,
      versionNo: hit.index.versionNo,
      isCurrentVersion: hit.index.isCurrent,
      artifactId: hit.index.artifactId,
      pageNumber: hit.pageNumber,
      blockId: hit.blockId,
      excerpt: quoteOf(hit.text),
      method: hit.method,
      vectorRank: hit.vectorRank,
      lexicalRank: hit.lexicalRank,
    })),
  };
}

function emptyUsage(fundingKind: string | null): StudyAnswerUsage {
  return {
    embeddingCalls: 0,
    embeddingInputTokens: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    fundingKind,
  };
}

export async function askSpace(
  transact: Transact,
  input: AskInput,
  deps: AskDependencies = {},
): Promise<StudyAnswerView> {
  const { scope, recent } = await transact(async (tx) => ({
    scope: await resolveQuestionScope(
      tx,
      input.ownerId,
      input.spaceId,
      input.signature,
      input.pinnedVersionIds,
    ),
    recent: await recentAnswerCount(tx, input.ownerId),
  }));
  if (scope.length === 0) throw new StudyError('STUDY_QA_NOT_INDEXED');
  if (recent >= STUDY_QA_LIMITS.answersPerHour) throw new StudyError('STUDY_QA_RATE_LIMITED');

  const usage = emptyUsage(input.model.funding.kind);
  let usageKnown = true;
  const vector = await embedQuestion(input, deps, usage);
  if (input.embedding && usage.embeddingInputTokens === null) usageKnown = false;
  const hits = selectEvidence(
    await transact((tx) =>
      searchStudyKnowledge(
        tx,
        input.ownerId,
        scope,
        questionTerms(input.question),
        vector,
        STUDY_QA_LIMITS.evidenceChunks,
      ),
    ),
  );
  input.signal.throwIfAborted();
  const refs = hits.map((_, index) => `E${index + 1}`);
  const allowed = new Set(refs);

  let parsed: ParsedAnswer;
  if (hits.length === 0) {
    parsed = { status: 'not_found', segments: [], notFoundNote: null, rejectedRefs: [] };
  } else {
    const prompt = [
      `问题：${input.question}`,
      '',
      '资料片段：',
      ...hits.map((hit, index) => evidenceBlock(refs[index]!, hit)),
    ].join('\n\n');
    const call = async (messages: string): Promise<GatewayResult> => {
      usage.modelCalls += 1;
      try {
        const result = await (deps.gateway ?? gateway).complete(
          input.model,
          {
            system: SYSTEM_PROMPT,
            messages: [userText(messages)],
            maxOutputTokens: STUDY_QA_LIMITS.maxAnswerOutputTokens,
            temperature: 0.2,
          },
          {
            source: 'study-qa',
            signal: input.signal,
            ownerId: input.ownerId,
            usage: {
              requestId: input.requestId,
              eventKey: `${input.requestId}:answer:${usage.modelCalls}`,
            },
          },
        );
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        if (result.usage.inputTokens === 0 && result.usage.outputTokens === 0) usageKnown = false;
        return result;
      } catch (error) {
        usageKnown = false;
        return gatewayFailure(error);
      }
    };
    const first = await call(prompt);
    let candidate = parseModelAnswer(first.text, allowed);
    if (!candidate) {
      // One repair call, inside the per-question budget of two model calls.
      const repaired = await call(
        `${prompt}\n\n上一次的输出不是要求的 JSON 对象。请只输出符合格式的 JSON 对象。`,
      );
      candidate = parseModelAnswer(repaired.text, allowed);
    }
    if (!candidate) throw new StudyError('STUDY_QA_ANSWER_INVALID');
    parsed = candidate;
  }
  input.signal.throwIfAborted();

  const cited = new Set(
    parsed.segments.flatMap((segment) => (segment.kind === 'grounded' ? segment.citations : [])),
  );
  const answerId = createStudyAnswerId();
  await transact((tx) =>
    saveStudyAnswer(tx, input.ownerId, {
      id: answerId,
      spaceId: input.spaceId,
      question: input.question,
      status: parsed.status,
      body: {
        segments: parsed.segments,
        notFoundNote: parsed.notFoundNote,
        retrieval: vector ? 'hybrid' : 'lexical',
      },
      pinnedVersionIds: input.pinnedVersionIds,
      modelString: usage.modelCalls > 0 ? input.model.modelString : null,
      usage,
      usageCompleteness:
        usage.modelCalls === 0 && usage.embeddingCalls === 0
          ? 'none'
          : usageKnown
            ? 'complete'
            : 'partial',
      citations: hits
        .map((hit, index) => ({ ref: refs[index]!, hit, quote: quoteOf(hit.text) }))
        .filter((citation) => cited.has(citation.ref)),
    }),
  );
  const [saved] = await transact((tx) =>
    listStudyAnswers(tx, input.ownerId, input.spaceId, { answerId }),
  );
  return saved!;
}
