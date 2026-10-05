'use client';

/**
 * Browser client for the study material library (learning plan B02).
 * Errors surface as StudyApiError with the server's fixed code.
 */
import { StudyApiError, studyRequest } from '@/lib/study/spaces/client';
import type { LearningTaskView } from '@/lib/study/tasks/contracts';
import {
  studyMaterialMimeForFile,
  type MaterialParserOption,
  type ReaderPageView,
  type StudyMaterialDetail,
  type StudyMaterialSummary,
  type StudyMaterialUploadResult,
} from '@/lib/study/materials/contracts';

const enc = encodeURIComponent;

export interface UploadOptions {
  spaceId?: string;
  /** Add a version to this material instead of creating a new one. */
  materialId?: string;
  parse?: boolean;
  providerId?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Upload one file with progress (XHR: fetch has no upload progress). */
export function uploadStudyMaterial(
  file: File,
  options: UploadOptions = {},
): Promise<StudyMaterialUploadResult> {
  const params = new URLSearchParams();
  if (options.spaceId) params.set('spaceId', options.spaceId);
  if (options.parse === false) params.set('parse', '0');
  if (options.providerId) params.set('providerId', options.providerId);
  const base = options.materialId
    ? `/api/study/materials/${enc(options.materialId)}/versions`
    : '/api/study/materials';
  const url = params.size ? `${base}?${params}` : base;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', studyMaterialMimeForFile(file));
    xhr.setRequestHeader('X-Material-Filename', enc(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body as unknown as StudyMaterialUploadResult);
        return;
      }
      const code =
        typeof body?.error === 'string'
          ? body.error
          : xhr.status === 401
            ? 'STUDY_ACCOUNT_REQUIRED'
            : 'STUDY_UNAVAILABLE';
      reject(new StudyApiError(xhr.status, code, body));
    };
    xhr.onerror = () => reject(new StudyApiError(0, 'STUDY_UNAVAILABLE', null));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

function versionPath(materialId: string, versionId: string) {
  return `/api/study/materials/${enc(materialId)}/versions/${enc(versionId)}`;
}

export const materialsApi = {
  list: (spaceId?: string) =>
    studyRequest<{ materials: StudyMaterialSummary[] }>(
      spaceId ? `/api/study/materials?spaceId=${enc(spaceId)}` : '/api/study/materials',
    ).then((body) => body.materials),
  get: (materialId: string) =>
    studyRequest<{ material: StudyMaterialDetail; parsers: MaterialParserOption[] }>(
      `/api/study/materials/${enc(materialId)}`,
    ),
  rename: (materialId: string, title: string, revision: number) =>
    studyRequest<{ material: StudyMaterialDetail }>(`/api/study/materials/${enc(materialId)}`, {
      method: 'PATCH',
      json: { title, revision },
    }).then((body) => body.material),
  remove: (materialId: string) =>
    studyRequest<{ deleted: boolean; pendingObjects: number }>(
      `/api/study/materials/${enc(materialId)}`,
      { method: 'DELETE' },
    ),
  link: (spaceId: string, materialId: string) =>
    studyRequest<{ created: boolean }>(`/api/study/spaces/${enc(spaceId)}/materials`, {
      method: 'POST',
      json: { materialId },
    }),
  unlink: (spaceId: string, materialId: string) =>
    studyRequest<{ removed: true }>(
      `/api/study/spaces/${enc(spaceId)}/materials/${enc(materialId)}`,
      { method: 'DELETE' },
    ),
  parse: (materialId: string, versionId: string, providerId?: string, key?: string) =>
    studyRequest<{ task: LearningTaskView; created: boolean }>(
      `${versionPath(materialId, versionId)}/parse`,
      {
        method: 'POST',
        json: providerId ? { providerId } : {},
        ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      },
    ),
  cancelTask: (taskId: string) =>
    studyRequest<{ task: LearningTaskView }>(`/api/study/tasks/${enc(taskId)}/cancel`, {
      method: 'POST',
    }).then((body) => body.task),
  retryTask: (taskId: string) =>
    studyRequest<{ task: LearningTaskView }>(`/api/study/tasks/${enc(taskId)}/retry`, {
      method: 'POST',
    }).then((body) => body.task),
  reader: (
    materialId: string,
    versionId: string,
    page?: number | null,
    artifactId?: string,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (artifactId) params.set('artifact', artifactId);
    return studyRequest<{ reader: ReaderPageView }>(
      `${versionPath(materialId, versionId)}/reader${params.size ? `?${params}` : ''}`,
      { signal },
    ).then((body) => body.reader);
  },
  text: (materialId: string, versionId: string) =>
    studyRequest<{
      name: string;
      title: string;
      text: string;
      truncated: boolean;
      pageCount: number;
      versionNo: number;
    }>(`${versionPath(materialId, versionId)}/text`),
  fileUrl: (materialId: string, versionId: string, download = false) =>
    `${versionPath(materialId, versionId)}/file${download ? '?download=1' : ''}`,
  imageUrl: (materialId: string, versionId: string, imageId: string, artifactId?: string) =>
    `${versionPath(materialId, versionId)}/images/${enc(imageId)}${
      artifactId ? `?artifact=${enc(artifactId)}` : ''
    }`,
};

/** Reader location for one version (and optionally a page). */
export function readerHref(materialId: string, versionId: string, page?: number | null): string {
  const params = new URLSearchParams({ version: versionId });
  if (page) params.set('page', String(page));
  return `/study/materials/${enc(materialId)}/read?${params}`;
}
