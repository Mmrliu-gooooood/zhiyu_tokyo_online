'use client';

/**
 * Browser client for explanations on request (learning plan B13). Errors
 * surface as StudyApiError with the server's fixed code.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';

import type {
  CourseMedia,
  ExplanationCreateResult,
  ExplanationDetail,
  ExplanationFormat,
  ExplanationSummary,
} from './contracts';

const enc = encodeURIComponent;

function modelHeaders(): { headers: Record<string, string>; thinking: unknown } {
  try {
    const config = getCurrentModelConfig();
    return { headers: modelRequestHeaders(config), thinking: config.thinkingConfig };
  } catch {
    return { headers: {}, thinking: undefined };
  }
}

export function explanationHref(spaceId: string, explanationId: string): string {
  return `/study/${enc(spaceId)}/explanations/${enc(explanationId)}`;
}

/** One wrong item's explanations, where a new one can be asked for. */
export function itemExplanationsHref(spaceId: string, itemId: string): string {
  return `/study/${enc(spaceId)}/explanations?${new URLSearchParams({ item: itemId }).toString()}`;
}

/** The home page set up to generate a full course for a course explanation. */
export function courseGenerationHref(spaceId: string, explanationId: string): string {
  return `/?${new URLSearchParams({ studySpace: spaceId, studyExplanation: explanationId }).toString()}`;
}

export const explanationApi = {
  list: (spaceId: string, itemId?: string) =>
    studyRequest<{ explanations: ExplanationSummary[] }>(
      `/api/study/explanations?${new URLSearchParams({
        spaceId,
        ...(itemId ? { itemId } : {}),
      }).toString()}`,
    ).then((body) => body.explanations),
  create: (input: {
    itemId: string;
    format: ExplanationFormat;
    language: string;
    fresh?: boolean;
    requirement?: string;
    media?: CourseMedia;
    idempotencyKey: string;
  }) =>
    studyRequest<ExplanationCreateResult>('/api/study/explanations', {
      method: 'POST',
      json: { ...input, consent: true },
    }),
  get: (id: string) =>
    studyRequest<{ explanation: ExplanationDetail }>(`/api/study/explanations/${enc(id)}`).then(
      (body) => body.explanation,
    ),
  /** Write a pending explanation with the student's current model. */
  run: (id: string) => {
    const { headers, thinking } = modelHeaders();
    return studyRequest<{ explanation: ExplanationDetail; ran: boolean }>(
      `/api/study/explanations/${enc(id)}/run`,
      { method: 'POST', headers, json: thinking ? { thinkingConfig: thinking } : {} },
    );
  },
  cancel: (id: string) =>
    studyRequest<{ explanation: ExplanationDetail }>(`/api/study/explanations/${enc(id)}/cancel`, {
      method: 'POST',
    }).then((body) => body.explanation),
  retry: (id: string) =>
    studyRequest<{ explanation: ExplanationDetail }>(`/api/study/explanations/${enc(id)}/retry`, {
      method: 'POST',
    }).then((body) => body.explanation),
  remove: (id: string) =>
    studyRequest<{ deleted: true }>(`/api/study/explanations/${enc(id)}`, { method: 'DELETE' }),
  attachCourse: (id: string, target: { jobId: string } | { stageId: string }) =>
    studyRequest<{ explanation: ExplanationDetail; created: boolean }>(
      `/api/study/explanations/${enc(id)}/course`,
      { method: 'POST', json: target },
    ),
};
