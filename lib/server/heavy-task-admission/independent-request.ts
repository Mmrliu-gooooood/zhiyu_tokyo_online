import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { backgroundGenerationEnabled } from '@/lib/server/generation-jobs/runtime';

import {
  checkHeavyTaskAdmission,
  heavyTaskSiteLimit,
  HEAVY_TASK_SYNC_OWNER_LOCK_CLASS,
  HEAVY_TASK_SYNC_SITE_LOCK_CLASS,
  withHeavyTaskRootContext,
  type HeavyTaskKind,
} from './index';

/**
 * Admit a synchronous parsing/media request without adding a database table.
 * A dedicated connection holds two session-level advisory locks only while the
 * bounded request runs. Durable claimers count these locks through pg_locks;
 * a process crash closes the connection and releases both locks automatically.
 */
export async function runIndependentHeavyTaskRequest(
  request: Request,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  body: () => Promise<Response>,
): Promise<Response> {
  // Worker deployments reject browser media routes at their existing guard;
  // durable worker/Pro media already inherits its admitted root context.
  if (kind === 'media' && backgroundGenerationEnabled()) return body();
  if (!process.env.DATABASE_URL?.trim()) return body();

  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  const ownerId = resolveRequestOwnerId(request, responseHeaders);
  const rootTaskId = `independent:${kind}:${randomUUID()}`;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  let ownerLocked = false;
  let siteSlot: number | null = null;
  try {
    await client.connect();
    await client.query('BEGIN');
    const decision = await checkHeavyTaskAdmission(client, {
      ownerId,
      rootTaskId,
      kind,
      agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
    });
    if (!decision.allowed) {
      await client.query('COMMIT');
      return limitResponse(decision.reason, responseHeaders);
    }

    ownerLocked =
      (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1::integer, hashtext($2)) AS locked',
          [HEAVY_TASK_SYNC_OWNER_LOCK_CLASS, ownerId],
        )
      ).rows[0]?.locked === true;
    if (ownerLocked) {
      for (let slot = 1; slot <= heavyTaskSiteLimit(); slot += 1) {
        const locked = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked',
          [HEAVY_TASK_SYNC_SITE_LOCK_CLASS, slot],
        );
        if (locked.rows[0]?.locked) {
          siteSlot = slot;
          break;
        }
      }
    }
    await client.query('COMMIT');
    if (!ownerLocked) return limitResponse('personal_limit', responseHeaders);
    if (siteSlot === null) return limitResponse('site_limit', responseHeaders);

    const response = await withHeavyTaskRootContext({ ownerId, rootTaskId, kind }, body);
    appendResponseHeaders(response, responseHeaders);
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (siteSlot !== null) {
      await client
        .query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [
          HEAVY_TASK_SYNC_SITE_LOCK_CLASS,
          siteSlot,
        ])
        .catch(() => undefined);
    }
    if (ownerLocked) {
      await client
        .query('SELECT pg_advisory_unlock($1::integer, hashtext($2))', [
          HEAVY_TASK_SYNC_OWNER_LOCK_CLASS,
          ownerId,
        ])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

function limitResponse(reason: 'personal_limit' | 'site_limit', headers: Headers): Response {
  return Response.json(
    {
      success: false,
      errorCode:
        reason === 'personal_limit' ? 'HEAVY_TASK_PERSONAL_LIMIT' : 'HEAVY_TASK_SITE_LIMIT',
      error:
        reason === 'personal_limit'
          ? 'Your previous heavy task is still running.'
          : 'The service is busy with another heavy task.',
    },
    { status: 429, headers },
  );
}

function appendResponseHeaders(response: Response, headers: Headers): void {
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') response.headers.append(name, value);
  });
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  for (const cookie of cookies ?? []) response.headers.append('Set-Cookie', cookie);
}
