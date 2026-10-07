import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays legacy when unset so teach-back and anonymous owners keep working', async () => {
    vi.resetModules();
    const { getAuthMode, isHostedAuthEnabled } = await import('@/lib/auth/mode');
    expect(getAuthMode()).toBe('legacy');
    expect(isHostedAuthEnabled()).toBe(false);
  });

  it('enables hosted mode when both flags are supabase', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const { getAuthMode, isHostedAuthEnabled } = await import('@/lib/auth/mode');
    expect(getAuthMode()).toBe('supabase');
    expect(isHostedAuthEnabled()).toBe(true);
  });

  it('allows auth UI from publishable config without flipping AUTH_MODE', async () => {
    vi.resetModules();
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { getAuthMode, isHostedAuthEnabled, canUseHostedAuthUi } =
      await import('@/lib/auth/mode');
    expect(getAuthMode()).toBe('legacy');
    expect(isHostedAuthEnabled()).toBe(false);
    expect(canUseHostedAuthUi()).toBe(true);
  });
});

describe('principal encoding', () => {
  it('uses a single user:uuid encoding for owner, learner, and asset', async () => {
    const { createPrincipal, encodeOwnerId } = await import('@/lib/auth/principal');
    const userId = '11111111-1111-4111-8111-111111111111';
    const principal = createPrincipal({
      userId,
      role: 'user',
      sessionId: '22222222-2222-4222-8222-222222222222',
      email: 'a@example.com',
    });
    expect(principal.ownerId).toBe(encodeOwnerId(userId));
    expect(principal.learnerKey).toBe(principal.ownerId);
    expect(principal.assetPrincipal).toBe(principal.ownerId);
    expect(principal.role).toBe('user');
  });

  it('does not treat metadata nicknames as admin', async () => {
    const { requireAdmin, createPrincipal } = await import('@/lib/auth/principal');
    const principal = createPrincipal({
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      sessionId: '22222222-2222-4222-8222-222222222222',
      email: 'admin@example.com',
    });
    expect(() => requireAdmin(principal)).toThrow(/Administrator/);
  });
});

describe('safe next path', () => {
  it('rejects protocol-relative and auth-loop targets', async () => {
    const { safeNextPath } = await import('@/lib/auth/safe-next');
    expect(safeNextPath('https://evil.example/phish')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/auth/login')).toBe('/');
    expect(safeNextPath('/classroom/abc')).toBe('/classroom/abc');
  });
});

describe('public auth paths', () => {
  it('keeps Docker health probes public without exposing private media by extension', async () => {
    const { isPublicAuthPath } = await import('@/lib/auth/public-paths');
    expect(isPublicAuthPath('/api/health')).toBe(true);
    expect(isPublicAuthPath('/api/health/ready')).toBe(true);
    expect(isPublicAuthPath('/auth/login')).toBe(true);
    expect(isPublicAuthPath('/auth/sign-up')).toBe(true);
    expect(isPublicAuthPath('/auth/signup')).toBe(true);
    expect(isPublicAuthPath('/api/auth/resend')).toBe(true);
    expect(isPublicAuthPath('/api/classroom-media/abc/slide.png')).toBe(false);
  });
});

describe('implicit auth hash', () => {
  it('detects default ConfirmationURL fragments without needing the token value', async () => {
    const { hashContainsImplicitAuth, readImplicitSessionFromHash } =
      await import('@/lib/auth/implicit-hash');
    expect(hashContainsImplicitAuth('#access_token=redacted&type=signup')).toBe(true);
    expect(hashContainsImplicitAuth('#type=recovery')).toBe(false);
    expect(hashContainsImplicitAuth('')).toBe(false);
    expect(readImplicitSessionFromHash('#type=signup')).toBeUndefined();
    const session = readImplicitSessionFromHash(
      '#access_token=redacted-access&refresh_token=redacted-refresh',
    );
    expect(session?.accessToken).toBe('redacted-access');
    expect(session?.refreshToken).toBe('redacted-refresh');
  });
});

describe('hosted password policy', () => {
  it('lets the reserved admin log in at the official 6-character minimum', async () => {
    const { HOSTED_LOGIN_PASSWORD_MIN_LENGTH, HOSTED_NEW_PASSWORD_MIN_LENGTH } =
      await import('@/lib/auth/password-policy');
    expect(HOSTED_LOGIN_PASSWORD_MIN_LENGTH).toBe(6);
    expect(HOSTED_NEW_PASSWORD_MIN_LENGTH).toBe(12);
  });
});

describe('account kv namespace', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws in hosted mode before the account is ready', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const { clearAccountEnvironment, accountKvNamespace } =
      await import('@/lib/auth/account-environment');
    clearAccountEnvironment();
    expect(() => accountKvNamespace()).toThrow(/not ready/);
  });

  it('uses the signed-in namespace when AUTH_MODE is unset', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const { clearAccountEnvironment, setAccountUserId, accountKvNamespace } =
      await import('@/lib/auth/account-environment');
    clearAccountEnvironment();
    expect(accountKvNamespace()).toBe('maic');
    setAccountUserId('09ee0532-7110-4bd4-ae73-e95f4d5126b0');
    expect(accountKvNamespace()).toBe('zhiyu:openmaic:09ee0532-7110-4bd4-ae73-e95f4d5126b0');
    clearAccountEnvironment();
  });
});

