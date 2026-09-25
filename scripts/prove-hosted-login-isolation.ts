/**
 * Connect as zhiyu_app_web (not postgres), set app.owner_id, prove A vs B
 * on hosted document_stages, delete the fixture. Never prints secrets.
 *
 *   pnpm accounts:prove-hosted-login
 */
import { randomBytes } from 'node:crypto';
import {
  HOSTED_SESSION_POOLER_HOST,
  HOSTED_WEB_ROLE,
  hostedAppWebDatabaseUrl,
  hostedPgPool,
  hostedRoleFromUsername,
  isHostedDbHost,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

const WEB_ROLE = HOSTED_WEB_ROLE;
const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : 'error';
  return message
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .replace(/postgres:\/\/[^@\s]+@/gi, 'postgres://***@')
    .replace(/password[=:]\s*\S+/gi, 'password=***');
}

async function main() {
  loadHostedOperatorEnv();
  const url = hostedAppWebDatabaseUrl();
  if (!url) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'login-isolation',
        reason: 'missing-DATABASE_URL_APP_WEB',
        blocked: true,
        next: 'Run pnpm accounts:create-hosted-logins, apply passwords, then re-run. Do not set live DATABASE_URL.',
      }),
    );
    process.exitCode = 1;
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.info(JSON.stringify({ ok: false, reason: 'unparseable-url', blocked: true }));
    process.exitCode = 1;
    return;
  }
  if (!isHostedDbHost(parsed.hostname)) {
    console.info(JSON.stringify({ ok: false, reason: 'refusing-non-hosted-host', blocked: true }));
    process.exitCode = 1;
    return;
  }
  if (hostedRoleFromUsername(parsed.username) !== WEB_ROLE) {
    console.info(JSON.stringify({ ok: false, reason: 'refusing-non-app-web-user', blocked: true }));
    process.exitCode = 1;
    return;
  }

  const fixtureId = `hosted-login-iso-${randomBytes(6).toString('hex')}`;
  const pool = hostedPgPool(url);

  try {
    const client = await pool.connect();
    try {
      const who = await client.query<{ current_user: string }>('SELECT current_user');
      const currentUser = who.rows[0]?.current_user;
      if (currentUser !== WEB_ROLE) {
        console.info(
          JSON.stringify({
            ok: false,
            reason: 'connected-as-wrong-role',
            currentUser,
            expected: WEB_ROLE,
          }),
        );
        process.exitCode = 1;
        return;
      }

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_id', $1, true)", [OWNER_A]);
      await client.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ($1, 'login-iso-fixture', 0, 0, $2, '{}'::jsonb)`,
        [fixtureId, OWNER_A],
      );
      await client.query(
        `INSERT INTO stage_meta (stage_id, owner_id, is_public, generation_complete)
         VALUES ($1, $2, false, false)`,
        [fixtureId, OWNER_A],
      );
      await client.query(
        `INSERT INTO document_outlines (stage_id, data)
         VALUES ($1, jsonb_build_object('outlines', '[]'::jsonb, 'producer', 'client'))`,
        [fixtureId],
      );
      await client.query(
        `INSERT INTO generation_ownership (stage_id, owner_id, producer_kind, write_mode)
         VALUES ($1, $2, 'client', 'editable')`,
        [fixtureId, OWNER_A],
      );
      await client.query(
        `INSERT INTO generation_jobs (
           id, stage_id, owner_id, idempotency_key, request_hash, status,
           pipeline_version, config_version, input_snapshot, review_policy
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, 'login-iso-hash', 'cancelled',
           '2', 'server-v1', '{}'::jsonb, 'auto'
         )`,
        [fixtureId, OWNER_A, fixtureId],
      );
      const asA = await client.query<{ id: string }>(
        'SELECT id FROM document_stages WHERE id = $1',
        [fixtureId],
      );
      const ownershipA = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM generation_ownership WHERE stage_id = $1',
        [fixtureId],
      );
      const jobsA = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM generation_jobs WHERE stage_id = $1',
        [fixtureId],
      );
      await client.query("SELECT set_config('app.owner_id', $1, true)", [OWNER_B]);
      const asB = await client.query<{ id: string }>(
        'SELECT id FROM document_stages WHERE id = $1',
        [fixtureId],
      );
      const listB = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM document_stages');
      const ownershipB = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM generation_ownership',
      );
      const jobsB = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM generation_jobs');
      await client.query("SELECT set_config('app.owner_id', '', true)");
      const asNone = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM document_stages');
      await client.query("SELECT set_config('app.owner_id', $1, true)", [OWNER_A]);
      await client.query('DELETE FROM generation_jobs WHERE stage_id = $1', [fixtureId]);
      await client.query('DELETE FROM generation_ownership WHERE stage_id = $1', [fixtureId]);
      await client.query('DELETE FROM document_stages WHERE id = $1', [fixtureId]);
      const leftover = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM document_stages WHERE id = $1',
        [fixtureId],
      );
      const leftoverJobs = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM generation_jobs WHERE stage_id = $1',
        [fixtureId],
      );
      const leftoverOwnership = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM generation_ownership WHERE stage_id = $1',
        [fixtureId],
      );
      await client.query('COMMIT');

      const leftoverCount = Number(leftover.rows[0]?.n ?? -1);
      const ok =
        asA.rows.length === 1 &&
        Number(ownershipA.rows[0]?.n) === 1 &&
        Number(jobsA.rows[0]?.n) === 1 &&
        asB.rows.length === 0 &&
        listB.rows[0]?.n === '0' &&
        ownershipB.rows[0]?.n === '0' &&
        jobsB.rows[0]?.n === '0' &&
        asNone.rows[0]?.n === '0' &&
        leftoverCount === 0 &&
        Number(leftoverJobs.rows[0]?.n) === 0 &&
        Number(leftoverOwnership.rows[0]?.n) === 0;
      console.info(
        JSON.stringify({
          ok,
          proof: 'login-isolation',
          connectedAs: currentUser,
          transport: parsed.hostname === HOSTED_SESSION_POOLER_HOST ? 'session-pooler' : 'direct',
          fixtureDeleted: leftoverCount === 0,
          shape: 'generation-v1',
          aSeesOwn: asA.rows.length,
          aOwnership: Number(ownershipA.rows[0]?.n ?? -1),
          aJobs: Number(jobsA.rows[0]?.n ?? -1),
          bSeesA: asB.rows.length,
          bListCount: Number(listB.rows[0]?.n ?? -1),
          bOwnership: Number(ownershipB.rows[0]?.n ?? -1),
          bJobs: Number(jobsB.rows[0]?.n ?? -1),
          noOwnerCount: Number(asNone.rows[0]?.n ?? -1),
          leftoverJobs: Number(leftoverJobs.rows[0]?.n ?? -1),
          leftoverOwnership: Number(leftoverOwnership.rows[0]?.n ?? -1),
        }),
      );
      if (!ok) process.exitCode = 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = redact(error);
    const authFailed = /password authentication failed/i.test(message);
    const timeout = /timeout|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(message);
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'login-isolation',
        blocked: true,
        reason: authFailed ? 'password-auth-failed' : timeout ? 'connect-failed' : 'query-failed',
        error: message,
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main();
