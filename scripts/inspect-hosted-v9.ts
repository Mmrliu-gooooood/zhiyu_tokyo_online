/**
 * Hosted-only read of v9 grants/RLS. Never prints URLs or passwords.
 */
import {
  hostedPgPool,
  hostedRoleFromUsername,
  isHostedDbHost,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

async function main() {
  loadHostedOperatorEnv();
  const url = process.env.HOSTED_DB_ADMIN_URL?.trim();
  if (!url) {
    console.info(JSON.stringify({ ok: false, reason: 'missing-hosted-admin-url' }));
    process.exitCode = 1;
    return;
  }
  const parsed = new URL(url);
  if (!isHostedDbHost(parsed.hostname) || hostedRoleFromUsername(parsed.username) !== 'postgres') {
    console.info(JSON.stringify({ ok: false, reason: 'refusing-non-hosted-admin' }));
    process.exitCode = 1;
    return;
  }
  const pool = hostedPgPool(url);
  const client = await pool.connect();
  try {
    const db = await client.query<{ current_database: string }>('SELECT current_database()');
    const migrations = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM app_schema_migrations ORDER BY version',
    );
    const rls = await client.query<{ relname: string; rls: boolean; force_rls: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN ('document_stages','generation_jobs','generation_ownership','stage_meta','app_accounts')
        ORDER BY 1`,
    );
    const counts = await client.query<{ stages: string; jobs: string; ownership: string; accounts: string }>(
      `SELECT
         (SELECT count(*)::text FROM document_stages) AS stages,
         (SELECT count(*)::text FROM generation_jobs) AS jobs,
         (SELECT count(*)::text FROM generation_ownership) AS ownership,
         (SELECT count(*)::text FROM app_accounts) AS accounts`,
    );
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='generation_jobs'
          AND column_name IN ('id','stage_id','owner_id','idempotency_key')
        ORDER BY 1`,
    );
    const grants = await client.query<{ table_name: string; grantee: string; privilege_type: string }>(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema='public'
          AND table_name IN ('document_stages','generation_jobs','generation_ownership')
          AND grantee IN ('app_web','app_worker','zhiyu_app_web','anon','authenticated','PUBLIC')
        ORDER BY 1, 2, 3`,
    );
    const inherit = await client.query<{ rolname: string; rolinherit: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolinherit, rolbypassrls FROM pg_roles
        WHERE rolname IN ('app_web','app_worker','zhiyu_app_web','zhiyu_app_worker')
        ORDER BY 1`,
    );
    const members = await client.query<{ role: string; member: string }>(
      `SELECT r.rolname AS role, m.rolname AS member
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname IN ('app_web','app_worker')
        ORDER BY 1, 2`,
    );
    const priv = await client.query<{
      web_jobs_select: boolean;
      web_jobs_insert: boolean;
      web_jobs_update: boolean;
      web_jobs_delete: boolean;
      login_jobs_insert: boolean;
      login_stages_insert: boolean;
    }>(
      `SELECT
         has_table_privilege('app_web','public.generation_jobs','SELECT') AS web_jobs_select,
         has_table_privilege('app_web','public.generation_jobs','INSERT') AS web_jobs_insert,
         has_table_privilege('app_web','public.generation_jobs','UPDATE') AS web_jobs_update,
         has_table_privilege('app_web','public.generation_jobs','DELETE') AS web_jobs_delete,
         has_table_privilege('zhiyu_app_web','public.generation_jobs','INSERT') AS login_jobs_insert,
         has_table_privilege('zhiyu_app_web','public.document_stages','INSERT') AS login_stages_insert`,
    );
    const policies = await client.query<{ tablename: string; policyname: string; cmd: string; roles: string[] }>(
      `SELECT tablename, policyname, cmd, roles FROM pg_policies
        WHERE schemaname='public'
          AND tablename IN ('generation_jobs','generation_ownership','document_stages')
        ORDER BY 1, 2`,
    );
    console.info(
      JSON.stringify({
        ok: true,
        database: db.rows[0]?.current_database,
        migrations: migrations.rows.map((row) => ({
          version: row.version,
          checksumPrefix: row.checksum.slice(0, 16),
        })),
        rls: rls.rows,
        counts: counts.rows[0],
        jobCols: cols.rows,
        grants: grants.rows,
        inherit: inherit.rows,
        members: members.rows,
        priv: priv.rows[0],
        policies: policies.rows,
      }),
    );
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

void main();
