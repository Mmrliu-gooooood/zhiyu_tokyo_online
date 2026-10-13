'use client';

/**
 * Browser client for the question bank, paper and attempt APIs (learning
 * plan B07). Errors surface as StudyApiError with the server's fixed code.
 * Grading open items (B09) sends the user's model selection like the other
 * model features.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';
import type { AttemptAnswers, AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { ExamBlueprint, PaperPreview } from '@/lib/study/questions/blueprint';
import type {
  ConceptView,
  ImportCommitResult,
  ImportPreview,
  QuestionContent,
  QuestionListResult,
  QuestionSource,
  QuestionType,
  QuestionView,
} from '@/lib/study/questions/contracts';
import type { QuestionPack, QuestionPackSummary } from '@/lib/study/questions/packs';

const enc = encodeURIComponent;

function modelSelection(): { headers: Record<string, string>; thinking: unknown } {
  try {
    const config = getCurrentModelConfig();
    return { headers: modelRequestHeaders(config), thinking: config.thinkingConfig };
  } catch {
    return { headers: {}, thinking: undefined };
  }
}

export interface GradeResult {
  /** The item graded by this request; null when nothing was waiting (or another request had it). */
  graded: { position: number; status: 'succeeded' | 'failed'; error: string | null } | null;
  /** Items still waiting or being graded. */
  waiting: number;
  attempt: AttemptView;
}

export interface BankFilter {
  type?: QuestionType;
  verification?: 'verified' | 'unverified';
  state?: 'gradable' | 'drafts';
  conceptId?: string;
  stageId?: string;
  q?: string;
  offset?: number;
}

/** What the editor and the import preview send for one question. */
export type QuestionInput = QuestionContent & { verified?: boolean };

export type BlueprintRequest = Omit<ExamBlueprint, 'seed'> & { seed?: string };

export const questionBankApi = {
  list: (spaceId: string, filter: BankFilter = {}) => {
    const params = new URLSearchParams({ spaceId });
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return studyRequest<QuestionListResult>(`/api/study/question-bank?${params.toString()}`);
  },
  concepts: (spaceId: string) =>
    studyRequest<{ concepts: ConceptView[] }>(
      `/api/study/question-bank/concepts?spaceId=${enc(spaceId)}`,
    ).then((body) => body.concepts),
  create: (spaceId: string, question: QuestionContent, verified: boolean, stageId: string | null) =>
    studyRequest<{ question: QuestionView }>('/api/study/question-bank', {
      method: 'POST',
      json: { spaceId, question, verified, stageId },
    }).then((body) => body.question),
  update: (
    question: QuestionView,
    content: QuestionContent,
    verified: boolean,
    stageId: string | null,
  ) =>
    studyRequest<{ question: QuestionView }>(`/api/study/question-bank/${enc(question.id)}`, {
      method: 'PATCH',
      json: { question: content, verified, stageId, baseVersion: question.version },
    }).then((body) => body.question),
  remove: (questionId: string) =>
    studyRequest<{ deleted: true }>(`/api/study/question-bank/${enc(questionId)}`, {
      method: 'DELETE',
    }),
  previewImport: (spaceId: string, document: unknown) =>
    studyRequest<ImportPreview>('/api/study/question-bank/imports', {
      method: 'POST',
      json: { spaceId, document },
    }),
  commitImport: (
    spaceId: string,
    questions: QuestionInput[],
    stageId: string | null,
    publicSource: QuestionSource | null = null,
  ) =>
    studyRequest<ImportCommitResult>('/api/study/question-bank/imports', {
      method: 'POST',
      json: {
        spaceId,
        commit: true,
        questions,
        stageId,
        ...(publicSource ? { publicSource } : {}),
      },
    }),
  packs: () =>
    studyRequest<{ packs: QuestionPackSummary[] }>('/api/study/question-bank/packs').then(
      (body) => body.packs,
    ),
  pack: (packId: string) =>
    studyRequest<{ pack: QuestionPackSummary; questions: QuestionPack['questions'] }>(
      `/api/study/question-bank/packs/${enc(packId)}`,
    ),
  copyFromPack: (packId: string, spaceId: string, questionIds: string[]) =>
    studyRequest<{ created: number; duplicates: number; ids: string[] }>(
      `/api/study/question-bank/packs/${enc(packId)}/copy`,
      { method: 'POST', json: { spaceId, questionIds } },
    ),
};

export const examsApi = {
  preview: (blueprint: BlueprintRequest) =>
    studyRequest<{ preview: PaperPreview }>('/api/study/exams/preview', {
      method: 'POST',
      json: { blueprint },
    }).then((body) => body.preview),
  publish: (blueprint: ExamBlueprint, title: string, idempotencyKey: string) =>
    studyRequest<{ paper: PaperSummary }>('/api/study/papers', {
      method: 'POST',
      json: { blueprint, title, idempotencyKey },
    }).then((body) => body.paper),
  papers: (spaceId: string) =>
    studyRequest<{ papers: PaperSummary[] }>(`/api/study/papers?spaceId=${enc(spaceId)}`).then(
      (body) => body.papers,
    ),
  removePaper: (paperId: string) =>
    studyRequest<{ deleted: true }>(`/api/study/papers/${enc(paperId)}`, { method: 'DELETE' }),
  start: (paperId: string) =>
    studyRequest<{ attempt: AttemptView }>(`/api/study/papers/${enc(paperId)}/attempts`, {
      method: 'POST',
    }).then((body) => body.attempt),
  attempt: (attemptId: string) =>
    studyRequest<{ attempt: AttemptView }>(`/api/study/attempts/${enc(attemptId)}`).then(
      (body) => body.attempt,
    ),
  saveDraft: (attemptId: string, answers: AttemptAnswers, baseRevision: number) =>
    studyRequest<{ revision: number; updatedAt: string }>(
      `/api/study/attempts/${enc(attemptId)}/answers`,
      { method: 'PUT', json: { answers, baseRevision } },
    ),
  submit: (attemptId: string, submitKey: string, answers: AttemptAnswers, baseRevision: number) =>
    studyRequest<{ attempt: AttemptView; alreadySubmitted: boolean }>(
      `/api/study/attempts/${enc(attemptId)}/submit`,
      { method: 'POST', json: { submitKey, answers, baseRevision } },
    ),
  /** Grade the next waiting open item, or retry the named one. */
  grade: (attemptId: string, position: number | null = null, signal?: AbortSignal) => {
    const { headers, thinking } = modelSelection();
    return studyRequest<GradeResult>(`/api/study/attempts/${enc(attemptId)}/grading`, {
      method: 'POST',
      headers,
      json: {
        ...(position !== null ? { position } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
      signal,
    });
  },
  regrade: (attemptId: string, position: number) =>
    studyRequest<{ attempt: AttemptView }>(`/api/study/attempts/${enc(attemptId)}/regrade`, {
      method: 'POST',
      json: { position },
    }).then((body) => body.attempt),
  selfGrade: (attemptId: string, position: number, earned: number, note: string | null) =>
    studyRequest<{ attempt: AttemptView }>(`/api/study/attempts/${enc(attemptId)}/self-grades`, {
      method: 'POST',
      json: { position, earned, ...(note ? { note } : {}) },
    }).then((body) => body.attempt),
};
