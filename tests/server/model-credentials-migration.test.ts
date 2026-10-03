/**
 * Accounts v21 (credential vault and sign-in sessions, plan P6-1): repeatable,
 * enforces its checks, and isolates owners for both the web and the worker
 * role. Runs on PGlite always; set TEST_MODEL_CREDENTIALS_DATABASE_URL to a
 * dedicated disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml) to repeat it on real PostgreSQL.
 * The test drops and recreates the v21 tables in that database.
 */
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ACCOUNTS_MIGRATION_21 } from '@/lib/server/accounts/sql-model-credentials';

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** What v1–v20 leave behind that v21 relies on: roles and the owner GUC. */
const BASELINE = `
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_web') THEN CREATE ROLE app_web NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_worker') THEN CREATE ROLE app_worker NOLOGIN; END IF;
END
$roles$;
CREATE SCHEMA IF NOT EXISTS app_internal;
GRANT USAGE ON SCHEMA public, app_internal TO app_web, app_worker;
CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.owner_id', true), '') $$;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;
DROP TABLE IF EXISTS public.model_auth_sessions, public.model_credentials, public.model_auth_settings CASCADE;
`;

/** Split on statement ends, keeping $tag$ … $tag$ bodies whole. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let tag: string | null = null;
  for (const line of sql.split('\n')) {
    current += `${line}\n`;
    for (const match of line.matchAll(/\$[a-z_]*\$/g)) tag = tag === match[0] ? null : match[0];
    if (!tag && line.trimEnd().endsWith(';')) {
      out.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function apply(db: Db, sql: string): Promise<void> {
  for (const statement of statements(sql)) await db.query(statement);
}

function pglite(): Db {
  const db = new PGlite();
  return {
    query: (sql, values) => db.query(sql, values ?? []),
    close: () => db.close(),
  };
}

const url = process.env.TEST_MODEL_CREDENTIALS_DATABASE_URL?.trim();
let pool: Pool | undefined;

async function postgres(): Promise<Db> {
  const parsed = new URL(url!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error(
      'TEST_MODEL_CREDENTIALS_DATABASE_URL must be a disposable *_rls_proof database',
    );
  }
  pool ??= new Pool({ connectionString: url, max: 1 });
  return {
    query: (sql, values) => pool!.query(sql, values),
    close: async () => {
      await pool!.query(
        'DROP TABLE IF EXISTS public.model_auth_sessions, public.model_credentials, public.model_auth_settings CASCADE',
      );
    },
  };
}

afterAll(async () => {
  await pool?.end();
});

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function credential(owner: string, provider = 'openrouter', status = 'active') {
  const revoked = status === 'revoked';
  return {
    sql: `INSERT INTO public.model_credentials(id,owner_id,provider_id,pi_provider_id,auth_kind,status,
            ciphertext,key_version,secret_version,revoked_at)
          VALUES ($1,$2,$3,$3,'oauth',$4,$5,1,1,$6)`,
    values: [
      randomUUID(),
      owner,
      provider,
      status,
      revoked ? null : 'v1.sealed',
      revoked ? new Date().toISOString() : null,
    ],
  };
}

/** Run statements as `role` with app.owner_id = owner (or unset), then roll back. */
async function asRole<T>(
  db: Db,
  role: 'app_web' | 'app_worker',
  owner: string | null,
  body: () => Promise<T>,
): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (owner) await db.query("SELECT set_config('app.owner_id',$1,true)", [owner]);
    return await body();
  } finally {
    await db.query('ROLLBACK');
  }
}

const engines: Array<[string, () => Promise<Db>]> = [['PGlite', async () => pglite()]];
if (url) engines.push(['PostgreSQL', postgres]);

