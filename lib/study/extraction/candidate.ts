/**
 * Candidate editing rules (learning plan B08), shared by the server and the
 * review page. Pure.
 *
 * A choice candidate is validated exactly like a bank question (same parser,
 * same issues); a missing answer is a warning, so it can still be committed
 * as a draft the program never grades. An `open` candidate (no options) is
 * kept and editable but cannot be committed until open questions exist (B09).
 */
import {
  QUESTION_LIMITS,
  blockingIssues,
  conceptKey,
  normalizeText,
  parseQuestion,
  validateQuestionContent,
  type QuestionContent,
  type QuestionIssue,
} from '@/lib/study/questions/contracts';

import { EXTRACTION_LIMITS, type CandidateContent, type CandidateType } from './contracts';

const OPEN_LIMITS = { referenceAnswer: 4000 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The bank content a choice candidate would become (source is added on commit). */
export function candidateQuestion(content: CandidateContent): QuestionContent | null {
  if (content.type === 'open') return null;
  return {
    type: content.type,
    stem: content.stem,
    options: content.options,
    answer: content.answer,
    explanation: content.explanation,
    concepts: content.concepts,
    difficulty: content.difficulty,
    points: content.points,
    source: null,
  };
}

/** Problems shown on the review page (the bank's issues for choice candidates). */
export function candidateIssues(content: CandidateContent): QuestionIssue[] {
  const question = candidateQuestion(content);
  if (question) return validateQuestionContent(question);
  const issues: QuestionIssue[] = [];
  if (!content.stem) issues.push({ path: 'stem', code: 'stem_missing' });
  else if (content.stem.length > QUESTION_LIMITS.stem) {
    issues.push({ path: 'stem', code: 'stem_too_long' });
  }
  return issues;
}

/** A complete or draft objective question with nothing blocking. */
export function isCommittable(content: CandidateContent): boolean {
  return content.type !== 'open' && blockingIssues(candidateIssues(content)).length === 0;
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
  if (referenceText.length > OPEN_LIMITS.referenceAnswer) {
    return { content: null, issues: [{ path: 'referenceAnswer', code: 'explanation_too_long' }] };
  }
  // Both kinds share the bank's parsing of stem, explanation, concepts, difficulty and points.
  const parsed = parseQuestion({
    ...raw,
    type: type === 'open' ? 'single' : type,
    options: type === 'open' ? ['-', '--'] : raw.options,
    answer: type === 'open' ? [] : raw.answer,
    source: null,
  });
  if (!parsed.content) return { content: null, issues: parsed.issues };
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
    referenceAnswer: referenceText || null,
  };
  const issues =
    type === 'open'
      ? [
          ...candidateIssues(content),
          ...parsed.issues.filter((issue) =>
            [
              'explanation_too_long',
              'concepts_invalid',
              'difficulty_invalid',
              'points_invalid',
            ].includes(issue.code),
          ),
        ]
      : parsed.issues;
  return { content, issues };
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
