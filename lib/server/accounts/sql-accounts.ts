/**
 * Account / RLS SQL. Applied after existing document, runtime, asset, and
 * generation schema migrations. Statement splitting respects dollar quotes
 * so function bodies are not broken.
 */
export const ACCOUNTS_SCHEMA_VERSION = 19;

export const CLASSROOM_SESSION_REGISTRY_VERSION = 6;

/** Additive classroom patch: copy hosted role/status into ensure_account. */
export const CLASSROOM_SESSION_REGISTRY_ROLE_SYNC_VERSION = 7;

export const ACCOUNTS_MIGRATION_1 = `
CREATE SCHEMA IF NOT EXISTS app_internal;
REVOKE ALL ON SCHEMA app_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_internal TO PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_web, app_worker;

CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT nullif(current_setting('app.owner_id', true), '')
$fn$;
REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;

CREATE OR REPLACE FUNCTION app_internal.session_is_active(p_user_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = p_session_id
      AND s.user_id = p_user_id
  )
  AND EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = p_user_id
  )
$fn$;
REVOKE ALL ON FUNCTION app_internal.session_is_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.session_is_active(uuid, uuid) TO app_web;

CREATE TABLE IF NOT EXISTS app_accounts (
  user_id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleting')),
  session_valid_after timestamptz NOT NULL DEFAULT to_timestamp(0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT app_accounts_owner_matches_user
    CHECK (owner_id = ('user:' || user_id::text))
);

CREATE TABLE IF NOT EXISTS app_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_accounts(user_id) ON DELETE CASCADE,
  display_name text,
  avatar_key text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS account_kv (
  owner_id text NOT NULL REFERENCES app_accounts(owner_id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS classroom_snapshots (
  classroom_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES app_accounts(owner_id),
  stage_id text,
  storage_ref text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS render_job_owners (
  job_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES app_accounts(owner_id),
  stage_id text,
  status text,
  output_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL,
  source text NOT NULL,
  kind text NOT NULL,
  job_id text,
  session_id text,
  request_id text,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  quantity numeric,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS usage_events_owner_time_idx ON usage_events (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid,
  target_internal_id text,
  action text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION app_internal.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO public.app_accounts (user_id, owner_id, role, status)
  VALUES (NEW.id, 'user:' || NEW.id::text, 'user', 'active')
  ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.app_profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(COALESCE(NEW.email, 'user'), '@', 1))
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_internal.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
    ALTER TABLE public.app_accounts
      DROP CONSTRAINT IF EXISTS app_accounts_user_id_fkey;
    ALTER TABLE public.app_accounts
      ADD CONSTRAINT app_accounts_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION app_internal.handle_new_auth_user();
  END IF;
END
$$;
`;

/**
 * Operator lifecycle snapshot. Authenticated reserved admin can read their
 * own session ids and owned-row counts. Never returns tokens or passwords.
 */
