/**
 * /api/materials — the workbench's material list and upload face.
 *
 * The uploader (`uploadWorkbenchMaterial` in `lib/workbench/session-store.ts`)
 * is OWNER-scoped: it posts a file with no session id and expects the flat
 * `{ materialId, originalName, bytes, mime, extraction }` 201 view. This route
 * implements the reference's upload contract on the owner-scoped material
 * library (`lib/persistence/owner-materials.ts`) with the neutral local
 * material byte store.
 *
 * ## Upload contract (the reference's)
 *
 * - `content-type` is the MIME type; it is normalized and validated against
 *   the workbench policy — an unsupported type answers 415.
 * - `x-material-filename` is the display name (required).
 * - Size caps are per class: media (audio/video) uploads cap at
 *   `maxUploadBytes`, documents/images at `min(maxDocumentBytes,
 *   maxUploadBytes)` — both 413 when exceeded, checked on the declared
 *   `content-length` AND on the streamed body.
 * - Lifecycle: the upload reclaims crashed `uploading` leftovers older than
 *   24 hours (their byte objects first, then the reservations), reserves a
 *   quota-checked `uploading` row (429 when the owner's count or byte quota is
 *   exceeded), streams the bytes through a sha256 meter into the byte store,
 *   and finalizes the row to `ready` with the digest. Failures
 *   abandon the reservation; crash leftovers are reclaimed by the next
 *   upload's 24-hour sweep.
 * - Every response echoes the `x-request-id` header so the uploader can pair
 *   a failure with its log line.
 *
 * The configured runtime gates the family (the workbench is agent-runtime
 * territory): off, or on without a DATABASE_URL, answers the same plain 404.
 */
import { randomUUID } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  resolveOwnedSession,
  listSessionMaterials,
  publicMaterialView,
} from '@/lib/server/agent-runtime/session-materials';
import { publicMaterial } from '@/lib/persistence/owner-materials';
import {
  OwnerUploadRejected,
  storeOwnerMaterialUpload,
  type OwnerUploadState,
} from '@/lib/server/materials/owner-upload';
import {
  isWorkbenchMaterialMime,
  MEDIA_MIME_TYPES,
  normalizeWorkbenchMaterialMime,
} from '@/lib/workbench/material-upload-policy';

export const runtime = 'nodejs';

const DOCUMENT_UPLOAD_LIMIT = Math.min(
  agentRuntimeConfig.maxDocumentBytes,
  agentRuntimeConfig.maxUploadBytes,
);
const MEDIA_MIME_SET = new Set<string>(MEDIA_MIME_TYPES);

/** The store's keyset-paging ceiling (default 50, capped at 200). */
const MAX_MATERIAL_LIST_LIMIT = 200;

function materialUploadRequestId(req: NextRequest): string {
  const upstream = req.headers.get('x-request-id')?.trim();
  return upstream && /^[A-Za-z0-9._:-]{1,128}$/.test(upstream) ? upstream : randomUUID();
}

function parseLimit(raw: string | null): { limit?: number } | { invalid: true } {
  if (raw === null || raw === '') return {};
  if (!/^\d+$/.test(raw)) return { invalid: true };
  const parsed = Number(raw);
  if (parsed < 1 || parsed > MAX_MATERIAL_LIST_LIMIT) return { invalid: true };
  return { limit: parsed };
}

// GET /api/materials?sessionId=&limit=&before= — list one owned session's
// materials, newest first, keyset-paged (the agent-tools list surface).
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  const parsedLimit = parseLimit(url.searchParams.get('limit'));
  if ('invalid' in parsedLimit) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `limit must be an integer between 1 and ${MAX_MATERIAL_LIST_LIMIT}`,
    );
  }
  const before = url.searchParams.get('before')?.trim() || undefined;

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const materials = await listSessionMaterials(
      sessionId,
      {
        ...(parsedLimit.limit === undefined ? {} : { limit: parsedLimit.limit }),
        ...(before ? { before } : {}),
      },
      ownerId,
    );
    return ownerJson(
      { materials: materials.map((material) => publicMaterialView(material)) },
      200,
      responseHeaders,
    );
  });
}

// POST /api/materials — upload a source file into the caller's durable
// material library. The raw bytes ride the body; `content-type` is the MIME
// type and `x-material-filename` the display name.
export async function POST(req: NextRequest) {
  const requestId = materialUploadRequestId(req);
  const startedAt = Date.now();
  let phase = 'feature_gate';
  let materialId: string | undefined;
  let mime = '';
  let declaredBytes = 0;
  let receivedBytes = 0;
  let failureLogged = false;
  const context = (extra: Record<string, unknown> = {}) => ({
    requestId,
    phase,
    ...(materialId ? { materialId } : {}),
    ...(mime ? { mime } : {}),
    declaredBytes,
    receivedBytes,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
  const reject = (response: Response, reason: string, headers: Headers) => {
    console.warn('material upload rejected', context({ status: response.status, reason }));
    response.headers.set('x-request-id', requestId);
    for (const [key, value] of headers) response.headers.append(key, value);
    return response;
  };

  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const state: OwnerUploadState = {
      phase,
      declaredBytes: 0,
      receivedBytes: 0,
      failureLogged: false,
    };
    const sync = () => {
      phase = state.phase;
      materialId = state.materialId;
      declaredBytes = state.declaredBytes;
      receivedBytes = state.receivedBytes;
      failureLogged = state.failureLogged;
    };
    try {
      phase = state.phase = 'validate_request';
      const rawMime = (req.headers.get('content-type') ?? '').split(';', 1)[0];
      mime = normalizeWorkbenchMaterialMime(rawMime);
      if (!isWorkbenchMaterialMime(mime)) {
        return reject(
          apiError(
            'INVALID_REQUEST',
            415,
            `unsupported material mime type: ${mime || '(missing)'}`,
          ),
          'unsupported_mime',
          responseHeaders,
        );
      }
      const uploadLimit = MEDIA_MIME_SET.has(mime)
        ? agentRuntimeConfig.maxUploadBytes
        : DOCUMENT_UPLOAD_LIMIT;

      const row = await storeOwnerMaterialUpload(req, ownerId, {
        mime,
        uploadLimit,
        state,
        warn: (message, extra, error) => {
          sync();
          console.warn(message, context(extra), error);
        },
      });
      sync();
      const view = publicMaterial(row);
      const res = NextResponse.json(
        {
          materialId: view.materialId,
          originalName: view.originalName,
          bytes: view.bytes,
          mime: view.mime,
          extraction: view.extraction,
        },
        { status: 201 },
      );
      res.headers.set('x-request-id', requestId);
      for (const [key, value] of responseHeaders) res.headers.append(key, value);
      console.info('material upload completed', context({ status: 201 }));
      return res;
    } catch (error) {
      sync();
      if (error instanceof OwnerUploadRejected) {
        return reject(
          apiError(error.code, error.status, error.message),
          error.reason,
          responseHeaders,
        );
      }
      if (!failureLogged) console.error('material upload failed', context({ status: 500 }), error);
      const res = apiError('INTERNAL_ERROR', 500, 'material upload failed');
      res.headers.set('x-request-id', requestId);
      for (const [key, value] of responseHeaders) res.headers.append(key, value);
      return res;
    }
  });
}
