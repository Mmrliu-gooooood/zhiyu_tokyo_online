import { z } from 'zod';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { backgroundGenerationEnabled } from '@/lib/server/generation-jobs/runtime';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  MediaConfigSnapshotContentSchema,
  MediaConfigSnapshotError,
  revokeMediaConfigSnapshots,
  syncMediaConfigSnapshot,
} from '@/lib/server/media-config-snapshots';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 65_536;
const postBody = z.object({ snapshot: MediaConfigSnapshotContentSchema }).strict();
const deleteBody = z
  .object({
    providerInstanceId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_.:/-]+$/),
  })
  .strict();

function json(error: string, status: number, headers: Headers): Response {
  return Response.json({ error }, { status, headers });
}

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID', 413);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID', 413);
      }
      chunks.push(value);
    }
  }
  const raw = Buffer.concat(chunks, total).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID');
  }
}

async function handle(req: Request, revoke: boolean): Promise<Response> {
  if (!isAgentRuntimeConfigured() && !backgroundGenerationEnabled()) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const response = await withRequestOwnerId(req, async (ownerId, headers) => {
    headers.set('Cache-Control', 'no-store');
    try {
      const raw = await readBody(req);
      if (revoke) {
        const body = deleteBody.safeParse(raw);
        if (!body.success)
          throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID_PROVIDER_INSTANCE');
        const revoked = await revokeMediaConfigSnapshots(ownerId, body.data.providerInstanceId);
        return Response.json({ revoked }, { headers });
      }
      const body = postBody.safeParse(raw);
      if (!body.success) throw new MediaConfigSnapshotError('MEDIA_CONFIG_INVALID');
      const ref = await syncMediaConfigSnapshot(ownerId, body.data.snapshot);
      return Response.json({ ref }, { headers });
    } catch (error) {
      if (error instanceof MediaConfigSnapshotError) {
        return json(error.code, error.status, headers);
      }
      return json('MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE', 503, headers);
    }
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function POST(req: Request): Promise<Response> {
  return handle(req, false);
}

export function DELETE(req: Request): Promise<Response> {
  return handle(req, true);
}