export const ACCOUNTS_MIGRATION_5 = `
CREATE OR REPLACE FUNCTION app_internal.count_if_public_table(p_table text, p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RETURN to_jsonb('unavailable'::text);
  END IF;
  EXECUTE p_sql INTO n;
  RETURN to_jsonb(n);
END
$fn$;
REVOKE ALL ON FUNCTION app_internal.count_if_public_table(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserved_admin_lifecycle_snapshot(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $fn$
DECLARE
  caller uuid := auth.uid();
  target uuid;
  owner text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_email IS NULL OR length(btrim(p_email)) = 0 THEN
    RAISE EXCEPTION 'email required';
  END IF;
  SELECT u.id INTO target
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
    AND u.id = caller;
  IF target IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.app_accounts a
    WHERE a.user_id = target AND a.role = 'admin' AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  owner := 'user:' || target::text;
  RETURN jsonb_build_object(
    'email', btrim(p_email),
    'userId', target,
    'ownerId', owner,
    'emailConfirmed', (SELECT u.email_confirmed_at IS NOT NULL FROM auth.users u WHERE u.id = target),
    'role', (SELECT a.role FROM public.app_accounts a WHERE a.user_id = target),
    'status', (SELECT a.status FROM public.app_accounts a WHERE a.user_id = target),
    'sessions', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'createdAt', s.created_at,
        'updatedAt', s.updated_at
      ) ORDER BY s.created_at), '[]'::jsonb)
      FROM auth.sessions s
      WHERE s.user_id = target
    ),
    'owned', jsonb_build_object(
      'document_stages', app_internal.count_if_public_table('document_stages', format('SELECT count(*) FROM public.document_stages WHERE owner_id = %L', owner)),
      'generation_jobs', app_internal.count_if_public_table('generation_jobs', format('SELECT count(*) FROM public.generation_jobs WHERE owner_id = %L', owner)),
      'runtime_sessions', app_internal.count_if_public_table('runtime_sessions', format('SELECT count(*) FROM public.runtime_sessions WHERE learner_key = %L', owner)),
      'asset_entries', app_internal.count_if_public_table('asset_entries', format('SELECT count(*) FROM public.asset_entries WHERE principal = %L', owner)),
      'classroom_snapshots', app_internal.count_if_public_table('classroom_snapshots', format('SELECT count(*) FROM public.classroom_snapshots WHERE owner_id = %L', owner)),
      'render_job_owners', app_internal.count_if_public_table('render_job_owners', format('SELECT count(*) FROM public.render_job_owners WHERE owner_id = %L', owner)),
      'account_kv', app_internal.count_if_public_table('account_kv', format('SELECT count(*) FROM public.account_kv WHERE owner_id = %L', owner)),
      'usage_events', app_internal.count_if_public_table('usage_events', format('SELECT count(*) FROM public.usage_events WHERE owner_id = %L', owner)),
      'app_accounts', app_internal.count_if_public_table('app_accounts', format('SELECT count(*) FROM public.app_accounts WHERE owner_id = %L', owner)),
      'app_profiles', app_internal.count_if_public_table('app_profiles', format('SELECT count(*) FROM public.app_profiles WHERE user_id = %L', target)),
      'admin_audit_events', app_internal.count_if_public_table('admin_audit_events', format('SELECT count(*) FROM public.admin_audit_events WHERE actor_user_id = %L', target))
    )
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.reserved_admin_lifecycle_snapshot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserved_admin_lifecycle_snapshot(text) TO authenticated;
`;

/**
 * Dual-mode classroom Postgres registry. Creates `app_internal`,
 * `app_accounts`, and `app_profiles` so `/api/auth/me` can resolve a session
 * without Auth catalogs. Does **not** ENABLE/FORCE RLS on generation tables.
 *
 * Safe on hosted too: CREATE IF NOT EXISTS / OR REPLACE only. `session_is_active`
 * still consults `auth.sessions` when that catalog exists.
 */
