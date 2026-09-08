/**
 * Server-side agent runtime status probe.
 *
 *   GET /api/agent/runtime -> { enabled: boolean, runtimeEnabled: boolean }
 *
 * `enabled` reports usability, not intent: the workbench client gates its
 * entry on this field, so it is true only when the runtime can actually serve
 * a request — the flag AND a `DATABASE_URL` (the runner and every
 * persistence-touching route need the store). `runtimeEnabled` carries the
 * raw intent flag so a client can tell "off by choice" (`runtimeEnabled:
 * false`) from "on but unusable" (`runtimeEnabled: true`, missing
 * DATABASE_URL).
 */
import { isAgentRuntimeConfigured, isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  parseProModelRef,
  resolveProModelContext,
} from '@/lib/server/agent-runtime/model-connections';
import { preflightProModel } from '@/lib/server/agent-runtime/model-preflight';

export const runtime = 'nodejs';

export async function GET() {
  // Intentionally no materials flag: isAgentMaterialsEnabled does not exist in
  // this repo (the materials routes gate on the runtime, like the stages).
  return Response.json({
    enabled: isAgentRuntimeConfigured(),
    runtimeEnabled: isAgentRuntimeEnabled(),
    modelConfigurationChecked: false,
  });
}

/** Authenticated static preflight; readiness does not attest upstream key acceptance. */
export async function POST(req: Request) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwnerId(req, async (ownerId, headers) => {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ errorCode: 'INVALID_REQUEST' }, { status: 400, headers });
    }
    const ref = parseProModelRef(body.modelRef);
    if (body.modelRef !== undefined && !ref) {
      return Response.json({ errorCode: 'INVALID_REQUEST' }, { status: 400, headers });
    }
    const context = ref ? await resolveProModelContext(ownerId, ref) : undefined;
    const readiness = await preflightProModel(context);
    return Response.json(
      {
        enabled: true,
        runtimeEnabled: true,
        modelConfigurationChecked: true,
        upstreamVerified: false,
        ...readiness,
      },
      { headers },
    );
  });
}
