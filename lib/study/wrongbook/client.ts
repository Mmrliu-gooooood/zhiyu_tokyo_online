'use client';

/** Browser client for the wrong-answer book (learning plan B10). */
import { studyRequest } from '@/lib/study/spaces/client';

import type {
  WrongItemDetail,
  WrongReviewState,
  WrongbookFilter,
  WrongbookPage,
  WrongbookSyncResult,
} from './contracts';

const enc = encodeURIComponent;

export const wrongbookApi = {
  sync: (spaceId: string, force = false) =>
    studyRequest<WrongbookSyncResult>('/api/study/wrongbook/sync', {
      method: 'POST',
      json: { spaceId, ...(force ? { force: true } : {}) },
    }),
  list: (spaceId: string, filter: WrongbookFilter) => {
    const params = new URLSearchParams({
      spaceId,
      state: filter.state,
      since: filter.since,
      offset: String(filter.offset),
    });
    if (filter.source) params.set('source', filter.source);
    if (filter.concept !== null) params.set('concept', filter.concept);
    return studyRequest<WrongbookPage>(`/api/study/wrongbook?${params.toString()}`);
  },
  get: (itemId: string) =>
    studyRequest<{ item: WrongItemDetail }>(`/api/study/wrongbook/${enc(itemId)}`).then(
      (body) => body.item,
    ),
  update: (
    itemId: string,
    revision: number,
    patch: { reviewState?: WrongReviewState; archived?: boolean },
  ) =>
    studyRequest<{ revision: number; reviewState: WrongReviewState; archived: boolean }>(
      `/api/study/wrongbook/${enc(itemId)}`,
      { method: 'PATCH', json: { revision, ...patch } },
    ),
};

/** The classroom opened at one page (the scene is checked again when the classroom loads). */
export function classroomSceneHref(stageId: string, sceneId: string): string {
  return `/classroom/${enc(stageId)}?scene=${enc(sceneId)}`;
}

/** A classmate chat about one wrong item (the server builds the question's context). */
export function wrongItemChatHref(
  classmateId: string,
  spaceId: string,
  itemId: string,
  question: string,
) {
  const params = new URLSearchParams({ space: spaceId, wrong: itemId, q: question });
  return `/study/classmates/${enc(classmateId)}/chat?${params.toString()}`;
}