export const ACCOUNTS_MIGRATION_6 = `
CREATE SCHEMA IF NOT EXISTS app_internal;

DO $revoke_schema$
BEGIN
  REVOKE ALL ON SCHEMA app_internal FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA app_internal FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA app_internal FROM authenticated;
  END IF;
END
$revoke_schema$;
GRANT USAGE ON SCHEMA app_internal TO PUBLIC;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

GRANT USAGE ON SCHEMA public TO app_web, app_worker;

CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT nullif(current_setting('app.owner_id', true), '')
$fn$;
DO $revoke_owner$
BEGIN
  REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM authenticated;
  END IF;
END
$revoke_owner$;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;

CREATE OR REPLACE FUNCTION app_internal.session_is_active(p_user_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF to_regclass('auth.sessions') IS NULL OR to_regclass('auth.users') IS NULL THEN
    RETURN p_user_id IS NOT NULL AND p_session_id IS NOT NULL;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = p_session_id
      AND s.user_id = p_user_id
  )
  AND EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = p_user_id
  );
END
$fn$;
DO $revoke_session$
BEGIN
  REVOKE ALL ON FUNCTION app_internal.session_is_active(uuid, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_internal.session_is_active(uuid, uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_internal.session_is_active(uuid, uuid) FROM authenticated;
  END IF;
END
$revoke_session$;
GRANT EXECUTE ON FUNCTION app_internal.session_is_active(uuid, uuid) TO app_web;

CREATE TABLE IF NOT EXISTS app_accounts (
  user_id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleting')),
  session_valid_after timestamptz NOT NULL DEFAULT to_timestamp(0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT app_accounts_owner_matches_user
    CHECK (owner_id = ('user:' || user_id::text))
);

CREATE TABLE IF NOT EXISTS app_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_accounts(user_id) ON DELETE CASCADE,
  display_name text,
  avatar_key text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION app_internal.ensure_account(p_user_id uuid, p_display_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  has_confirmed_at boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id required';
  END IF;
  IF to_regclass('auth.users') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'auth'
        AND c.table_name = 'users'
        AND c.column_name = 'email_confirmed_at'
    ) INTO has_confirmed_at;
    IF has_confirmed_at THEN
      IF NOT EXISTS (
        SELECT 1
        FROM auth.users u
        WHERE u.id = p_user_id
          AND u.email_confirmed_at IS NOT NULL
      ) THEN
        RETURN;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
      RETURN;
    END IF;
  END IF;
  INSERT INTO public.app_accounts (user_id, owner_id, role, status)
  VALUES (p_user_id, 'user:' || p_user_id::text, 'user', 'active')
  ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.app_profiles (user_id, display_name)
  VALUES (
    p_user_id,
    COALESCE(NULLIF(btrim(p_display_name), ''), 'user')
  )
  ON CONFLICT (user_id) DO NOTHING;
END
$fn$;
DO $revoke_ensure$
BEGIN
  REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text) FROM authenticated;
  END IF;
END
$revoke_ensure$;
GRANT EXECUTE ON FUNCTION app_internal.ensure_account(uuid, text) TO app_web;

GRANT SELECT, INSERT, UPDATE ON TABLE app_accounts, app_profiles TO app_web;
`;

/**
 * Classroom registry v7. Replaces ensure_account so a later upsert can copy
 * hosted app_accounts.role/status. Does not ENABLE/FORCE RLS. Display name is
 * never used as a role.
 */
export const ACCOUNTS_MIGRATION_7 = `
DROP FUNCTION IF EXISTS app_internal.ensure_account(uuid, text);

CREATE OR REPLACE FUNCTION app_internal.ensure_account(
  p_user_id uuid,
  p_display_name text,
  p_role text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  has_confirmed_at boolean := false;
  v_role text;
  v_status text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id required';
  END IF;
  IF to_regclass('auth.users') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'auth'
        AND c.table_name = 'users'
        AND c.column_name = 'email_confirmed_at'
    ) INTO has_confirmed_at;
    IF has_confirmed_at THEN
      IF NOT EXISTS (
        SELECT 1
        FROM auth.users u
        WHERE u.id = p_user_id
          AND u.email_confirmed_at IS NOT NULL
      ) THEN
        RETURN;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
      RETURN;
    END IF;
  END IF;
  v_role := CASE
    WHEN p_role IS NULL THEN NULL
    WHEN p_role = 'admin' THEN 'admin'
    ELSE 'user'
  END;
  v_status := CASE
    WHEN p_status IS NULL THEN NULL
    WHEN p_status IN ('active', 'disabled', 'deleting') THEN p_status
    ELSE 'active'
  END;
  INSERT INTO public.app_accounts (user_id, owner_id, role, status)
  VALUES (
    p_user_id,
    'user:' || p_user_id::text,
    COALESCE(v_role, 'user'),
    COALESCE(v_status, 'active')
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    role = COALESCE(v_role, public.app_accounts.role),
    status = COALESCE(v_status, public.app_accounts.status),
    updated_at = clock_timestamp();
  INSERT INTO public.app_profiles (user_id, display_name)
  VALUES (
    p_user_id,
    COALESCE(NULLIF(btrim(p_display_name), ''), 'user')
  )
  ON CONFLICT (user_id) DO NOTHING;
END
$fn$;
DO $revoke_ensure$
BEGIN
  REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text, text, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text, text, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_internal.ensure_account(uuid, text, text, text) FROM authenticated;
  END IF;
END
$revoke_ensure$;
GRANT EXECUTE ON FUNCTION app_internal.ensure_account(uuid, text, text, text) TO app_web;
`;

