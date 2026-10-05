/** Shared request/response helpers for the study material routes (learning plan B02). */
import { isStudyId } from '@/lib/study/spaces/contracts';
import { normalizeWorkbenchMaterialMime } from '@/lib/workbench/material-upload-policy';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { OwnerUploadRejected, type OwnerUploadState } from '@/lib/server/materials/owner-upload';
import { createLogger } from '@/lib/logger';

const log = createLogger('StudyMaterials');

export function requireMaterialId(value: string): string {
  if (!isStudyId(value)) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  return value;
}

/** Canonical upload MIME: the declared type, or the file extension for text formats. */
export function studyUploadMime(req: Request): string {
  const declared = normalizeWorkbenchMaterialMime(
    (req.headers.get('content-type') ?? '').split(';', 1)[0],
  );
  let name = '';
  try {
    name = decodeURIComponent(req.headers.get('x-material-filename') ?? '').toLowerCase();
  } catch {
    name = (req.headers.get('x-material-filename') ?? '').toLowerCase();
  }
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  if (!declared || declared === 'application/octet-stream') {
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.txt')) return 'text/plain';
  }
  return declared;
}

export function newUploadState(): OwnerUploadState {
  return { phase: 'validate_request', declaredBytes: 0, receivedBytes: 0, failureLogged: false };
}

export function uploadWarn(state: OwnerUploadState) {
  return (message: string, extra: Record<string, unknown> = {}, error?: unknown) =>
    log.warn(message, {
      phase: state.phase,
      declaredBytes: state.declaredBytes,
      receivedBytes: state.receivedBytes,
      ...extra,
      error: error instanceof Error ? error.name : undefined,
    });
}

/** Map an upload rejection to the study error envelope; rethrow anything else. */
export function uploadRejection(error: unknown, headers: Headers): Response {
  if (error instanceof OwnerUploadRejected) {
    return Response.json(
      { error: 'STUDY_UPLOAD_REJECTED', reason: error.reason, message: error.message },
      { status: error.status, headers },
    );
  }
  throw error;
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Private bytes: never cached, never sniffed, and sandboxed when opened directly. */
export function privateFileResponse(
  bytes: Buffer,
  mime: string,
  filename: string,
  headers: Headers,
  disposition: 'inline' | 'attachment' = 'inline',
): Response {
  headers.set('Content-Type', mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime);
  headers.set('Content-Length', String(bytes.byteLength));
  headers.set('Content-Disposition', contentDisposition(disposition, filename));
  headers.set('X-Content-Type-Options', 'nosniff');
  // Browsers refuse their PDF viewer in a sandboxed document; every other
  // accepted type (text, images, Office files) is sandboxed when opened directly.
  if (mime !== 'application/pdf') {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
  }
  headers.set('Cache-Control', 'private, no-store');
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
