'use client';

/**
 * Browser client for the study APIs (learning plan B01). Errors surface as
 * StudyApiError with the server's fixed code; callers decide what to show.
 */
import type {
  LinkableCourse,
  ProgressWriteInput,
  StudyCourseProgressView,
  StudySpaceDetail,
  StudySpaceInput,
  StudySpacePatch,
  StudySpaceSummary,
} from '@/lib/study/spaces/contracts';

export class StudyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(code);
    this.name = 'StudyApiError';
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...rest.headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code =
      typeof body?.error === 'string'
        ? body.error
        : response.status === 404
          ? 'STUDY_NOT_AVAILABLE'
          : response.status === 401
            ? 'STUDY_ACCOUNT_REQUIRED'
            : 'STUDY_UNAVAILABLE';
    throw new StudyApiError(response.status, code, body);
  }
  return body as T;
}

let capabilityPromise: Promise<boolean> | undefined;

/** Whether this deployment serves study spaces. Cached for the page session; failures retry. */
export function fetchStudyCapability(): Promise<boolean> {
  capabilityPromise ??= fetch('/api/study/capabilities', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) return false;
      const body = (await response.json()) as { spaces?: unknown };
      return body.spaces === true;
    })
    .catch(() => {
      capabilityPromise = undefined;
      return false;
    });
  return capabilityPromise;
}

/** Test hook. */
export function resetStudyCapabilityCache(): void {
  capabilityPromise = undefined;
}

const enc = encodeURIComponent;

export const studyApi = {
  listSpaces: () =>
    request<{ spaces: StudySpaceSummary[] }>('/api/study/spaces').then((body) => body.spaces),
  getSpace: (spaceId: string) =>
    request<{ space: StudySpaceDetail }>(`/api/study/spaces/${enc(spaceId)}`).then(
      (body) => body.space,
    ),
  createSpace: (input: StudySpaceInput) =>
    request<{ space: StudySpaceSummary }>('/api/study/spaces', {
      method: 'POST',
      json: input,
    }).then((body) => body.space),
  updateSpace: (spaceId: string, revision: number, patch: StudySpacePatch) =>
    request<{ space: StudySpaceDetail }>(`/api/study/spaces/${enc(spaceId)}`, {
      method: 'PATCH',
      json: { ...patch, revision },
    }).then((body) => body.space),
  deleteSpace: (spaceId: string) =>
    request<{ deleted: true }>(`/api/study/spaces/${enc(spaceId)}`, { method: 'DELETE' }),
  linkCourse: (spaceId: string, stageId: string, via: 'link' | 'generation' = 'link') =>
    request<{ created: boolean }>(`/api/study/spaces/${enc(spaceId)}/courses`, {
      method: 'POST',
      json: { stageId, via },
    }),
  unlinkCourse: (spaceId: string, stageId: string) =>
    request<{ removed: true }>(`/api/study/spaces/${enc(spaceId)}/courses/${enc(stageId)}`, {
      method: 'DELETE',
    }),
  listCourses: () =>
    request<{ courses: LinkableCourse[] }>('/api/study/courses').then((body) => body.courses),
  getProgress: (stageId: string, signal?: AbortSignal) =>
    request<{ progress: StudyCourseProgressView | null }>(`/api/study/progress/${enc(stageId)}`, {
      signal,
    }).then((body) => body.progress),
  putProgress: (
    stageId: string,
    input: ProgressWriteInput,
    options: { keepalive?: boolean } = {},
  ) =>
    request<{ progress: StudyCourseProgressView }>(`/api/study/progress/${enc(stageId)}`, {
      method: 'PUT',
      json: input,
      keepalive: options.keepalive,
    }).then((body) => body.progress),
};
