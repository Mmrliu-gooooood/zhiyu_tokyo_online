import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS_RLS_SQL_V11,
  ACCOUNTS_RLS_SQL_V12,
  ACCOUNTS_RLS_SQL_V13,
  ACCOUNTS_RLS_SQL_V14,
  ACCOUNTS_RLS_SQL_V15,
  ACCOUNTS_RLS_SQL_V16,
  ACCOUNTS_RLS_SQL_V17,
  ACCOUNTS_RLS_SQL_V18,
} from '@/lib/server/accounts/sql-rls';

describe('hosted readiness and capacity SECURITY DEFINER boundary', () => {
  it('exports only aggregate/readiness and fenced reservation functions', () => {
    expect(ACCOUNTS_RLS_SQL_V11).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.generation_readiness()',
    );
    expect(ACCOUNTS_RLS_SQL_V11).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.heavy_task_capacity(',
    );
    expect(ACCOUNTS_RLS_SQL_V11).toContain('SECURITY DEFINER');
    expect(ACCOUNTS_RLS_SQL_V11).toContain('SET search_path = pg_catalog, public, app_internal');
    expect(ACCOUNTS_RLS_SQL_V11).toContain(
      'REVOKE ALL ON FUNCTION app_internal.heavy_task_capacity',
    );
    expect(ACCOUNTS_RLS_SQL_V11).toContain(
      'GRANT EXECUTE ON FUNCTION app_internal.heavy_task_capacity',
    );
  });

  it('exposes a v12 owner-bound foreground root seam without table grants', () => {
    expect(ACCOUNTS_RLS_SQL_V12).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.acquire_foreground_generation_root(',
    );
    expect(ACCOUNTS_RLS_SQL_V12).toContain('PERFORM app_internal.assert_heavy_task_owner');
    expect(ACCOUNTS_RLS_SQL_V12).toContain(
      "pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'))",
    );
    expect(ACCOUNTS_RLS_SQL_V12).toContain(
      'REVOKE ALL ON FUNCTION app_internal.acquire_foreground_generation_root',
    );
    expect(ACCOUNTS_RLS_SQL_V12).toContain(
      'GRANT EXECUTE ON FUNCTION app_internal.acquire_foreground_generation_root',
    );
    expect(ACCOUNTS_RLS_SQL_V12).not.toContain('GRANT SELECT ON public.generation_provider_slots');
  });

  it('does not grant app_web direct cross-owner access to capacity source tables', () => {
    expect(ACCOUNTS_RLS_SQL_V11).not.toContain(
      'generation_provider_slots, generation_worker_heartbeats, generation_schema_migrations\n    TO app_web',
    );
    expect(ACCOUNTS_RLS_SQL_V11).not.toContain('CREATE POLICY generation_provider_slots_web_all');
    expect(ACCOUNTS_RLS_SQL_V11).toContain(
      'p_owner_id IS DISTINCT FROM app_internal.current_owner_id()',
    );
  });

  it('fences deleted accounts in v13 without weakening the v12 owner boundary', () => {
    expect(ACCOUNTS_RLS_SQL_V13).toContain('heavy_task_owner_active');
    expect(ACCOUNTS_RLS_SQL_V13).toContain("account.status='active'");
    expect(ACCOUNTS_RLS_SQL_V13).toContain('deleted_account_tombstones');
    expect(ACCOUNTS_RLS_SQL_V13).toContain('RETURN false');
    expect(ACCOUNTS_RLS_SQL_V13).toContain('SET search_path = pg_catalog, public, app_internal');
    expect(ACCOUNTS_RLS_SQL_V13).not.toContain('GRANT SELECT ON public.generation_provider_slots');
  });

  it('exposes only aggregate deployment readiness in v14', () => {
    expect(ACCOUNTS_RLS_SQL_V14).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.deployment_readiness(p_pipeline_versions jsonb)',
    );
    expect(ACCOUNTS_RLS_SQL_V14).toContain('SECURITY DEFINER');
    expect(ACCOUNTS_RLS_SQL_V14).toContain(
      'REVOKE ALL ON FUNCTION app_internal.deployment_readiness(jsonb)',
    );
    expect(ACCOUNTS_RLS_SQL_V14).toContain(
      'GRANT EXECUTE ON FUNCTION app_internal.deployment_readiness(jsonb) TO app_worker',
    );
    expect(ACCOUNTS_RLS_SQL_V14).not.toContain('GRANT SELECT ON');
  });

  it('matches the string-valued worker pipeline heartbeat in v15', () => {
    expect(ACCOUNTS_RLS_SQL_V15).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.generation_readiness()',
    );
    expect(ACCOUNTS_RLS_SQL_V15).toContain(`pipeline_versions @> '["2"]'::jsonb`);
    expect(ACCOUNTS_RLS_SQL_V15).toContain(
      'GRANT EXECUTE ON FUNCTION app_internal.generation_readiness() TO app_web, app_worker',
    );
  });

  it('grants only server roles access to the generation event identity sequence in v16', () => {
    expect(ACCOUNTS_RLS_SQL_V16).toContain(
      'REVOKE ALL ON SEQUENCE public.generation_events_id_seq FROM PUBLIC, anon, authenticated',
    );
    expect(ACCOUNTS_RLS_SQL_V16).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE public.generation_events_id_seq TO app_web, app_worker',
    );
    expect(ACCOUNTS_RLS_SQL_V16).not.toContain('TO authenticated');
  });

  it('permits only owner-bound asset row locks while keeping blob updates denied in v17', () => {
    expect(ACCOUNTS_RLS_SQL_V17).toContain(
      'GRANT UPDATE(content_hash) ON TABLE public.asset_blobs TO app_web',
    );
    expect(ACCOUNTS_RLS_SQL_V17).toContain('CREATE POLICY asset_blobs_web_lock');
    expect(ACCOUNTS_RLS_SQL_V17).toContain('entry.principal = app_internal.current_owner_id()');
    expect(ACCOUNTS_RLS_SQL_V17).toContain('WITH CHECK (false)');
    expect(ACCOUNTS_RLS_SQL_V17).not.toContain('TO authenticated');
  });

  it('routes hosted blob writes through narrow owner-validated functions in v18', () => {
    expect(ACCOUNTS_RLS_SQL_V18).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.claim_asset_blob',
    );
    expect(ACCOUNTS_RLS_SQL_V18).toContain(
      'CREATE OR REPLACE FUNCTION app_internal.release_asset_blob',
    );
    expect(ACCOUNTS_RLS_SQL_V18).toContain("account.status = 'active'");
    expect(ACCOUNTS_RLS_SQL_V18).toContain("p_hash !~ '^sha256-[0-9a-f]{64}$'");
    expect(ACCOUNTS_RLS_SQL_V18).toContain(
      'GRANT EXECUTE ON FUNCTION app_internal.claim_asset_blob(text,bigint) TO app_web',
    );
    expect(ACCOUNTS_RLS_SQL_V18).not.toContain('GRANT INSERT ON TABLE public.asset_blobs');
    expect(ACCOUNTS_RLS_SQL_V18).not.toContain('TO authenticated');
  });
});
