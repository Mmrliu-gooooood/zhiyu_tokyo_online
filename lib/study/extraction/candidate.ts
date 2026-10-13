/**
 * Candidate editing rules (learning plan B08), shared by the server and the
 * review page. Pure.
 *
 * A choice candidate is validated exactly like a bank question (same parser,
 * same issues); a missing answer is a warning, so it can still be committed
 * as a draft the program never grades. An `open` candidate (no options)
 * becomes an open question (B09): its printed answer is the reference
 * answer; without one it is committed as a draft for self-checking.
 */
import {
  blockingIssues,
  conceptKey,
  normalizeText,
  parseQuestion,
  validateQuestionContent,
  type OpenSubtype,
  type QuestionContent,
  type QuestionIssue,
} from '@/lib/study/questions/contracts';

import { EXTRACTION_LIMITS, type CandidateContent, type CandidateType } from './contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A first guess at what kind of open question a stem asks for (the student can change it). */
export function guessOpenSubtype(stem: string): OpenSubtype {
  if (/证明|求证|prove|show that/i.test(stem)) return 'proof';
  if (/计算|求|解方程|化简|多少|calculate|compute|evaluate|find|solve/i.test(stem)) {
    return 'calculation';
  }
  return 'short';
}

/** The bank content a candidate would become (source is added on commit). */
export function candidateQuestion(content: CandidateContent): QuestionContent {
  const base = {
    stem: content.stem,
    explanation: content.explanation,
    concepts: content.concepts,
    difficulty: content.difficulty,
    points: content.points,
    source: null,
  };
  if (content.type === 'open') {
    const subtype = content.subtype ?? guessOpenSubtype(content.stem);
    return {
      ...base,
      type: 'short_answer',
      subtype,
      options: [],
      answer: [],
      guide: {
        referenceAnswer: content.referenceAnswer,
        finalAnswer: subtype === 'calculation' ? (content.finalAnswer ?? null) : null,
        rubric: content.rubric ?? [],
      },
    };
  }
  return { ...base, type: content.type, options: content.options, answer: content.answer };
}

/** Problems shown on the review page (the bank's issues). */
export function candidateIssues(content: CandidateContent): QuestionIssue[] {
  return validateQuestionContent(candidateQuestion(content));
}

/** A complete question, or a draft (no answer or grading guide), with nothing blocking. */
export function isCommittable(content: CandidateContent): boolean {
  return blockingIssues(candidateIssues(content)).length === 0;
}

export interface ParsedCandidate {
  content: CandidateContent | null;
  issues: QuestionIssue[];
}

/**
 * Read an edited candidate from the client. Figures must be images of the
 * extraction's own parse result.
 */
export function parseCandidateContent(
  raw: unknown,
  allowedFigures: ReadonlySet<string>,
): ParsedCandidate {
  if (!isRecord(raw)) return { content: null, issues: [{ path: '', code: 'not_object' }] };
  const type = raw.type as CandidateType;
  if (type !== 'single' && type !== 'multiple' && type !== 'open') {
    return { content: null, issues: [{ path: 'type', code: 'type_unsupported' }] };
  }
  const figures = Array.isArray(raw.figures) ? raw.figures : [];
  if (
    figures.length > EXTRACTION_LIMITS.figuresPerQuestion ||
    figures.some((id) => typeof id !== 'string' || !allowedFigures.has(id)) ||
    new Set(figures).size !== figures.length
  ) {
    return { content: null, issues: [{ path: 'figures', code: 'source_invalid' }] };
  }
  const referenceText =
    typeof raw.referenceAnswer === 'string' ? normalizeText(raw.referenceAnswer) : '';
  // Both kinds share the bank's parsing (open ones as open questions with their guide).
  const parsed = parseQuestion({
    ...raw,
    type: type === 'open' ? 'short_answer' : type,
    subtype:
      type === 'open'
        ? (raw.subtype ?? guessOpenSubtype(typeof raw.stem === 'string' ? raw.stem : ''))
        : undefined,
    options: type === 'open' ? [] : raw.options,
    answer: type === 'open' ? undefined : raw.answer,
    referenceAnswer: type === 'open' ? referenceText : undefined,
    finalAnswer: type === 'open' ? raw.finalAnswer : undefined,
    rubric: type === 'open' ? raw.rubric : undefined,
    source: null,
  });
  if (!parsed.content) return { content: null, issues: parsed.issues };
  const guide = parsed.content.guide;
  const content: CandidateContent = {
    type,
    stem: parsed.content.stem,
    options: type === 'open' ? [] : parsed.content.options,
    answer: type === 'open' ? [] : parsed.content.answer,
    explanation: parsed.content.explanation,
    concepts: parsed.content.concepts,
    difficulty: parsed.content.difficulty,
    points: parsed.content.points,
    figures: figures as string[],
    referenceAnswer: type === 'open' ? (guide?.referenceAnswer ?? null) : null,
    ...(type === 'open'
      ? {
          subtype: parsed.content.subtype,
          finalAnswer: guide?.finalAnswer ?? null,
          rubric: guide?.rubric ?? [],
        }
      : {}),
  };
  return { content, issues: parsed.issues };
}

/** Whether two answer keys are the same (order-insensitive). */
export function sameAnswer(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** Concepts that differ only by width/case/spacing count once. */
export function mergeConcepts(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((name) => {
    const key = conceptKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