/**
 * Hosted-only generation/document skeleton so existing app_web owner policies
 * have tables to attach to. Empty of course rows. Refuses classroom `openmaic`
 * and any `document_stages` that already has rows. Does not touch auth.users
 * or app_accounts rows.
 */
export const ACCOUNTS_MIGRATION_8 = `
DO $hosted_generation_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation RLS apply on classroom database openmaic';
  END IF;
  IF to_regclass('public.document_stages') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.document_stages) > 0 THEN
      RAISE EXCEPTION 'refusing hosted generation RLS skeleton because document_stages already has rows';
    END IF;
  END IF;
END
$hosted_generation_guard$;

CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  folder_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  owner_id TEXT,
  folder_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id TEXT PRIMARY KEY,
  rev BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (stage_id, scene_id)
);

CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  published_at DOUBLE PRECISION,
  generation_complete BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL DEFAULT 0,
  scene_id TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS asset_blobs (
  content_hash TEXT PRIMARY KEY,
  byte_size BIGINT NOT NULL DEFAULT 0,
  bytes BYTEA,
  unreferenced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS asset_entries (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  content_hash TEXT,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL DEFAULT 0,
  original_name TEXT,
  oss_key TEXT NOT NULL DEFAULT '',
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  deleted_at DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  stage_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_ownership (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_scenes (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_job_assets (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_events (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_commands (
  id TEXT PRIMARY KEY,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_provider_slots (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS generation_worker_heartbeats (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS generation_schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL DEFAULT '',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS media_config_snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_model_snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT
);

CREATE TABLE IF NOT EXISTS generation_search_snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS document_stages_owner_idx
  ON document_stages (owner_id, id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);
CREATE INDEX IF NOT EXISTS generation_jobs_owner_idx ON generation_jobs (owner_id, id);
`;

/**
 * Hosted-only. Replaces empty v8 generation stubs with the real job/ownership
 * shapes (applied via ACCOUNT_MIGRATIONS v9 together with generation DDL).
 * Does not DROP document_stages. Refuses classroom `openmaic` and any
 * non-empty hosted course/job rows.
 */