describe('owner listing auth failures', () => {
  it('does not treat an empty owner library as persistence downtime', async () => {
    const { isOwnerListingAuthFailure } = await import('@/lib/utils/owner-listing-error');
    expect(isOwnerListingAuthFailure(new Error('Failed to list owner stages: HTTP 503'))).toBe(
      true,
    );
    expect(isOwnerListingAuthFailure(new Error('Failed to list owner stages: HTTP 401'))).toBe(
      true,
    );
    expect(isOwnerListingAuthFailure(new Error('Failed to list owner stages: HTTP 500'))).toBe(
      false,
    );
  });
});

describe('absent session registry SQLSTATEs', () => {
  it('treats a missing app_internal schema as an absent registry, not an outage', async () => {
    const { isAbsentSessionRegistryError } = await import('@/lib/auth/session');
    expect(isAbsentSessionRegistryError({ code: '3F000' })).toBe(true);
    expect(isAbsentSessionRegistryError({ code: '42883' })).toBe(true);
    expect(isAbsentSessionRegistryError({ code: '42P01' })).toBe(true);
    expect(isAbsentSessionRegistryError({ code: '42501' })).toBe(false);
    expect(isAbsentSessionRegistryError(new Error('connect ECONNREFUSED'))).toBe(false);
  });
});

