'use client';

/**
 * Browser client for retrieval and cited answers (learning plan B03). Asking
 * sends the user's model selection headers (the same as other model features)
 * and can be cancelled with an AbortSignal; a cancelled question is not saved.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';
import type {
  StudyAnswerView,
  StudyKnowledgeStatus,
  StudySearchResult,
} from '@/lib/study/knowledge/contracts';
import type { LearningTaskView } from '@/lib/study/tasks/contracts';

const enc = encodeURIComponent;

export type IndexBuildResult = {
  materialId: string;
  versionId: string;
  outcome?:
    | { status: 'queued'; task: LearningTaskView; created: boolean }
    | { status: 'up_to_date'; indexId: string };
  error?: string;
};

function modelHeaders(): Record<string, string> {
  try {
    return modelRequestHeaders(getCurrentModelConfig());
  } catch {
    return {};
  }
}

export const knowledgeApi = {
  status: (spaceId: string, signal?: AbortSignal) =>
    studyRequest<{ knowledge: StudyKnowledgeStatus }>(
      `/api/study/spaces/${enc(spaceId)}/knowledge`,
      { signal },
    ).then((body) => body.knowledge),
  build: (spaceId: string, targets: Array<{ materialId: string; versionId: string }>) =>
    studyRequest<{ results: IndexBuildResult[] }>(`/api/study/spaces/${enc(spaceId)}/knowledge`, {
      method: 'POST',
      json: { targets },
    }).then((body) => body.results),
  removeIndex: (materialId: string, versionId: string) =>
    studyRequest<{ removed: number }>(
      `/api/study/materials/${enc(materialId)}/versions/${enc(versionId)}/index`,
      { method: 'DELETE' },
    ),
  answers: (spaceId: string, signal?: AbortSignal) =>
    studyRequest<{ answers: StudyAnswerView[] }>(`/api/study/spaces/${enc(spaceId)}/ask`, {
      signal,
    }).then((body) => body.answers),
  ask: (spaceId: string, question: string, versionIds: string[], signal?: AbortSignal) => {
    const config = (() => {
      try {
        return getCurrentModelConfig();
      } catch {
        return undefined;
      }
    })();
    return studyRequest<{ answer: StudyAnswerView }>(`/api/study/spaces/${enc(spaceId)}/ask`, {
      method: 'POST',
      headers: modelHeaders(),
      json: {
        question,
        ...(versionIds.length > 0 ? { versionIds } : {}),
        ...(config?.thinkingConfig ? { thinkingConfig: config.thinkingConfig } : {}),
      },
      signal,
    }).then((body) => body.answer);
  },
  search: (spaceId: string, question: string, versionIds: string[], signal?: AbortSignal) =>
    studyRequest<StudySearchResult>(`/api/study/spaces/${enc(spaceId)}/search`, {
      method: 'POST',
      json: { question, ...(versionIds.length > 0 ? { versionIds } : {}) },
      signal,
    }),
  removeAnswer: (spaceId: string, answerId: string) =>
    studyRequest<{ deleted: boolean }>(
      `/api/study/spaces/${enc(spaceId)}/answers/${enc(answerId)}`,
      { method: 'DELETE' },
    ),
};

/** sessionStorage key the reader reads to highlight a cited passage. */
export const CITATION_QUOTE_STORAGE_KEY = 'zhiyu:study:citation-quote';

/** Remember the quote of the citation being opened, for the reader's highlight. */
export function rememberCitationQuote(blockId: string, quote: string): void {
  try {
    sessionStorage.setItem(CITATION_QUOTE_STORAGE_KEY, JSON.stringify({ blockId, quote }));
  } catch {
    // Highlighting is a convenience; the block itself is still marked.
  }
}

export function readCitationQuote(blockId: string): string | null {
  try {
    const raw = sessionStorage.getItem(CITATION_QUOTE_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { blockId?: unknown; quote?: unknown };
    return value.blockId === blockId && typeof value.quote === 'string' ? value.quote : null;
  } catch {
    return null;
  }
}