export const ACCOUNTS_MIGRATION_9 = `
DO $hosted_real_shape_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation real-shape apply on classroom database openmaic';
  END IF;
  IF to_regclass('public.document_stages') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.document_stages) > 0 THEN
      RAISE EXCEPTION 'refusing hosted generation real-shape apply because document_stages already has rows';
    END IF;
  END IF;
  IF to_regclass('public.generation_jobs') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.generation_jobs) > 0 THEN
      RAISE EXCEPTION 'refusing hosted generation real-shape apply because generation_jobs already has rows';
    END IF;
  END IF;
  IF to_regclass('public.generation_ownership') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.generation_ownership) > 0 THEN
      RAISE EXCEPTION 'refusing hosted generation real-shape apply because generation_ownership already has rows';
    END IF;
  END IF;
END
$hosted_real_shape_guard$;

DO $hosted_drop_generation_stubs$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation real-shape apply on classroom database openmaic';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'generation_jobs'
       AND column_name = 'idempotency_key'
  ) AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'generation_ownership'
       AND column_name = 'stage_id'
  ) THEN
    RETURN;
  END IF;
  DROP TABLE IF EXISTS public.generation_attempts CASCADE;
  DROP TABLE IF EXISTS public.generation_job_assets CASCADE;
  DROP TABLE IF EXISTS public.generation_events CASCADE;
  DROP TABLE IF EXISTS public.generation_commands CASCADE;
  DROP TABLE IF EXISTS public.generation_scenes CASCADE;
  DROP TABLE IF EXISTS public.generation_steps CASCADE;
  DROP TABLE IF EXISTS public.generation_jobs CASCADE;
  DROP TABLE IF EXISTS public.generation_ownership CASCADE;
  DROP TABLE IF EXISTS public.generation_provider_slots CASCADE;
  DROP TABLE IF EXISTS public.generation_worker_heartbeats CASCADE;
  DROP TABLE IF EXISTS public.media_config_snapshots CASCADE;
  DROP TABLE IF EXISTS public.generation_model_snapshots CASCADE;
  DROP TABLE IF EXISTS public.generation_search_snapshots CASCADE;
END
$hosted_drop_generation_stubs$;

DO $hosted_folders_unique$
BEGIN
  IF to_regclass('public.document_folders') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.document_folders'::regclass
       AND conname = 'document_folders_owner_id_normalized_name_key'
  ) THEN
    ALTER TABLE public.document_folders
      ADD CONSTRAINT document_folders_owner_id_normalized_name_key UNIQUE (owner_id, normalized_name);
  END IF;
END
$hosted_folders_unique$;

CREATE INDEX IF NOT EXISTS document_folders_owner_order_idx
  ON document_folders (owner_id, folder_order, id);
CREATE INDEX IF NOT EXISTS document_stages_owner_folder_idx
  ON document_stages (owner_id, folder_id, id)
  WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);
CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);
CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
CREATE INDEX IF NOT EXISTS asset_entries_principal_idx
  ON asset_entries (principal, id);
CREATE INDEX IF NOT EXISTS asset_entries_content_hash_idx
  ON asset_entries (content_hash);
CREATE INDEX IF NOT EXISTS asset_blobs_unreferenced_idx
  ON asset_blobs (unreferenced_at) WHERE unreferenced_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);

DO $hosted_runtime_seq$
BEGIN
  IF to_regclass('public.runtime_records') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.runtime_records'::regclass
       AND conname = 'runtime_records_session_seq_unique'
  ) THEN
    ALTER TABLE public.runtime_records
      ADD CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq);
  END IF;
END
$hosted_runtime_seq$;

DO $hosted_asset_entries_fk$
BEGIN
  IF to_regclass('public.asset_entries') IS NULL OR to_regclass('public.asset_blobs') IS NULL THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.asset_entries) <> 0 THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_entries'
       AND column_name = 'content_hash'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.asset_entries ALTER COLUMN content_hash SET NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.asset_entries'::regclass
       AND contype = 'f'
       AND conname = 'asset_entries_content_hash_fkey'
  ) THEN
    ALTER TABLE public.asset_entries
      ADD CONSTRAINT asset_entries_content_hash_fkey
      FOREIGN KEY (content_hash) REFERENCES public.asset_blobs(content_hash);
  END IF;
END
$hosted_asset_entries_fk$;

CREATE OR REPLACE FUNCTION app_internal.bump_scene_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $bump_scene$
DECLARE
  v_stage_id text;
  v_scene_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.stage_id;
    v_scene_id := OLD.id;
  ELSE
    v_stage_id := NEW.stage_id;
    v_scene_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  INSERT INTO document_scene_revision (stage_id, scene_id, rev)
  VALUES (v_stage_id, v_scene_id, 1)
  ON CONFLICT (stage_id, scene_id) DO UPDATE SET rev = document_scene_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$bump_scene$;

CREATE OR REPLACE FUNCTION app_internal.bump_stage_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $bump_stage$
DECLARE
  v_stage_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.id;
  ELSE
    v_stage_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$bump_stage$;

DO $hosted_rev_fn_revoke$
BEGIN
  REVOKE ALL ON FUNCTION app_internal.bump_scene_revision() FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_internal.bump_stage_revision() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_internal.bump_scene_revision() FROM anon;
    REVOKE ALL ON FUNCTION app_internal.bump_stage_revision() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_internal.bump_scene_revision() FROM authenticated;
    REVOKE ALL ON FUNCTION app_internal.bump_stage_revision() FROM authenticated;
  END IF;
END
$hosted_rev_fn_revoke$;
GRANT EXECUTE ON FUNCTION app_internal.bump_scene_revision() TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.bump_stage_revision() TO app_web, app_worker;

DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes;
CREATE TRIGGER openmaic_scene_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_scenes
FOR EACH ROW EXECUTE FUNCTION app_internal.bump_scene_revision();

DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages;
CREATE TRIGGER openmaic_stage_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_stages
FOR EACH ROW EXECUTE FUNCTION app_internal.bump_stage_revision();

DROP FUNCTION IF EXISTS public.openmaic_bump_scene_revision();
DROP FUNCTION IF EXISTS public.openmaic_bump_stage_revision();
`;

