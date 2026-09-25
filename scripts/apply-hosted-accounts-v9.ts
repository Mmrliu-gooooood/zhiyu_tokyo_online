/**
 * Hosted-only accounts v9. Refuses classroom openmaic and non-empty
 * document_stages / generation_jobs. Never prints secrets.
 *
 *   pnpm accounts:apply-hosted-v9
 */
import { createHash } from 'node:crypto';
import { ACCOUNT_MIGRATIONS } from '../lib/server/accounts/migrations';
import {
  hostedPgPool,
  hostedRoleFromUsername,
  isHostedDbHost,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .replace(/postgres:\/\/[^@\s]+@/gi, 'postgres://***@')
    .replace(/password[=:]\s*\S+/gi, 'password=***');
}

async function main() {
  loadHostedOperatorEnv();
  const url = process.env.HOSTED_DB_ADMIN_URL?.trim() || process.env.GENERATION_MIGRATION_DATABASE_URL?.trim();
  if (!url) {
    console.info(JSON.stringify({ ok: false, reason: 'missing-hosted-admin-url', blocked: true }));
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
  if (hostedRoleFromUsername(parsed.username) !== 'postgres') {
    console.info(JSON.stringify({ ok: false, reason: 'refusing-non-admin-user', blocked: true }));
    process.exitCode = 1;
    return;
  }

  const migration = ACCOUNT_MIGRATIONS.find((item) => item.version === 9);
  if (!migration) throw new Error('accounts v9 missing');
  const checksum = createHash('sha256').update(migration.sql).digest('hex');
  const pool = hostedPgPool(url);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:accounts:migrations'))");
    const db = await client.query<{ current_database: string }>('SELECT current_database()');
    if (db.rows[0]?.current_database === 'openmaic') {
      throw new Error('refusing hosted v9 on classroom database openmaic');
    }
    const counts = await client.query<{ stages: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM public.document_stages) AS stages,
         (SELECT count(*)::text FROM public.generation_jobs) AS jobs`,
    );
    if (counts.rows[0]?.stages !== '0' || counts.rows[0]?.jobs !== '0') {
      throw new Error('refusing hosted v9 because document_stages or generation_jobs has rows');
    }
    await client.query(
      'CREATE TABLE IF NOT EXISTS app_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    const found = await client.query<{ checksum: string }>(
      'SELECT checksum FROM app_schema_migrations WHERE version=9',
    );
    let applied = false;
    if (found.rows.length && found.rows[0]!.checksum !== checksum) {
      // Tables are still empty (guarded above). Re-apply v9 when SQL changed.
      await client.query('DELETE FROM app_schema_migrations WHERE version=9');
      found.rows.length = 0;
    }
    if (found.rows.length) {
      if (found.rows[0]!.checksum !== checksum) {
        throw new Error('Accounts migration checksum mismatch');
      }
    } else {
      const statements: string[] = [];
      let current = '';
      let i = 0;
      const sql = migration.sql;
      while (i < sql.length) {
        if (sql[i] === '$') {
          const match = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
          if (match) {
            const tag = match[0];
            const end = sql.indexOf(tag, i + tag.length);
            if (end === -1) {
              current += sql.slice(i);
              break;
            }
            current += sql.slice(i, end + tag.length);
            i = end + tag.length;
            continue;
          }
        }
        if (sql[i] === ';') {
          const trimmed = current.trim();
          if (trimmed) statements.push(trimmed);
          current = '';
          i += 1;
          continue;
        }
        current += sql[i]!;
        i += 1;
      }
      const tail = current.trim();
      if (tail) statements.push(tail);
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query('INSERT INTO app_schema_migrations(version,checksum) VALUES(9,$1)', [
        checksum,
      ]);
      applied = true;
    }
    const shape = await client.query<{
      job_id_type: string | null;
      has_idempotency: boolean;
      ownership_pk: string | null;
    }>(
      `SELECT
         (SELECT data_type FROM information_schema.columns
           WHERE table_schema='public' AND table_name='generation_jobs' AND column_name='id') AS job_id_type,
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='generation_jobs' AND column_name='idempotency_key'
         ) AS has_idempotency,
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='generation_ownership' AND column_name='stage_id') AS ownership_pk`,
    );
    await client.query('COMMIT');
    console.info(
      JSON.stringify({
        ok: true,
        proof: 'hosted-accounts-v9',
        applied,
        checksum,
        jobIdType: shape.rows[0]?.job_id_type ?? null,
        hasIdempotency: shape.rows[0]?.has_idempotency === true,
        ownershipHasStageId: shape.rows[0]?.ownership_pk === 'stage_id',
      }),
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.info(JSON.stringify({ ok: false, proof: 'hosted-accounts-v9', error: redact(error) }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

void main();
