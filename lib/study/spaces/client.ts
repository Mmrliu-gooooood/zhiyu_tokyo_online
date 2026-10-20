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

/** JSON request to a study API; non-2xx throws StudyApiError with the server's code. */
export async function studyRequest<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
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

export interface StudyCapabilities {
  spaces: boolean;
  /** B02 material library (needs spaces). */
  materials: boolean;
  /** B03 retrieval and cited answers (needs materials). */
  qa: boolean;
  /** B04 classmate templates (needs spaces). */
  classmates: boolean;
  /** B05 after-class classmate chats (needs classmates and the agent runtime). */
  companionChat: boolean;
  /** B06 learning records, preferences and Memory controls (needs spaces). */
  memory: boolean;
  /** B07 question bank, rule-built papers and objective attempts (needs spaces). */
  exams: boolean;
  /** B08 exercise extraction from materials (needs materials and exams). */
  extraction: boolean;
  /** B09 open questions in papers and their assisted grading (needs exams). */
  grading: boolean;
  /** B10 wrong-answer book (needs spaces). */
  wrongbook: boolean;
  /** B11 AI top-ups, AI papers, variants and practice hints (needs exams). */
  practice: boolean;
  /** B12 review tasks, mastery evidence and Memory summaries (needs the wrong-answer book). */
  review: boolean;
}

const CAPABILITY_KEYS = [
  'spaces',
  'materials',
  'qa',
  'classmates',
  'companionChat',
  'memory',
  'exams',
  'extraction',
  'grading',
  'wrongbook',
  'practice',
  'review',
] as const satisfies ReadonlyArray<keyof StudyCapabilities>;

function capabilitiesFrom(body: Record<string, unknown> | null): StudyCapabilities {
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, body?.[key] === true]),
  ) as unknown as StudyCapabilities;
}

let capabilityPromise: Promise<StudyCapabilities> | undefined;

/** Which study features this deployment serves. Cached for the page session; failures retry. */
export function fetchStudyCapabilities(): Promise<StudyCapabilities> {
  capabilityPromise ??= fetch('/api/study/capabilities', { cache: 'no-store' })
    .then(async (response) =>
      capabilitiesFrom(response.ok ? ((await response.json()) as Record<string, unknown>) : null),
    )
    .catch(() => {
      capabilityPromise = undefined;
      return capabilitiesFrom(null);
    });
  return capabilityPromise;
}

/** Whether this deployment serves study spaces. */
export function fetchStudyCapability(): Promise<boolean> {
  return fetchStudyCapabilities().then((capabilities) => capabilities.spaces);
}

/** Test hook. */
export function resetStudyCapabilityCache(): void {
  capabilityPromise = undefined;
}

const enc = encodeURIComponent;

export const studyApi = {
  listSpaces: () =>
    studyRequest<{ spaces: StudySpaceSummary[] }>('/api/study/spaces').then((body) => body.spaces),
  getSpace: (spaceId: string) =>
    studyRequest<{ space: StudySpaceDetail }>(`/api/study/spaces/${enc(spaceId)}`).then(
      (body) => body.space,
    ),
  createSpace: (input: StudySpaceInput) =>
    studyRequest<{ space: StudySpaceSummary }>('/api/study/spaces', {
      method: 'POST',
      json: input,
    }).then((body) => body.space),
  updateSpace: (spaceId: string, revision: number, patch: StudySpacePatch) =>
    studyRequest<{ space: StudySpaceDetail }>(`/api/study/spaces/${enc(spaceId)}`, {
      method: 'PATCH',
      json: { ...patch, revision },
    }).then((body) => body.space),
  deleteSpace: (spaceId: string) =>
    studyRequest<{ deleted: true }>(`/api/study/spaces/${enc(spaceId)}`, { method: 'DELETE' }),
  linkCourse: (spaceId: string, stageId: string, via: 'link' | 'generation' = 'link') =>
    studyRequest<{ created: boolean }>(`/api/study/spaces/${enc(spaceId)}/courses`, {
      method: 'POST',
      json: { stageId, via },
    }),
  unlinkCourse: (spaceId: string, stageId: string) =>
    studyRequest<{ removed: true }>(`/api/study/spaces/${enc(spaceId)}/courses/${enc(stageId)}`, {
      method: 'DELETE',
    }),
  listCourses: () =>
    studyRequest<{ courses: LinkableCourse[] }>('/api/study/courses').then((body) => body.courses),
  getProgress: (stageId: string, signal?: AbortSignal) =>
    studyRequest<{ progress: StudyCourseProgressView | null }>(
      `/api/study/progress/${enc(stageId)}`,
      {
        signal,
      },
    ).then((body) => body.progress),
  putProgress: (
    stageId: string,
    input: ProgressWriteInput,
    options: { keepalive?: boolean } = {},
  ) =>
    studyRequest<{ progress: StudyCourseProgressView }>(`/api/study/progress/${enc(stageId)}`, {
      method: 'PUT',
      json: input,
      keepalive: options.keepalive,
    }).then((body) => body.progress),
};