/**
 * Hosted storage/capacity lifecycle schema. This is deliberately additive:
 * existing account and course tables keep their ids and rows while durable
 * object mappings, usage fidelity and resumable account deletion are added.
 */
export const ACCOUNTS_MIGRATION_11 = `
CREATE TABLE IF NOT EXISTS classroom_media_objects (
  owner_id text NOT NULL REFERENCES app_accounts(owner_id),
  classroom_id text NOT NULL,
  legacy_path text NOT NULL,
  asset_id text NOT NULL REFERENCES asset_entries(id) ON DELETE RESTRICT,
  mime text,
  byte_size bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, classroom_id, legacy_path)
);
CREATE INDEX IF NOT EXISTS classroom_media_objects_asset_idx
  ON classroom_media_objects (asset_id);
CREATE INDEX IF NOT EXISTS classroom_media_objects_classroom_idx
  ON classroom_media_objects (owner_id, classroom_id);

CREATE TABLE IF NOT EXISTS classroom_generation_jobs (
  job_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES app_accounts(owner_id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS classroom_generation_jobs_owner_idx
  ON classroom_generation_jobs (owner_id, updated_at DESC);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS model_string text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_read_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_creation_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS unit text;
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_owner_event_key_unique
  ON usage_events (owner_id, event_key) WHERE event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  user_id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'blocked', 'complete')),
  phase text NOT NULL DEFAULT 'requested',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS account_deletion_objects (
  user_id uuid NOT NULL REFERENCES account_deletion_jobs(user_id) ON DELETE CASCADE,
  bucket_id text NOT NULL,
  object_key text NOT NULL,
  content_hash text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retained_shared', 'deleted', 'retry')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, bucket_id, object_key)
);
CREATE INDEX IF NOT EXISTS account_deletion_objects_status_idx
  ON account_deletion_objects (user_id, status);

CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
  user_id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE,
  reason text NOT NULL DEFAULT 'account_deleted',
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS storage_migration_runs (
  run_id uuid PRIMARY KEY,
  source_fingerprint text NOT NULL,
  target_project_ref text NOT NULL,
  admin_owner_id text NOT NULL,
  status text NOT NULL DEFAULT 'dry_run'
    CHECK (status IN ('dry_run','copying','verifying','complete','failed')),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS storage_migration_objects (
  run_id uuid NOT NULL REFERENCES storage_migration_runs(run_id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_key text NOT NULL,
  target_bucket text NOT NULL,
  target_key text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','copied','verified','failed')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, source_kind, source_key)
);
CREATE INDEX IF NOT EXISTS storage_migration_objects_status_idx
  ON storage_migration_objects (run_id, status);

CREATE OR REPLACE FUNCTION app_internal.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.deleted_account_tombstones t WHERE t.user_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.app_accounts (user_id, owner_id, role, status)
  VALUES (NEW.id, 'user:' || NEW.id::text, 'user', 'active')
  ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.app_profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(COALESCE(NEW.email, 'user'), '@', 1))
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_internal.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
`;
