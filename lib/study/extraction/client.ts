'use client';

/**
 * Browser client for the exercise extraction APIs (learning plan B08).
 * Errors surface as StudyApiError with the server's fixed code. The optional
 * model help sends the user's model selection like the other model features.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import type {
  CandidateContent,
  CandidateView,
  CommitOutcome,
  ExtractionDetail,
  ExtractionView,
} from '@/lib/study/extraction/contracts';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';

const enc = encodeURIComponent;

function modelSelection(): { headers: Record<string, string>; thinking: unknown } {
  try {
    const config = getCurrentModelConfig();
    return { headers: modelRequestHeaders(config), thinking: config.thinkingConfig };
  } catch {
    return { headers: {}, thinking: undefined };
  }
}

export interface StartExtractionRequest {
  spaceId: string;
  materialId: string;
  versionId?: string | null;
  pageFrom?: number | null;
  pageTo?: number | null;
}

export const extractionApi = {
  list: (spaceId: string) =>
    studyRequest<{ extractions: ExtractionView[] }>(
      `/api/study/extractions?spaceId=${enc(spaceId)}`,
    ).then((body) => body.extractions),
  start: (request: StartExtractionRequest) =>
    studyRequest<{ extractionId: string; created: boolean }>('/api/study/extractions', {
      method: 'POST',
      json: request,
    }),
  get: (extractionId: string, signal?: AbortSignal) =>
    studyRequest<ExtractionDetail>(`/api/study/extractions/${enc(extractionId)}`, { signal }),
  remove: (extractionId: string) =>
    studyRequest<{ deleted: boolean }>(`/api/study/extractions/${enc(extractionId)}`, {
      method: 'DELETE',
    }),
  update: (
    candidate: Pick<CandidateView, 'id' | 'revision'>,
    patch: { content?: CandidateContent; checked?: boolean; status?: 'draft' | 'discarded' },
  ) =>
    studyRequest<{ candidate: CandidateView }>(
      `/api/study/extraction-candidates/${enc(candidate.id)}`,
      { method: 'PATCH', json: { revision: candidate.revision, ...patch } },
    ).then((body) => body.candidate),
  restore: (candidate: Pick<CandidateView, 'id' | 'revision'>) =>
    studyRequest<{ candidate: CandidateView }>(
      `/api/study/extraction-candidates/${enc(candidate.id)}/actions`,
      { method: 'POST', json: { action: 'restore', revision: candidate.revision } },
    ).then((body) => body.candidate),
  adopt: (candidate: Pick<CandidateView, 'id' | 'revision'>) =>
    studyRequest<{ candidate: CandidateView }>(
      `/api/study/extraction-candidates/${enc(candidate.id)}/actions`,
      { method: 'POST', json: { action: 'adopt', revision: candidate.revision } },
    ).then((body) => body.candidate),
  split: (candidate: Pick<CandidateView, 'id' | 'revision'>, atLine: number) =>
    studyRequest<ExtractionDetail>(
      `/api/study/extraction-candidates/${enc(candidate.id)}/actions`,
      {
        method: 'POST',
        json: { action: 'split', revision: candidate.revision, atLine },
      },
    ),
  merge: (candidate: Pick<CandidateView, 'id' | 'revision'>) =>
    studyRequest<ExtractionDetail>(
      `/api/study/extraction-candidates/${enc(candidate.id)}/actions`,
      {
        method: 'POST',
        json: { action: 'merge', revision: candidate.revision },
      },
    ),
  commit: (extractionId: string, candidateIds: string[], stageId: string | null) =>
    studyRequest<{ outcomes: CommitOutcome[]; detail: ExtractionDetail }>(
      `/api/study/extractions/${enc(extractionId)}/commit`,
      { method: 'POST', json: { candidateIds, stageId } },
    ),
  assist: (extractionId: string, candidateIds: string[], signal?: AbortSignal) => {
    const { headers, thinking } = modelSelection();
    return studyRequest<{ suggested: string[]; missing: string[]; detail: ExtractionDetail }>(
      `/api/study/extractions/${enc(extractionId)}/assist`,
      {
        method: 'POST',
        headers,
        json: { candidateIds, ...(thinking ? { thinkingConfig: thinking } : {}) },
        signal,
      },
    );
  },
};
