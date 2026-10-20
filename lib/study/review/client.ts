'use client';

/**
 * Browser client for review tasks and Memory summaries (learning plan B12).
 * Errors surface as StudyApiError with the server's fixed code.
 */
import type { SummaryView } from '@/lib/study/memory/summary';
import { studyRequest } from '@/lib/study/spaces/client';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';

import type { ReviewAction, ReviewActionKind, ReviewOverview } from './contracts';

const enc = encodeURIComponent;

/** The browser's time zone (used for a space without one). */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export interface SummaryRefreshResult {
  state: 'written' | 'kept' | 'off' | 'failed';
  reason: string;
  summary: SummaryView | null;
}

export const reviewApi = {
  overview: (spaceId: string) => {
    const params = new URLSearchParams({ spaceId });
    const tz = browserTimeZone();
    if (tz) params.set('tz', tz);
    return studyRequest<{ overview: ReviewOverview }>(
      `/api/study/review-tasks?${params.toString()}`,
    ).then((body) => body.overview);
  },
  act: (itemId: string, revision: number, kind: ReviewActionKind, until?: string) =>
    studyRequest<{ revision: number; actions: ReviewAction[] }>(
      `/api/study/review-tasks/${enc(itemId)}`,
      {
        method: 'POST',
        json: {
          kind,
          revision,
          ...(until ? { until } : {}),
          ...(browserTimeZone() ? { timezone: browserTimeZone() } : {}),
        },
      },
    ),
  redo: (itemId: string, idempotencyKey: string) =>
    studyRequest<{ paperId: string; created: boolean }>(
      `/api/study/review-tasks/${enc(itemId)}/redo`,
      { method: 'POST', json: { idempotencyKey } },
    ),
  settings: (spaceId: string, dailyMinutes: number, revision: number) =>
    studyRequest<{ settings: { dailyMinutes: number; revision: number } }>(
      '/api/study/review-tasks/settings',
      { method: 'PUT', json: { spaceId, dailyMinutes, revision } },
    ).then((body) => body.settings),
  /** Ask the server to bring the space's summary up to date (it calls the model only on change). */
  refreshSummary: (spaceId: string) => {
    let headers: Record<string, string> = {};
    let thinking: unknown;
    try {
      const config = getCurrentModelConfig();
      headers = modelRequestHeaders(config);
      thinking = config.thinkingConfig;
    } catch {
      headers = {};
    }
    return studyRequest<SummaryRefreshResult>('/api/study/memory/summaries', {
      method: 'POST',
      headers,
      json: { spaceId, ...(thinking ? { thinkingConfig: thinking } : {}) },
    });
  },
  deleteSummary: (spaceId: string) =>
    studyRequest<{ deleted: true }>(
      `/api/study/memory/summaries?${new URLSearchParams({ spaceId }).toString()}`,
      { method: 'DELETE' },
    ),
};
