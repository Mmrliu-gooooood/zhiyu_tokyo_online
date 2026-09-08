import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  parseProModelRef,
  ProModelConnectionError,
  revokeModelConnections,
  syncModelConnection,
} from '@/lib/server/agent-runtime/model-connections';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';

export const runtime = 'nodejs';

async function handle(req: Request, revoke: boolean): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwnerId(req, async (ownerId, headers) => {
    headers.set('Cache-Control', 'no-store');
    try {
      if (Number(req.headers.get('content-length') ?? 0) > 32768) {
        return Response.json({ error: 'PRO_MODEL_INVALID_CONFIG' }, { status: 413, headers });
      }
      const raw = await req.text();
      if (raw.length > 32768)
        return Response.json({ error: 'PRO_MODEL_INVALID_CONFIG' }, { status: 413, headers });
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new ProModelConnectionError('PRO_MODEL_INVALID_CONFIG');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new ProModelConnectionError('PRO_MODEL_INVALID_CONFIG');
      if (revoke) {
        if (body.id !== undefined && typeof body.id !== 'string')
          throw new ProModelConnectionError('PRO_MODEL_INVALID_REFERENCE');
        await revokeModelConnections(ownerId, body.id);
        return Response.json({ revoked: true }, { headers });
      }
      const previous = body.ref === undefined ? undefined : parseProModelRef(body.ref);
      if (body.ref !== undefined && !previous)
        throw new ProModelConnectionError('PRO_MODEL_INVALID_REFERENCE');
      const ref = await syncModelConnection(ownerId, body, previous);
      return Response.json({ ref }, { headers });
    } catch (error) {
      if (error instanceof ProModelConnectionError) {
        return Response.json({ error: error.code }, { status: error.status, headers });
      }
      return Response.json({ error: 'PRO_MODEL_CONNECTION_UNAVAILABLE' }, { status: 503, headers });
    }
  });
}

export function POST(req: Request) {
  return handle(req, false);
}
export function DELETE(req: Request) {
  return handle(req, true);
}