describe('account owner isolation flag', () => {
  it('isolates user: owners and not anonymous owners', async () => {
    const { shouldIsolateOwner } = await import('@/lib/auth/principal');
    expect(shouldIsolateOwner('user:11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(shouldIsolateOwner('anon:11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(shouldIsolateOwner(undefined)).toBe(false);
  });
});

describe('unsigned shared library listing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shares the anon: pile only while AUTH_MODE is unset and the owner is not user:', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const { usesSharedAnonymousLibrary } =
      await import('@/lib/persistence/owner-bound-document-store');
    expect(usesSharedAnonymousLibrary('anon:11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(usesSharedAnonymousLibrary('user:11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('does not share the anon: pile when hosted auth is on', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const { usesSharedAnonymousLibrary } =
      await import('@/lib/persistence/owner-bound-document-store');
    expect(usesSharedAnonymousLibrary('anon:11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});

describe('request-bound owner SQL', () => {
  it('reads app.owner_id from a transaction-local setting', async () => {
    const { currentOwnerSettingSql } = await import('@/lib/db/request-queryable');
    expect(currentOwnerSettingSql()).toContain("current_setting('app.owner_id'");
  });

  it('sets app.owner_id on a short transaction for each query', async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        return { rows: [{ ok: true }] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    };
    const { createOwnerBoundQueryable } = await import('@/lib/db/request-queryable');
    const queryable = createOwnerBoundQueryable(
      pool as never,
      'user:11111111-1111-4111-8111-111111111111',
    );
    await queryable.query('SELECT 1 AS ok');
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('set_config');
    expect(sql[2]).toBe('SELECT 1 AS ok');
    expect(sql[3]).toBe('COMMIT');
  });

  it('builds hosted runtime and asset stores without wrapping the shared provider', async () => {
    const { createHostedOwnerBoundStores } = await import('@/lib/persistence/server-provider');
    const stores = createHostedOwnerBoundStores(
      {
        connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
      } as never,
      'user:11111111-1111-4111-8111-111111111111',
    );
    expect(stores.queryable).toBeDefined();
    expect(stores.runtimeStore).toBeDefined();
    expect(stores.assetStore).toBeDefined();
  });
});

describe('accounts RLS v2–v4', () => {
  it('drops open blob inserts, stops granting every public table to the worker, and adds worker RLS policies', async () => {
    const { ACCOUNTS_RLS_SQL_V2, ACCOUNTS_RLS_SQL_V3, ACCOUNTS_RLS_SQL_V4 } =
      await import('@/lib/server/accounts/sql-rls');
    const { ACCOUNT_MIGRATIONS } = await import('@/lib/server/accounts/migrations');
    expect(ACCOUNTS_RLS_SQL_V2).toContain('DROP POLICY IF EXISTS asset_blobs_web_insert');
    expect(ACCOUNTS_RLS_SQL_V2).toContain(
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_worker',
    );
    expect(ACCOUNTS_RLS_SQL_V2).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_worker/,
    );
    expect(ACCOUNTS_RLS_SQL_V3).toContain('rls_auto_enable');
    expect(ACCOUNTS_RLS_SQL_V4).toContain('FOR ALL TO app_worker USING (true)');
    expect(ACCOUNTS_RLS_SQL_V4).toContain('agent_sessions_web_all');
    expect(ACCOUNT_MIGRATIONS.map((item) => item.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
    const v8 = ACCOUNT_MIGRATIONS.find((item) => item.version === 8)?.sql ?? '';
    expect(v8).toContain('refusing hosted generation RLS apply on classroom database openmaic');
    expect(v8).toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(v8).not.toContain('REVOKE ALL ON TABLE public.app_accounts');
    const v9 = ACCOUNT_MIGRATIONS.find((item) => item.version === 9)?.sql ?? '';
    expect(v9).toContain(
      'refusing hosted generation real-shape apply on classroom database openmaic',
    );
    expect(v9).toContain(
      'refusing hosted generation real-shape apply because document_stages already has rows',
    );
    expect(v9).toContain('idempotency_key TEXT NOT NULL');
    expect(v9).toContain('generation_ownership_web_select');
    expect(v9).toContain(
      'stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE RESTRICT',
    );
    expect(v9).toContain('app_internal.bump_stage_revision');
    expect(v9).toContain('$m9_real_generation_jobs$');
    expect(v9).toContain('DROP POLICY IF EXISTS document_stages_web_insert');
    expect(v9).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE');
    expect(v9).toContain('generation_jobs_web_delete');
    expect(v9).not.toContain('REVOKE ALL ON TABLE public.app_accounts');
    const v10 = ACCOUNT_MIGRATIONS.find((item) => item.version === 10)?.sql ?? '';
    expect(v10).toContain('CREATE TABLE IF NOT EXISTS agent_sessions');
    expect(v10).toContain('CREATE TABLE IF NOT EXISTS pro_model_connections');
    expect(v10).toContain('agent_session_entries_web_all');
    expect(v10).toContain('agent_owner_session_events_web_all');
    expect(v10).toContain('pro_model_connection_revisions_web_all');
    expect(v10).toContain('app_profiles_web_insert');
    expect(v10).toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    const v12 = ACCOUNT_MIGRATIONS.find((item) => item.version === 12)?.sql ?? '';
    expect(v12).toContain('acquire_foreground_generation_root');
    expect(v12).toContain('release_heavy_task_foreground_lease');
    expect(v12).toContain('SECURITY DEFINER');
    const v13 = ACCOUNT_MIGRATIONS.find((item) => item.version === 13)?.sql ?? '';
    expect(v13).toContain('heavy_task_owner_active');
    expect(v13).toContain('account_inactive');
    expect(v13).toContain('SECURITY DEFINER');
    const { ACCOUNTS_RLS_SQL } = await import('@/lib/server/accounts/sql-rls');
    expect(ACCOUNTS_RLS_SQL).toContain("to_regclass('public.document_stages')");
  });
});

describe('classroom session registry SQL', () => {
  it('does not FORCE RLS and stays usable without auth catalogs', async () => {
    const { ACCOUNTS_MIGRATION_1, ACCOUNTS_MIGRATION_6 } =
      await import('@/lib/server/accounts/sql-accounts');
    const { ACCOUNT_MIGRATIONS, sqlContainsForceRowSecurity } =
      await import('@/lib/server/accounts/migrations');
    expect(sqlContainsForceRowSecurity(ACCOUNT_MIGRATIONS[0]!.sql)).toBe(true);
    expect(sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_1)).toBe(false);
    expect(sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_6)).toBe(false);
    expect(ACCOUNTS_MIGRATION_6).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(ACCOUNTS_MIGRATION_6).toContain("to_regclass('auth.sessions')");
    expect(ACCOUNTS_MIGRATION_6).toContain('app_internal.ensure_account');
    expect(ACCOUNTS_MIGRATION_6).toContain('CREATE TABLE IF NOT EXISTS app_accounts');
    expect(ACCOUNTS_MIGRATION_6).toContain('CREATE TABLE IF NOT EXISTS app_profiles');
  });

  it('wraps classroom apply SQL with generation-table guards', async () => {
    const { buildClassroomSessionRegistryApplySql, sqlContainsForceRowSecurity } =
      await import('@/lib/server/accounts/migrations');
    const sql = buildClassroomSessionRegistryApplySql();
    expect(sqlContainsForceRowSecurity(sql)).toBe(false);
    expect(sql).toContain('classroom_registry_guard');
    expect(sql).toContain('classroom registry apply flipped RLS');
    expect(sql).toContain('anon: document_stages row count');
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
  });

  it('upserts hosted role/status without forcing generation RLS', async () => {
    const { ACCOUNTS_MIGRATION_6, ACCOUNTS_MIGRATION_7 } =
      await import('@/lib/server/accounts/sql-accounts');
    const { sqlContainsForceRowSecurity, classroomSessionRegistryChecksum } =
      await import('@/lib/server/accounts/migrations');
    expect(sqlContainsForceRowSecurity(ACCOUNTS_MIGRATION_7)).toBe(false);
    expect(ACCOUNTS_MIGRATION_7).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(ACCOUNTS_MIGRATION_7).not.toMatch(/document_stages/i);
    expect(ACCOUNTS_MIGRATION_7).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(ACCOUNTS_MIGRATION_7).toContain("WHEN p_role = 'admin' THEN 'admin'");
    expect(ACCOUNTS_MIGRATION_6).toContain(
      "VALUES (p_user_id, 'user:' || p_user_id::text, 'user', 'active')",
    );
    expect(classroomSessionRegistryChecksum()).toBe(
      'c1750945c5c70c59e910429b72c0026bd134529e8074409b4a685a632247b747',
    );
  });
});

describe('hosted app_accounts self-select', () => {
  it('grants authenticated self-select via auth.uid and not generation FORCE RLS', async () => {
    const { HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL } = await import('@/lib/server/accounts/sql-rls');
    const { sqlContainsForceRowSecurity } = await import('@/lib/server/accounts/migrations');
    expect(sqlContainsForceRowSecurity(HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL)).toBe(false);
    expect(HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL).not.toMatch(/document_stages/i);
    expect(HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL).toContain('TO authenticated');
    expect(HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL).toContain('auth.uid()');
    expect(HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL).not.toMatch(/GRANT UPDATE/i);
  });
});

describe('hosted role sync', () => {
  it('copies hosted admin onto classroom user and ignores nickname metadata', async () => {
    const { resolveAccountAccess } = await import('@/lib/auth/session');
    expect(
      resolveAccountAccess({
        hosted: { role: 'admin', status: 'active' },
        classroom: { role: 'user', status: 'active' },
      }).role,
    ).toBe('admin');
    expect(
      resolveAccountAccess({
        hosted: { role: 'user', status: 'active' },
        classroom: { role: 'admin', status: 'active' },
      }).role,
    ).toBe('user');
    expect(
      resolveAccountAccess({
        classroom: { role: 'admin', status: 'active' },
      }).role,
    ).toBe('admin');
    expect(
      resolveAccountAccess({
        hosted: { role: 'admin-from-nickname', status: 'active' },
        classroom: { role: 'user', status: 'active' },
      }).role,
    ).toBe('user');
  });
});