describe.each(engines)('accounts v21 credential vault (%s)', (_name, open) => {
  it('applies twice and enforces its checks', async () => {
    const db = await open();
    try {
      await apply(db, BASELINE);
      await apply(db, ACCOUNTS_MIGRATION_21);
      await apply(db, ACCOUNTS_MIGRATION_21);

      const ok = credential(OWNER_A);
      await db.query(ok.sql, ok.values);
      // One live credential per owner and provider; a revoked one does not count.
      const second = credential(OWNER_A);
      await expect(db.query(second.sql, second.values)).rejects.toThrow();
      const revoked = credential(OWNER_A, 'openrouter', 'revoked');
      await db.query(revoked.sql, revoked.values);

      // Revoked rows hold no secret; live rows always do.
      await expect(
        db.query(
          `INSERT INTO public.model_credentials(id,owner_id,provider_id,pi_provider_id,auth_kind,status,
             ciphertext,key_version,secret_version,revoked_at)
           VALUES ($1,$2,'xai','xai','oauth','revoked','v1.sealed',1,1,now())`,
          [randomUUID(), OWNER_A],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO public.model_credentials(id,owner_id,provider_id,pi_provider_id,auth_kind,status,
             ciphertext,key_version,secret_version)
           VALUES ($1,$2,'xai','xai','oauth','active',NULL,1,1)`,
          [randomUUID(), OWNER_A],
        ),
      ).rejects.toThrow();
      for (const [column, value] of [
        ['auth_kind', 'cookie'],
        ['status', 'paused'],
      ] as const) {
        await expect(
          db.query(
            `INSERT INTO public.model_credentials(id,owner_id,provider_id,pi_provider_id,auth_kind,status,
               ciphertext,key_version,secret_version)
             VALUES ($1,$2,'xai','xai',
               ${column === 'auth_kind' ? '$3' : "'oauth'"},${column === 'status' ? '$3' : "'active'"},
               'v1.sealed',1,1)`,
            [randomUUID(), OWNER_A, value],
          ),
        ).rejects.toThrow();
      }

      // One open sign-in session per owner and provider; input only while open.
      const session = `INSERT INTO public.model_auth_sessions(id,owner_id,provider_id,status,expires_at,input_ciphertext)
        VALUES ($1,$2,'openrouter',$3,now() + interval '10 minutes',$4)`;
      await db.query(session, [randomUUID(), OWNER_A, 'pending', null]);
      await expect(
        db.query(session, [randomUUID(), OWNER_A, 'awaiting_user', null]),
      ).rejects.toThrow();
      await db.query(session, [randomUUID(), OWNER_A, 'failed', null]);
      await expect(
        db.query(session, [randomUUID(), OWNER_A, 'complete', 'v1.input']),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO public.model_auth_sessions(id,owner_id,provider_id,expires_at,challenge)
           VALUES ($1,$2,'xai',now(),'[1]'::jsonb)`,
          [randomUUID(), OWNER_A],
        ),
      ).rejects.toThrow();

      // The deployment device id is a single row.
      await db.query('INSERT INTO public.model_auth_settings(id,device_id) VALUES (1,$1)', [
        randomUUID(),
      ]);
      await expect(
        db.query('INSERT INTO public.model_auth_settings(id,device_id) VALUES (2,$1)', [
          randomUUID(),
        ]),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('isolates owners for the web and the worker role', async () => {
    const db = await open();
    try {
      await apply(db, BASELINE);
      await apply(db, ACCOUNTS_MIGRATION_21);
      for (const owner of [OWNER_A, OWNER_B]) {
        const row = credential(owner);
        await db.query(row.sql, row.values);
        await db.query(
          `INSERT INTO public.model_auth_sessions(id,owner_id,provider_id,expires_at)
           VALUES ($1,$2,'openrouter',now() + interval '10 minutes')`,
          [randomUUID(), owner],
        );
      }

      for (const role of ['app_web', 'app_worker'] as const) {
        // Owner-bound: only A's credential, and nothing without an owner.
        const seen = await asRole(db, role, OWNER_A, () =>
          db.query('SELECT owner_id FROM public.model_credentials'),
        );
        expect(seen.rows).toEqual([{ owner_id: OWNER_A }]);
        const none = await asRole(db, role, null, () =>
          db.query('SELECT owner_id FROM public.model_credentials'),
        );
        expect(none.rows).toEqual([]);

        // Cannot write a row for another owner, nor move a row to one.
        const foreign = credential(OWNER_B, 'xai');
        await expect(
          asRole(db, role, OWNER_A, () => db.query(foreign.sql, foreign.values)),
        ).rejects.toThrow();
        await expect(
          asRole(db, role, OWNER_A, () =>
            db.query('UPDATE public.model_credentials SET owner_id=$1', [OWNER_B]),
          ),
        ).rejects.toThrow();
        const touched = await asRole(db, role, OWNER_A, () =>
          db.query(
            "UPDATE public.model_credentials SET status='reauth_required' WHERE owner_id=$1 RETURNING id",
            [OWNER_B],
          ),
        );
        expect(touched.rows).toEqual([]);
      }

      // Sign-in sessions: web sees its own; the worker has no access at all.
      const sessions = await asRole(db, 'app_web', OWNER_A, () =>
        db.query('SELECT owner_id FROM public.model_auth_sessions'),
      );
      expect(sessions.rows).toEqual([{ owner_id: OWNER_A }]);
      await expect(
        asRole(db, 'app_worker', OWNER_A, () =>
          db.query('SELECT 1 FROM public.model_auth_sessions'),
        ),
      ).rejects.toThrow();
      await expect(
        asRole(db, 'app_worker', OWNER_A, () =>
          db.query('SELECT 1 FROM public.model_auth_settings'),
        ),
      ).rejects.toThrow();

      // Web may create and read the device id, never change it.
      const id = randomUUID();
      const read = await asRole(db, 'app_web', null, async () => {
        await db.query('INSERT INTO public.model_auth_settings(id,device_id) VALUES (1,$1)', [id]);
        return db.query('SELECT device_id FROM public.model_auth_settings');
      });
      expect(read.rows).toEqual([{ device_id: id }]);
      await expect(
        asRole(db, 'app_web', null, async () => {
          await db.query('INSERT INTO public.model_auth_settings(id,device_id) VALUES (1,$1)', [
            id,
          ]);
          await db.query('UPDATE public.model_auth_settings SET device_id=$1', [randomUUID()]);
        }),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
