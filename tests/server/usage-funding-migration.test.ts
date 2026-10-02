/**
 * Accounts v20 (usage funding columns) is additive, repeatable and enforces
 * its value checks. Runs on PGlite always; set TEST_USAGE_MIGRATION_DATABASE_URL
 * to a disposable *_rls_proof database on 127.0.0.1:55432
 * (docker-compose.accounts-rls-proof.yml) to repeat it on real PostgreSQL.
 */
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ACCOUNTS_MIGRATION_20 } from '@/lib/server/accounts/sql-usage-funding';

interface Db {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** usage_events as accounts v1 + v11 left it (the columns v20 builds on). */
const BASELINE = `
CREATE TABLE usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL,
  source text NOT NULL,
  kind text NOT NULL,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

function statements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
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

const url = process.env.TEST_USAGE_MIGRATION_DATABASE_URL?.trim();
const schema = `usage_v20_${process.pid}_${Date.now()}`;
let pool: Pool | undefined;

async function postgres(): Promise<Db> {
  const parsed = new URL(url!);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55432' ||
    !parsed.pathname.replace(/^\//, '').endsWith('_rls_proof')
  ) {
    throw new Error('TEST_USAGE_MIGRATION_DATABASE_URL must be a disposable *_rls_proof database');
  }
  pool ??= new Pool({ connectionString: url, max: 1 });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}`);
  return {
    query: (sql, values) => pool!.query(sql.replaceAll('public.', `${schema}.`), values),
    close: async () => {
      await pool!.query(`DROP SCHEMA ${schema} CASCADE`);
    },
  };
}

afterAll(async () => {
  await pool?.end();
});

const engines: Array<[string, () => Promise<Db>]> = [['PGlite', async () => pglite()]];
if (url) engines.push(['PostgreSQL', postgres]);

describe.each(engines)('accounts v20 usage funding columns (%s)', (_name, open) => {
  it('applies twice, keeps old rows and checks the new values', async () => {
    const db = await open();
    try {
      await apply(db, BASELINE.replaceAll('usage_events', 'public.usage_events'));
      await db.query(
        "INSERT INTO public.usage_events(owner_id,source,kind) VALUES ('owner-a','chat','llm')",
      );
      await apply(db, ACCOUNTS_MIGRATION_20);
      await apply(db, ACCOUNTS_MIGRATION_20);

      const old = await db.query('SELECT funding_kind, status FROM public.usage_events');
      expect(old.rows).toEqual([{ funding_kind: null, status: null }]);

      await db.query(
        `INSERT INTO public.usage_events(owner_id,source,kind,funding_kind,platform_default_id,
           platform_revision,credential_kind,api,status,estimated_cost_usd)
         VALUES ('owner-a','chat','llm','platform','zhiyu-default-text','r1','platform',
           'openai-completions','ok',0.00012345)`,
      );
      const row = await db.query(
        "SELECT estimated_cost_usd FROM public.usage_events WHERE funding_kind='platform'",
      );
      expect(Number(row.rows[0]?.estimated_cost_usd)).toBeCloseTo(0.00012345, 8);

      for (const [column, value] of [
        ['funding_kind', 'free'],
        ['credential_kind', 'cookie'],
        ['status', 'maybe'],
        ['estimated_cost_usd', -1],
      ] as const) {
        await expect(
          db.query(
            `INSERT INTO public.usage_events(owner_id,source,kind,${column}) VALUES ('o','s','llm',$1)`,
            [value],
          ),
        ).rejects.toThrow();
      }
    } finally {
      await db.close();
    }
  });
});
