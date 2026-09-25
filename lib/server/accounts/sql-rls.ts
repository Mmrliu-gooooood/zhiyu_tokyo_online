/** DDL that must not fail when document/generation tables are not created yet. */
function ifPublicTable(table: string, sql: string): string {
  const statements = sql
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const executes = statements
    .map((statement, index) => {
      const tag = `$t${table.replace(/_/g, '')}${index}$`;
      return `  EXECUTE ${tag}${statement}${tag};`;
    })
    .join('\n');
  return `
DO $ensure_${table}$
BEGIN
  IF to_regclass('public.${table}') IS NULL THEN
    RETURN;
  END IF;
${executes}
END
$ensure_${table}$;
`;
}

const ACCOUNTS_RLS_SQL_HEAD = `
CREATE OR REPLACE FUNCTION app_internal.owner_matches()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT app_internal.current_owner_id()
$fn$;

DO $anon$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'document_folders',
    'document_stages',
    'document_scenes',
    'document_outlines',
    'document_stage_revision',
    'document_scene_revision',
    'stage_meta',
    'runtime_sessions',
    'runtime_records',
    'asset_entries',
    'asset_blobs',
    'owner_material',
    'agent_sessions',
    'agent_session_events',
    'agent_session_entries',
    'agent_owner_session_event_counters',
    'agent_owner_session_events',
    'agent_session_urls',
    'agent_user_skill',
    'agent_session_materials',
    'pro_model_connections',
    'pro_model_connection_revisions',
    'generation_jobs',
    'generation_ownership',
    'generation_scenes',
    'generation_steps',
    'generation_attempts',
    'generation_job_assets',
    'generation_events',
    'generation_commands',
    'generation_provider_slots',
    'generation_worker_heartbeats',
    'generation_schema_migrations',
    'media_config_snapshots',
    'generation_model_snapshots',
    'generation_search_snapshots',
    'app_accounts',
    'app_profiles',
    'account_kv',
    'classroom_snapshots',
    'render_job_owners',
    'usage_events',
    'admin_audit_events'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    END IF;
  END LOOP;
END
$anon$;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_accounts') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      app_accounts, app_profiles, account_kv, classroom_snapshots,
      render_job_owners, usage_events
    TO app_web;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='document_stages') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      document_folders, document_stages, document_scenes, document_outlines,
      document_stage_revision, document_scene_revision, stage_meta,
      runtime_sessions, runtime_records, asset_entries, owner_material,
      app_accounts, app_profiles, account_kv, classroom_snapshots,
      render_job_owners, usage_events
    TO app_web;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='generation_jobs') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE
      generation_jobs, generation_ownership, generation_scenes, generation_steps,
      generation_attempts, generation_job_assets, generation_events, generation_commands,
      media_config_snapshots, generation_model_snapshots, generation_search_snapshots
    TO app_web;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_sessions') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      agent_sessions, agent_session_events, agent_session_entries,
      agent_owner_session_event_counters, agent_owner_session_events,
      agent_session_urls, agent_user_skill, agent_session_materials
    TO app_web;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pro_model_connections') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      pro_model_connections, pro_model_connection_revisions
    TO app_web;
  END IF;
END
$grant$;

DROP POLICY IF EXISTS app_accounts_web_select ON app_accounts;
CREATE POLICY app_accounts_web_select ON app_accounts
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS app_profiles_web_all ON app_profiles;
CREATE POLICY app_profiles_web_select ON app_profiles
  FOR SELECT TO app_web
  USING (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id AND a.owner_id = app_internal.current_owner_id()
  ));
CREATE POLICY app_profiles_web_update ON app_profiles
  FOR UPDATE TO app_web
  USING (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id AND a.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id AND a.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS account_kv_web_all ON account_kv;
CREATE POLICY account_kv_web_all ON account_kv
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

`;

export const ACCOUNTS_RLS_SQL = `${ACCOUNTS_RLS_SQL_HEAD.trimEnd()}
${ifPublicTable(
  'document_stages',
  `
DROP POLICY IF EXISTS document_stages_web_select ON document_stages;
CREATE POLICY document_stages_web_select ON document_stages
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_insert ON document_stages
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_update ON document_stages
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_delete ON document_stages
  FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'document_folders',
  `
DROP POLICY IF EXISTS document_folders_web_all ON document_folders;
CREATE POLICY document_folders_web_all ON document_folders
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'stage_meta',
  `
DROP POLICY IF EXISTS stage_meta_web_all ON stage_meta;
CREATE POLICY stage_meta_web_all ON stage_meta
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'document_scenes',
  `
DROP POLICY IF EXISTS document_scenes_web_all ON document_scenes;
CREATE POLICY document_scenes_web_all ON document_scenes
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scenes.stage_id AND s.owner_id = app_internal.current_owner_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scenes.stage_id AND s.owner_id = app_internal.current_owner_id()))
`,
)}
${ifPublicTable(
  'document_outlines',
  `
DROP POLICY IF EXISTS document_outlines_web_all ON document_outlines;
CREATE POLICY document_outlines_web_all ON document_outlines
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_outlines.stage_id AND s.owner_id = app_internal.current_owner_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_outlines.stage_id AND s.owner_id = app_internal.current_owner_id()))
`,
)}
${ifPublicTable(
  'runtime_sessions',
  `
DROP POLICY IF EXISTS runtime_sessions_web_all ON runtime_sessions;
CREATE POLICY runtime_sessions_web_all ON runtime_sessions
  FOR ALL TO app_web
  USING (learner_key = app_internal.current_owner_id())
  WITH CHECK (
    learner_key = app_internal.current_owner_id()
    AND (
      stage_id IS NULL
      OR EXISTS (
        SELECT 1 FROM document_stages s
        WHERE s.id = runtime_sessions.stage_id AND s.owner_id = app_internal.current_owner_id()
      )
    )
  )
`,
)}
${ifPublicTable(
  'runtime_records',
  `
DROP POLICY IF EXISTS runtime_records_web_all ON runtime_records;
CREATE POLICY runtime_records_web_all ON runtime_records
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM runtime_sessions s
    WHERE s.id = runtime_records.session_id AND s.learner_key = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM runtime_sessions s
    WHERE s.id = runtime_records.session_id AND s.learner_key = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'asset_entries',
  `
DROP POLICY IF EXISTS asset_entries_web_all ON asset_entries;
CREATE POLICY asset_entries_web_all ON asset_entries
  FOR ALL TO app_web
  USING (principal = app_internal.current_owner_id())
  WITH CHECK (principal = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'asset_blobs',
  `
DROP POLICY IF EXISTS asset_blobs_web_insert ON asset_blobs;
CREATE POLICY asset_blobs_web_insert ON asset_blobs
  FOR INSERT TO app_web
  WITH CHECK (true);
CREATE POLICY asset_blobs_web_select ON asset_blobs
  FOR SELECT TO app_web
  USING (EXISTS (
    SELECT 1 FROM asset_entries e
    WHERE e.content_hash = asset_blobs.content_hash
      AND e.principal = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'owner_material',
  `
DROP POLICY IF EXISTS owner_material_web_all ON owner_material;
CREATE POLICY owner_material_web_all ON owner_material
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'generation_jobs',
  `
DROP POLICY IF EXISTS generation_jobs_web_all ON generation_jobs;
CREATE POLICY generation_jobs_web_select ON generation_jobs
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_jobs_web_insert ON generation_jobs
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_jobs_web_update ON generation_jobs
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_jobs_web_delete ON generation_jobs;
CREATE POLICY generation_jobs_web_delete ON generation_jobs
  FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_jobs_worker_all ON generation_jobs;
CREATE POLICY generation_jobs_worker_all ON generation_jobs
  FOR ALL TO app_worker USING (true) WITH CHECK (true)
`,
)}
DROP POLICY IF EXISTS classroom_snapshots_web_all ON classroom_snapshots;
CREATE POLICY classroom_snapshots_web_all ON classroom_snapshots
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS usage_events_web_select ON usage_events;
CREATE POLICY usage_events_web_select ON usage_events
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY usage_events_web_insert ON usage_events
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_worker;
`;

/** Tightens v1: no open blob inserts for app_web; worker DML is listed, not ALL TABLES. */
export const ACCOUNTS_RLS_SQL_V2 = `
${ifPublicTable('asset_blobs', 'DROP POLICY IF EXISTS asset_blobs_web_insert ON asset_blobs')}

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_worker;

DO $worker_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_accounts') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      app_accounts, app_profiles, account_kv, classroom_snapshots,
      render_job_owners, usage_events, admin_audit_events
    TO app_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='document_stages') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      document_folders, document_stages, document_scenes, document_outlines,
      document_stage_revision, document_scene_revision, stage_meta,
      runtime_sessions, runtime_records, asset_entries, asset_blobs, owner_material,
      app_accounts, app_profiles, account_kv, classroom_snapshots,
      render_job_owners, usage_events, admin_audit_events
    TO app_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='generation_jobs') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      generation_jobs, generation_ownership, generation_scenes, generation_steps,
      generation_attempts, generation_job_assets, generation_events, generation_commands,
      generation_provider_slots, generation_worker_heartbeats, generation_schema_migrations,
      media_config_snapshots, generation_model_snapshots, generation_search_snapshots
    TO app_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_sessions') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      agent_sessions, agent_session_events, agent_session_entries,
      agent_owner_session_event_counters, agent_owner_session_events,
      agent_session_urls, agent_user_skill, agent_session_materials
    TO app_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pro_model_connections') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      pro_model_connections, pro_model_connection_revisions
    TO app_worker;
  END IF;
END
$worker_grant$;
`;

/**
 * Hosted-project hygiene. `public.rls_auto_enable()` is a Supabase default
 * SECURITY DEFINER RPC that advisors flag as callable by anon/authenticated.
 * Local Docker Postgres will not have the function; the DO block is a no-op.
 */
export const ACCOUNTS_RLS_SQL_V3 = `
DO $rls_auto$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rls_auto_enable'
      AND pg_get_function_identity_arguments(p.oid) = ''
  ) THEN
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END
$rls_auto$;
`;

/**
 * FORCE RLS + NOBYPASSRLS means GRANT alone cannot let the worker claim jobs
 * or write frozen-owner rows. v1 only opened `generation_jobs` for app_worker.
 * Hosted Pro stores use WORKER_DATABASE_URL, so these policies are required.
 * Web owner policies from v1 are unchanged.
 */
export const ACCOUNTS_RLS_SQL_V4 = `
DO $worker_rls$
DECLARE
  tbl text;
  policy_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'document_folders',
    'document_stages',
    'document_scenes',
    'document_outlines',
    'document_stage_revision',
    'document_scene_revision',
    'stage_meta',
    'runtime_sessions',
    'runtime_records',
    'asset_entries',
    'asset_blobs',
    'owner_material',
    'agent_sessions',
    'agent_session_events',
    'agent_session_entries',
    'agent_owner_session_event_counters',
    'agent_owner_session_events',
    'agent_session_urls',
    'agent_user_skill',
    'agent_session_materials',
    'pro_model_connections',
    'pro_model_connection_revisions',
    'generation_jobs',
    'generation_ownership',
    'generation_scenes',
    'generation_steps',
    'generation_attempts',
    'generation_job_assets',
    'generation_events',
    'generation_commands',
    'generation_provider_slots',
    'generation_worker_heartbeats',
    'generation_schema_migrations',
    'media_config_snapshots',
    'generation_model_snapshots',
    'generation_search_snapshots',
    'app_accounts',
    'app_profiles',
    'account_kv',
    'classroom_snapshots',
    'render_job_owners',
    'usage_events',
    'admin_audit_events'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      policy_name := tbl || '_worker_all';
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO app_worker USING (true) WITH CHECK (true)',
        policy_name,
        tbl
      );
    END IF;
  END LOOP;
END
$worker_rls$;

${ifPublicTable(
  'agent_sessions',
  `
DROP POLICY IF EXISTS agent_sessions_web_all ON agent_sessions;
CREATE POLICY agent_sessions_web_all ON agent_sessions
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'agent_session_events',
  `
DROP POLICY IF EXISTS agent_session_events_web_all ON agent_session_events;
CREATE POLICY agent_session_events_web_all ON agent_session_events
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_events.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_events.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'agent_user_skill',
  `
DROP POLICY IF EXISTS agent_user_skill_web_all ON agent_user_skill;
CREATE POLICY agent_user_skill_web_all ON agent_user_skill
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'agent_session_materials',
  `
DROP POLICY IF EXISTS agent_session_materials_web_all ON agent_session_materials;
CREATE POLICY agent_session_materials_web_all ON agent_session_materials
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_materials.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_materials.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'pro_model_connections',
  `
DROP POLICY IF EXISTS pro_model_connections_web_all ON pro_model_connections;
CREATE POLICY pro_model_connections_web_all ON pro_model_connections
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
`;

/**
 * Hosted Agent/Pro tables are created by accounts migration v10, after the
 * earlier conditional RLS migrations have already run. Protect every parent
 * and child table explicitly, including projections that do not carry their
 * own session owner column. This migration intentionally leaves the
 * authenticated self-select grant on app_accounts unchanged.
 */
export const ACCOUNTS_RLS_SQL_V10 = `
DO $agent_pro_hosted_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted Agent/Pro RLS apply on classroom database openmaic';
  END IF;
END
$agent_pro_hosted_guard$;

DO $agent_pro_rls$
DECLARE
  tbl text;
  policy_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'agent_sessions',
    'agent_session_events',
    'agent_session_entries',
    'agent_owner_session_event_counters',
    'agent_owner_session_events',
    'agent_session_urls',
    'agent_user_skill',
    'agent_session_materials',
    'pro_model_connections',
    'pro_model_connection_revisions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app_web, app_worker',
      tbl
    );
    policy_name := tbl || '_worker_all';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO app_worker USING (true) WITH CHECK (true)',
      policy_name,
      tbl
    );
  END LOOP;
END
$agent_pro_rls$;

DROP POLICY IF EXISTS agent_sessions_web_all ON agent_sessions;
CREATE POLICY agent_sessions_web_all ON agent_sessions
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS agent_session_events_web_all ON agent_session_events;
CREATE POLICY agent_session_events_web_all ON agent_session_events
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_events.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_events.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS agent_session_entries_web_all ON agent_session_entries;
CREATE POLICY agent_session_entries_web_all ON agent_session_entries
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_entries.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_entries.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS agent_owner_session_event_counters_web_all
  ON agent_owner_session_event_counters;
CREATE POLICY agent_owner_session_event_counters_web_all
  ON agent_owner_session_event_counters
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS agent_owner_session_events_web_all ON agent_owner_session_events;
CREATE POLICY agent_owner_session_events_web_all ON agent_owner_session_events
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS agent_session_urls_web_all ON agent_session_urls;
CREATE POLICY agent_session_urls_web_all ON agent_session_urls
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_urls.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_urls.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS agent_user_skill_web_all ON agent_user_skill;
CREATE POLICY agent_user_skill_web_all ON agent_user_skill
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS agent_session_materials_web_all ON agent_session_materials;
CREATE POLICY agent_session_materials_web_all ON agent_session_materials
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_materials.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_session_materials.session_id
      AND s.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS pro_model_connections_web_all ON pro_model_connections;
CREATE POLICY pro_model_connections_web_all ON pro_model_connections
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS pro_model_connection_revisions_web_all
  ON pro_model_connection_revisions;
CREATE POLICY pro_model_connection_revisions_web_all
  ON pro_model_connection_revisions
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM pro_model_connections c
    WHERE c.id = pro_model_connection_revisions.connection_id
      AND c.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM pro_model_connections c
    WHERE c.id = pro_model_connection_revisions.connection_id
      AND c.owner_id = app_internal.current_owner_id()
  ));

DROP POLICY IF EXISTS app_profiles_web_select ON app_profiles;
DROP POLICY IF EXISTS app_profiles_web_update ON app_profiles;
DROP POLICY IF EXISTS app_profiles_web_insert ON app_profiles;
CREATE POLICY app_profiles_web_select ON app_profiles
  FOR SELECT TO app_web
  USING (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id
      AND a.owner_id = app_internal.current_owner_id()
  ));
CREATE POLICY app_profiles_web_insert ON app_profiles
  FOR INSERT TO app_web
  WITH CHECK (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id
      AND a.owner_id = app_internal.current_owner_id()
  ));
CREATE POLICY app_profiles_web_update ON app_profiles
  FOR UPDATE TO app_web
  USING (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id
      AND a.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM app_accounts a
    WHERE a.user_id = app_profiles.user_id
      AND a.owner_id = app_internal.current_owner_id()
  ));
`;

/**
 * Hosted Data API only. Lets a signed-in user SELECT their own role/status
 * with the user JWT so classroom ensure_account can copy it without
 * SUPABASE_SECRET_KEY. Does not grant UPDATE. Does not touch generation tables.
 */
export const HOSTED_APP_ACCOUNTS_SELF_SELECT_SQL = `
GRANT SELECT (user_id, owner_id, role, status) ON TABLE public.app_accounts TO authenticated;

DROP POLICY IF EXISTS app_accounts_self_select ON public.app_accounts;
CREATE POLICY app_accounts_self_select
  ON public.app_accounts
  FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) IS NOT NULL
    AND user_id = (SELECT auth.uid())
  );

NOTIFY pgrst, 'reload schema';
`;

/** RLS/grants for durable storage mappings and resumable account deletion. */
export const ACCOUNTS_RLS_SQL_V11 = `
DO $v11_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'classroom_media_objects',
    'classroom_generation_jobs',
    'account_deletion_jobs',
    'account_deletion_objects',
    'deleted_account_tombstones',
    'storage_migration_runs',
    'storage_migration_objects'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    END IF;
  END LOOP;
END
$v11_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  classroom_media_objects, classroom_generation_jobs
TO app_web;

GRANT USAGE, SELECT ON SEQUENCE usage_events_id_seq TO app_web, app_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  classroom_media_objects, classroom_generation_jobs,
  account_deletion_jobs, account_deletion_objects, deleted_account_tombstones,
  storage_migration_runs, storage_migration_objects
TO app_worker;

DROP POLICY IF EXISTS classroom_media_objects_web_all ON classroom_media_objects;
CREATE POLICY classroom_media_objects_web_all ON classroom_media_objects
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS classroom_generation_jobs_web_all ON classroom_generation_jobs;
CREATE POLICY classroom_generation_jobs_web_all ON classroom_generation_jobs
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS render_job_owners_web_all ON render_job_owners;
CREATE POLICY render_job_owners_web_all ON render_job_owners
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS classroom_media_objects_worker_all ON classroom_media_objects;
CREATE POLICY classroom_media_objects_worker_all ON classroom_media_objects
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS classroom_generation_jobs_worker_all ON classroom_generation_jobs;
CREATE POLICY classroom_generation_jobs_worker_all ON classroom_generation_jobs
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS account_deletion_jobs_worker_all ON account_deletion_jobs;
CREATE POLICY account_deletion_jobs_worker_all ON account_deletion_jobs
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS account_deletion_objects_worker_all ON account_deletion_objects;
CREATE POLICY account_deletion_objects_worker_all ON account_deletion_objects
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS deleted_account_tombstones_worker_all ON deleted_account_tombstones;
CREATE POLICY deleted_account_tombstones_worker_all ON deleted_account_tombstones
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS storage_migration_runs_worker_all ON storage_migration_runs;
CREATE POLICY storage_migration_runs_worker_all ON storage_migration_runs
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS storage_migration_objects_worker_all ON storage_migration_objects;
CREATE POLICY storage_migration_objects_worker_all ON storage_migration_objects
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION app_internal.assert_heavy_task_owner(p_owner_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $capacity_owner$
BEGIN
  IF NOT pg_has_role(session_user, 'app_worker', 'member')
     AND p_owner_id IS DISTINCT FROM app_internal.current_owner_id() THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
END
$capacity_owner$;

CREATE OR REPLACE FUNCTION app_internal.generation_readiness()
RETURNS TABLE(schema_version integer, worker_live boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $generation_readiness$
  SELECT COALESCE((SELECT MAX(version) FROM public.generation_schema_migrations), 0)::integer,
         EXISTS (
           SELECT 1 FROM public.generation_worker_heartbeats
            WHERE heartbeat_at > clock_timestamp() - interval '30 seconds'
              AND NOT draining
              AND pipeline_versions @> '[2]'::jsonb
         )
$generation_readiness$;

CREATE OR REPLACE FUNCTION app_internal.heavy_task_capacity(
  p_operation text,
  p_owner_id text,
  p_root_task_id text,
  p_now_ms bigint,
  p_agent_stale_before bigint,
  p_material_stale_before bigint,
  p_queue_fresh_after bigint,
  p_candidate_queued_at bigint,
  p_owner_limit integer,
  p_site_limit integer,
  p_lock boolean DEFAULT true
)
RETURNS TABLE(
  total_count bigint,
  owner_count bigint,
  inherited boolean,
  candidate_present boolean,
  oldest_root text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $heavy_task_capacity$
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  IF p_operation NOT IN ('admission', 'queue', 'attention', 'fair')
     OR p_owner_limit < 1 OR p_owner_limit > 100
     OR p_site_limit < 1 OR p_site_limit > 100
     OR p_owner_limit > p_site_limit THEN
    RAISE EXCEPTION 'invalid capacity request' USING ERRCODE = '22023';
  END IF;
  IF p_lock THEN
    PERFORM pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'));
  END IF;

  IF p_operation = 'admission' THEN
    IF p_lock THEN
      DELETE FROM public.generation_provider_slots
       WHERE quota_group LIKE 'heavy-task:sync-owner:%'
         AND (holder_attempt_id IS NULL OR expires_at <= clock_timestamp());
    END IF;
    RETURN QUERY
    WITH active_roots AS (
      SELECT owner_id,
             CASE WHEN input_snapshot->'source'->>'kind'='pro'
                        AND NULLIF(input_snapshot->'source'->>'sessionId','') IS NOT NULL
                  THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
                  ELSE 'generation:' || id END AS root_task_id
        FROM public.generation_jobs
       WHERE status='running' AND lease_expires_at > clock_timestamp()
      UNION
      SELECT owner_id, 'agent:' || id
        FROM public.agent_sessions
       WHERE status='running' AND lease_worker_id IS NOT NULL
         AND lease_heartbeat_at IS NOT NULL AND lease_heartbeat_at >= p_agent_stale_before
      UNION
      SELECT session.owner_id, 'agent:' || material.session_id
        FROM public.agent_session_materials material
        JOIN public.agent_sessions session ON session.id=material.session_id
       WHERE session.deleted_at IS NULL AND material.extraction_status='running'
         AND material.extraction_lease_worker_id IS NOT NULL
         AND material.extraction_lease_heartbeat_at IS NOT NULL
         AND material.extraction_lease_heartbeat_at >= p_material_stale_before
    ), durable AS (
      SELECT COUNT(*)::bigint AS n,
             COUNT(*) FILTER (WHERE owner_id=p_owner_id)::bigint AS owner_n,
             COALESCE(BOOL_OR(owner_id=p_owner_id AND root_task_id=p_root_task_id),false) AS inherited
        FROM active_roots
    ), synchronous AS (
      SELECT COUNT(*)::bigint AS n,
             COUNT(*) FILTER (WHERE quota_group='heavy-task:sync-owner:' || p_owner_id)::bigint AS owner_n,
             COALESCE(BOOL_OR(
               quota_group='heavy-task:sync-owner:' || p_owner_id
               AND 'independent:' || holder_attempt_id::text=p_root_task_id
             ),false) AS inherited
        FROM public.generation_provider_slots
       WHERE quota_group LIKE 'heavy-task:sync-owner:%'
         AND holder_attempt_id IS NOT NULL AND expires_at > clock_timestamp()
    )
    SELECT durable.n+synchronous.n, durable.owner_n+synchronous.owner_n,
           durable.inherited OR synchronous.inherited, false, NULL::text
      FROM durable CROSS JOIN synchronous;
    RETURN;
  END IF;

  IF p_operation = 'queue' THEN
    RETURN QUERY
    WITH queued_roots AS (
      SELECT owner_id,
             CASE WHEN input_snapshot->'source'->>'kind'='pro'
                        AND NULLIF(input_snapshot->'source'->>'sessionId','') IS NOT NULL
                  THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
                  ELSE 'generation:' || id END AS root_task_id
        FROM public.generation_jobs WHERE status='queued'
      UNION
      SELECT owner_id, 'agent:' || id
        FROM public.agent_sessions WHERE status='queued' AND deleted_at IS NULL
      UNION
      SELECT session.owner_id, 'agent:' || material.session_id
        FROM public.agent_session_materials material
        JOIN public.agent_sessions session ON session.id=material.session_id
       WHERE session.deleted_at IS NULL AND material.extraction_status='pending'
    ), other_roots AS (
      SELECT * FROM queued_roots
       WHERE NOT (owner_id=p_owner_id AND root_task_id=p_root_task_id)
    )
    SELECT COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE owner_id=p_owner_id)::bigint,
           false, false, NULL::text
      FROM other_roots;
    RETURN;
  END IF;

  IF p_operation = 'attention' THEN
    RETURN QUERY
    WITH attention_roots AS (
      SELECT owner_id,
             CASE WHEN input_snapshot->'source'->>'kind'='pro'
                        AND NULLIF(input_snapshot->'source'->>'sessionId','') IS NOT NULL
                  THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
                  ELSE 'generation:' || id END AS root_task_id
        FROM public.generation_jobs
       WHERE status IN ('awaiting_confirmation','needs_attention')
      UNION
      SELECT job.owner_id,
             CASE WHEN job.input_snapshot->'source'->>'kind'='pro'
                        AND NULLIF(job.input_snapshot->'source'->>'sessionId','') IS NOT NULL
                  THEN 'agent:' || (job.input_snapshot->'source'->>'sessionId')
                  ELSE 'generation:' || job.id END
        FROM public.generation_provider_slots reservation
        JOIN public.generation_jobs job ON job.id=reservation.holder_attempt_id
       WHERE reservation.quota_group='heavy-task:attention-reservation'
         AND job.review_policy='manual'
         AND job.status NOT IN ('succeeded','failed','cancelled')
      UNION
      SELECT session.owner_id, 'agent:' || session.id
        FROM public.agent_sessions session
       WHERE session.deleted_at IS NULL
         AND session.status IN ('running','succeeded','failed')
         AND EXISTS (
           SELECT 1 FROM public.agent_session_events question
            WHERE question.session_id=session.id AND question.type='user_question'
              AND NOT EXISTS (
                SELECT 1 FROM public.agent_session_events answer
                 WHERE answer.session_id=question.session_id AND answer.seq>question.seq
                   AND answer.type='user_message'
                   AND length(btrim(COALESCE(answer.data->>'text',''))) > 0
              )
         )
    ), other_roots AS (
      SELECT * FROM attention_roots
       WHERE NOT (owner_id=p_owner_id AND root_task_id=p_root_task_id)
    )
    SELECT COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE owner_id=p_owner_id)::bigint,
           false, false, NULL::text
      FROM other_roots;
    RETURN;
  END IF;

  RETURN QUERY
  WITH active_roots AS (
    SELECT owner_id,
           CASE WHEN input_snapshot->'source'->>'kind'='pro'
                      AND NULLIF(input_snapshot->'source'->>'sessionId','') IS NOT NULL
                THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
                ELSE 'generation:' || id END AS root_task_id
      FROM public.generation_jobs
     WHERE status='running' AND lease_expires_at > clock_timestamp()
    UNION
    SELECT substring(quota_group from 23), 'independent:' || holder_attempt_id::text
      FROM public.generation_provider_slots
     WHERE quota_group LIKE 'heavy-task:sync-owner:%'
       AND holder_attempt_id IS NOT NULL AND expires_at > clock_timestamp()
    UNION
    SELECT owner_id, 'agent:' || id FROM public.agent_sessions
     WHERE status='running' AND lease_worker_id IS NOT NULL
       AND lease_heartbeat_at IS NOT NULL AND lease_heartbeat_at >= p_agent_stale_before
    UNION
    SELECT session.owner_id, 'agent:' || material.session_id
      FROM public.agent_session_materials material
      JOIN public.agent_sessions session ON session.id=material.session_id
     WHERE session.deleted_at IS NULL AND material.extraction_status='running'
       AND material.extraction_lease_worker_id IS NOT NULL
       AND material.extraction_lease_heartbeat_at IS NOT NULL
       AND material.extraction_lease_heartbeat_at >= p_material_stale_before
  ), active_owner_counts AS (
    SELECT owner_id,COUNT(*)::bigint AS active_root_count FROM active_roots GROUP BY owner_id
  ), raw_queue AS (
    SELECT owner_id,
           CASE WHEN input_snapshot->'source'->>'kind'='pro'
                      AND NULLIF(input_snapshot->'source'->>'sessionId','') IS NOT NULL
                THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
                ELSE 'generation:' || id END AS root_task_id,
           created_at AS queued_at
      FROM public.generation_jobs
     WHERE ((status='queued' AND updated_at > to_timestamp(p_queue_fresh_after/1000.0))
        OR (status='retry_wait' AND available_at <= clock_timestamp()))
    UNION ALL
    SELECT owner_id,'agent:' || id,updated_at FROM public.agent_sessions
     WHERE status='queued' AND deleted_at IS NULL
       AND updated_at > to_timestamp(p_queue_fresh_after/1000.0)
    UNION ALL
    SELECT session.owner_id,'agent:' || material.session_id,
           to_timestamp(COALESCE(material.extraction_lease_heartbeat_at,
             (extract(epoch FROM material.created_at)*1000)::bigint)/1000.0)
      FROM public.agent_session_materials material
      JOIN public.agent_sessions session ON session.id=material.session_id
     WHERE session.deleted_at IS NULL AND material.extraction_status='pending'
       AND COALESCE(material.extraction_lease_heartbeat_at,
           (extract(epoch FROM material.created_at)*1000)::bigint) > p_queue_fresh_after
    UNION ALL
    SELECT p_owner_id,p_root_task_id,to_timestamp(p_candidate_queued_at/1000.0)
     WHERE p_candidate_queued_at IS NOT NULL
  ), queued_roots AS (
    SELECT owner_id,root_task_id,MIN(queued_at) AS queued_at
      FROM raw_queue GROUP BY owner_id,root_task_id
  ), eligible AS (
    SELECT queued_roots.* FROM queued_roots
    LEFT JOIN active_owner_counts USING(owner_id)
     WHERE COALESCE(active_owner_counts.active_root_count,0) < p_owner_limit
        OR EXISTS (
          SELECT 1 FROM active_roots
           WHERE active_roots.owner_id=queued_roots.owner_id
             AND active_roots.root_task_id=queued_roots.root_task_id
        )
  )
  SELECT 0::bigint,0::bigint,false,
         EXISTS(SELECT 1 FROM queued_roots WHERE owner_id=p_owner_id AND root_task_id=p_root_task_id),
         (SELECT root_task_id FROM eligible ORDER BY queued_at,root_task_id LIMIT 1);
END
$heavy_task_capacity$;

CREATE OR REPLACE FUNCTION app_internal.acquire_heavy_task_sync_lease(
  p_owner_id text, p_holder uuid, p_owner_limit integer, p_lease_ms integer
)
RETURNS TABLE(slot_no integer, lease_epoch bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $sync_acquire$
DECLARE
  quota text := 'heavy-task:sync-owner:' || p_owner_id;
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  IF p_owner_limit < 1 OR p_owner_limit > 32 OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'invalid sync lease request' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.generation_provider_slots(quota_group,slot_no)
  SELECT quota,value FROM generate_series(0,p_owner_limit-1) value ON CONFLICT DO NOTHING;
  RETURN QUERY
  WITH available AS (
    SELECT reservation.slot_no FROM public.generation_provider_slots reservation
     WHERE reservation.quota_group=quota AND reservation.slot_no<p_owner_limit
       AND (reservation.holder_attempt_id IS NULL
            OR reservation.expires_at<=clock_timestamp())
     ORDER BY reservation.slot_no
     LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_provider_slots reservation
     SET holder_attempt_id=p_holder,
         lease_epoch=reservation.lease_epoch+1,
         expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond',
         quarantine_until=NULL,cooldown_until=NULL
    FROM available
   WHERE reservation.quota_group=quota AND reservation.slot_no=available.slot_no
  RETURNING reservation.slot_no,reservation.lease_epoch;
END
$sync_acquire$;

CREATE OR REPLACE FUNCTION app_internal.heartbeat_heavy_task_sync_lease(
  p_quota_group text, p_slot_no integer, p_holder uuid, p_epoch bigint, p_lease_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $sync_heartbeat$
DECLARE changed integer;
BEGIN
  IF NOT pg_has_role(session_user,'app_worker','member')
     AND p_quota_group IS DISTINCT FROM 'heavy-task:sync-owner:' || app_internal.current_owner_id() THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE='42501';
  END IF;
  UPDATE public.generation_provider_slots
     SET expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond'
   WHERE quota_group=p_quota_group AND slot_no=p_slot_no
     AND holder_attempt_id=p_holder AND lease_epoch=p_epoch
     AND expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$sync_heartbeat$;

CREATE OR REPLACE FUNCTION app_internal.release_heavy_task_sync_lease(
  p_quota_group text, p_slot_no integer, p_holder uuid, p_epoch bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $sync_release$
DECLARE changed integer;
BEGIN
  IF NOT pg_has_role(session_user,'app_worker','member')
     AND p_quota_group IS DISTINCT FROM 'heavy-task:sync-owner:' || app_internal.current_owner_id() THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM public.generation_provider_slots
   WHERE quota_group=p_quota_group AND slot_no=p_slot_no
     AND holder_attempt_id=p_holder AND lease_epoch=p_epoch;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$sync_release$;

CREATE OR REPLACE FUNCTION app_internal.reserve_heavy_task_attention(
  p_job_id uuid, p_site_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $attention_reserve$
DECLARE job_owner text; changed integer;
BEGIN
  SELECT owner_id INTO job_owner FROM public.generation_jobs WHERE id=p_job_id;
  IF job_owner IS NULL THEN RETURN false; END IF;
  PERFORM app_internal.assert_heavy_task_owner(job_owner);
  IF p_site_limit < 1 OR p_site_limit > 100 THEN
    RAISE EXCEPTION 'invalid attention limit' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.generation_provider_slots(quota_group,slot_no)
  SELECT 'heavy-task:attention-reservation',value FROM generate_series(0,p_site_limit-1) value
  ON CONFLICT DO NOTHING;
  WITH available AS (
    SELECT reservation.slot_no FROM public.generation_provider_slots reservation
     WHERE reservation.quota_group='heavy-task:attention-reservation'
       AND reservation.slot_no<p_site_limit
       AND (reservation.holder_attempt_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.generation_jobs job
          WHERE job.id=reservation.holder_attempt_id AND job.review_policy='manual'
            AND job.status NOT IN ('succeeded','failed','cancelled')
       ))
     ORDER BY reservation.slot_no LIMIT 1 FOR UPDATE
  )
  UPDATE public.generation_provider_slots reservation
     SET holder_attempt_id=p_job_id,lease_epoch=reservation.lease_epoch+1,
         expires_at=NULL,quarantine_until=NULL,cooldown_until=NULL
    FROM available
   WHERE reservation.quota_group='heavy-task:attention-reservation'
     AND reservation.slot_no=available.slot_no;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$attention_reserve$;

REVOKE ALL ON FUNCTION app_internal.assert_heavy_task_owner(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.generation_readiness() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.heavy_task_capacity(text,text,text,bigint,bigint,bigint,bigint,bigint,integer,integer,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.acquire_heavy_task_sync_lease(text,uuid,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.heartbeat_heavy_task_sync_lease(text,integer,uuid,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.release_heavy_task_sync_lease(text,integer,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.reserve_heavy_task_attention(uuid,integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION app_internal.generation_readiness() TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.heavy_task_capacity(text,text,text,bigint,bigint,bigint,bigint,bigint,integer,integer,boolean) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.acquire_heavy_task_sync_lease(text,uuid,integer,integer) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.heartbeat_heavy_task_sync_lease(text,integer,uuid,bigint,integer) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.release_heavy_task_sync_lease(text,integer,uuid,bigint) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.reserve_heavy_task_attention(uuid,integer) TO app_web, app_worker;
`;

/**
 * Forward patch for deployments that already recorded v11 before foreground
 * course generation joined the unified root budget. The definer seam performs
 * owner verification, admission/fairness, and idempotent course-root renewal
 * without granting app_web direct access to the global slot table.
 */
export const ACCOUNTS_RLS_SQL_V12 = `
CREATE OR REPLACE FUNCTION app_internal.acquire_foreground_generation_root(
  p_owner_id text,
  p_holder uuid,
  p_now_ms bigint,
  p_agent_stale_before bigint,
  p_material_stale_before bigint,
  p_owner_limit integer,
  p_site_limit integer,
  p_lease_ms integer
)
RETURNS TABLE(allowed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $foreground_acquire$
DECLARE
  capacity_row record;
  fair_row record;
  acquired_row record;
  changed integer;
  root_id text := 'foreground:' || p_holder::text;
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  IF p_now_ms < 0 OR p_owner_limit < 1 OR p_owner_limit > 32
     OR p_site_limit < 1 OR p_site_limit > 32
     OR p_owner_limit > p_site_limit OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'invalid foreground lease request' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'));
  UPDATE public.generation_provider_slots
     SET expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond'
   WHERE quota_group='heavy-task:sync-owner:' || p_owner_id
     AND holder_attempt_id=p_holder AND expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed>0 THEN
    RETURN QUERY SELECT true,NULL::text;
    RETURN;
  END IF;

  SELECT * INTO capacity_row
    FROM app_internal.heavy_task_capacity(
      'admission',p_owner_id,root_id,p_now_ms,p_agent_stale_before,
      p_material_stale_before,p_now_ms-3600000,NULL,
      p_owner_limit,p_site_limit,false
    );
  IF capacity_row.owner_count>=p_owner_limit THEN
    RETURN QUERY SELECT false,'personal_limit'::text;
    RETURN;
  END IF;
  IF capacity_row.total_count>=p_site_limit THEN
    RETURN QUERY SELECT false,'site_limit'::text;
    RETURN;
  END IF;

  SELECT * INTO fair_row
    FROM app_internal.heavy_task_capacity(
      'fair',p_owner_id,root_id,p_now_ms,p_agent_stale_before,
      p_material_stale_before,p_now_ms-3600000,p_now_ms,
      p_owner_limit,p_site_limit,false
    );
  IF fair_row.candidate_present AND fair_row.oldest_root IS DISTINCT FROM root_id THEN
    RETURN QUERY SELECT false,'site_limit'::text;
    RETURN;
  END IF;

  SELECT * INTO acquired_row
    FROM app_internal.acquire_heavy_task_sync_lease(
      p_owner_id,p_holder,p_owner_limit,p_lease_ms
    );
  IF acquired_row.slot_no IS NULL THEN
    RETURN QUERY SELECT false,'site_limit'::text;
  ELSE
    RETURN QUERY SELECT true,NULL::text;
  END IF;
END
$foreground_acquire$;

CREATE OR REPLACE FUNCTION app_internal.release_heavy_task_foreground_lease(
  p_owner_id text, p_holder uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $foreground_release$
DECLARE changed integer;
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  DELETE FROM public.generation_provider_slots
   WHERE quota_group='heavy-task:sync-owner:' || p_owner_id
     AND holder_attempt_id=p_holder;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed>0;
END
$foreground_release$;

REVOKE ALL ON FUNCTION app_internal.acquire_foreground_generation_root(text,uuid,bigint,bigint,bigint,integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.release_heavy_task_foreground_lease(text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.acquire_foreground_generation_root(text,uuid,bigint,bigint,bigint,integer,integer,integer) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.release_heavy_task_foreground_lease(text,uuid) TO app_web, app_worker;
`;

/**
 * Account-deletion fence for all synchronous roots. This is a forward-only
 * replacement of the v11/v12 definer functions so already-recorded checksums
 * remain immutable.
 */
export const ACCOUNTS_RLS_SQL_V13 = `
CREATE OR REPLACE FUNCTION app_internal.heavy_task_owner_active(p_owner_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $owner_active$
  SELECT EXISTS (
    SELECT 1 FROM public.app_accounts account
     WHERE account.owner_id=p_owner_id AND account.status='active'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.deleted_account_tombstones tombstone
     WHERE tombstone.owner_id=p_owner_id
  )
$owner_active$;

CREATE OR REPLACE FUNCTION app_internal.acquire_heavy_task_sync_lease(
  p_owner_id text, p_holder uuid, p_owner_limit integer, p_lease_ms integer
)
RETURNS TABLE(slot_no integer, lease_epoch bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $sync_acquire$
DECLARE
  quota text := 'heavy-task:sync-owner:' || p_owner_id;
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  IF p_owner_limit < 1 OR p_owner_limit > 32 OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'invalid sync lease request' USING ERRCODE='22023';
  END IF;
  IF NOT app_internal.heavy_task_owner_active(p_owner_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.generation_provider_slots(quota_group,slot_no)
  SELECT quota,value FROM generate_series(0,p_owner_limit-1) value ON CONFLICT DO NOTHING;
  RETURN QUERY
  WITH available AS (
    SELECT reservation.slot_no FROM public.generation_provider_slots reservation
     WHERE reservation.quota_group=quota AND reservation.slot_no<p_owner_limit
       AND (reservation.holder_attempt_id IS NULL
            OR reservation.expires_at<=clock_timestamp())
     ORDER BY reservation.slot_no
     LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_provider_slots reservation
     SET holder_attempt_id=p_holder,
         lease_epoch=reservation.lease_epoch+1,
         expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond',
         quarantine_until=NULL,cooldown_until=NULL
    FROM available
   WHERE reservation.quota_group=quota AND reservation.slot_no=available.slot_no
  RETURNING reservation.slot_no,reservation.lease_epoch;
END
$sync_acquire$;

CREATE OR REPLACE FUNCTION app_internal.heartbeat_heavy_task_sync_lease(
  p_quota_group text, p_slot_no integer, p_holder uuid, p_epoch bigint, p_lease_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $sync_heartbeat$
DECLARE
  changed integer;
  owner_id text := substring(p_quota_group from 23);
BEGIN
  IF NOT pg_has_role(session_user,'app_worker','member')
     AND p_quota_group IS DISTINCT FROM 'heavy-task:sync-owner:' || app_internal.current_owner_id() THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE='42501';
  END IF;
  IF p_quota_group NOT LIKE 'heavy-task:sync-owner:%'
     OR NOT app_internal.heavy_task_owner_active(owner_id) THEN
    RETURN false;
  END IF;
  UPDATE public.generation_provider_slots
     SET expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond'
   WHERE quota_group=p_quota_group AND slot_no=p_slot_no
     AND holder_attempt_id=p_holder AND lease_epoch=p_epoch
     AND expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$sync_heartbeat$;

CREATE OR REPLACE FUNCTION app_internal.acquire_foreground_generation_root(
  p_owner_id text,
  p_holder uuid,
  p_now_ms bigint,
  p_agent_stale_before bigint,
  p_material_stale_before bigint,
  p_owner_limit integer,
  p_site_limit integer,
  p_lease_ms integer
)
RETURNS TABLE(allowed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $foreground_acquire$
DECLARE
  capacity_row record;
  fair_row record;
  acquired_row record;
  changed integer;
  root_id text := 'foreground:' || p_holder::text;
BEGIN
  PERFORM app_internal.assert_heavy_task_owner(p_owner_id);
  IF p_now_ms < 0 OR p_owner_limit < 1 OR p_owner_limit > 32
     OR p_site_limit < 1 OR p_site_limit > 32
     OR p_owner_limit > p_site_limit OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'invalid foreground lease request' USING ERRCODE='22023';
  END IF;
  IF NOT app_internal.heavy_task_owner_active(p_owner_id) THEN
    RETURN QUERY SELECT false,'account_inactive'::text;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'));
  UPDATE public.generation_provider_slots
     SET expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond'
   WHERE quota_group='heavy-task:sync-owner:' || p_owner_id
     AND holder_attempt_id=p_holder AND expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed>0 THEN
    RETURN QUERY SELECT true,NULL::text;
    RETURN;
  END IF;

  SELECT * INTO capacity_row
    FROM app_internal.heavy_task_capacity(
      'admission',p_owner_id,root_id,p_now_ms,p_agent_stale_before,
      p_material_stale_before,p_now_ms-3600000,NULL,
      p_owner_limit,p_site_limit,false
    );
  IF capacity_row.owner_count>=p_owner_limit THEN
    RETURN QUERY SELECT false,'personal_limit'::text;
    RETURN;
  END IF;
  IF capacity_row.total_count>=p_site_limit THEN
    RETURN QUERY SELECT false,'site_limit'::text;
    RETURN;
  END IF;

  SELECT * INTO fair_row
    FROM app_internal.heavy_task_capacity(
      'fair',p_owner_id,root_id,p_now_ms,p_agent_stale_before,
      p_material_stale_before,p_now_ms-3600000,p_now_ms,
      p_owner_limit,p_site_limit,false
    );
  IF fair_row.candidate_present AND fair_row.oldest_root IS DISTINCT FROM root_id THEN
    RETURN QUERY SELECT false,'site_limit'::text;
    RETURN;
  END IF;

  SELECT * INTO acquired_row
    FROM app_internal.acquire_heavy_task_sync_lease(
      p_owner_id,p_holder,p_owner_limit,p_lease_ms
    );
  IF acquired_row.slot_no IS NULL THEN
    RETURN QUERY SELECT false,'account_inactive'::text;
  ELSE
    RETURN QUERY SELECT true,NULL::text;
  END IF;
END
$foreground_acquire$;

REVOKE ALL ON FUNCTION app_internal.heavy_task_owner_active(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.acquire_heavy_task_sync_lease(text,uuid,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.heartbeat_heavy_task_sync_lease(text,integer,uuid,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.acquire_foreground_generation_root(text,uuid,bigint,bigint,bigint,integer,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.acquire_heavy_task_sync_lease(text,uuid,integer,integer) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.heartbeat_heavy_task_sync_lease(text,integer,uuid,bigint,integer) TO app_web, app_worker;
GRANT EXECUTE ON FUNCTION app_internal.acquire_foreground_generation_root(text,uuid,bigint,bigint,bigint,integer,integer,integer) TO app_web, app_worker;
`;

/**
 * Minimal deployment probe for the unprivileged worker login. Keep migration
 * tables and cross-owner heartbeats private; expose only aggregate versions
 * and the number of recent workers matching the requested pipeline.
 */
export const ACCOUNTS_RLS_SQL_V14 = `
CREATE OR REPLACE FUNCTION app_internal.deployment_readiness(p_pipeline_versions jsonb)
RETURNS TABLE(accounts_version integer, generation_version integer, live_workers integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $deployment_readiness$
  SELECT
    COALESCE((SELECT MAX(version) FROM public.app_schema_migrations), 0)::integer,
    COALESCE((SELECT MAX(version) FROM public.generation_schema_migrations), 0)::integer,
    (SELECT COUNT(*)::integer
       FROM public.generation_worker_heartbeats
      WHERE heartbeat_at > clock_timestamp() - interval '30 seconds'
        AND NOT draining
        AND pipeline_versions @> p_pipeline_versions)
$deployment_readiness$;

REVOKE ALL ON FUNCTION app_internal.deployment_readiness(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.deployment_readiness(jsonb) TO app_worker;
`;

/** Worker heartbeats store pipeline versions as JSON strings. v11 matched a
 * JSON number, causing otherwise healthy hosted workers to fail readiness. */
export const ACCOUNTS_RLS_SQL_V15 = `
CREATE OR REPLACE FUNCTION app_internal.generation_readiness()
RETURNS TABLE(schema_version integer, worker_live boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $generation_readiness$
  SELECT COALESCE((SELECT MAX(version) FROM public.generation_schema_migrations), 0)::integer,
         EXISTS (
           SELECT 1 FROM public.generation_worker_heartbeats
            WHERE heartbeat_at > clock_timestamp() - interval '30 seconds'
              AND NOT draining
              AND pipeline_versions @> '["2"]'::jsonb
         )
$generation_readiness$;

REVOKE ALL ON FUNCTION app_internal.generation_readiness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.generation_readiness() TO app_web, app_worker;
`;

/**
 * Identity columns have their own privilege boundary. Table INSERT alone does
 * not permit nextval() on the backing sequence, so a new durable generation
 * job could otherwise roll back while recording its first event. Keep the
 * sequence private from public API roles and grant only the two server logins.
 */
export const ACCOUNTS_RLS_SQL_V16 = `
DO $hosted_generation_event_sequence_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation sequence grant on classroom database openmaic';
  END IF;
  IF to_regclass('public.generation_events_id_seq') IS NULL THEN
    RAISE EXCEPTION 'generation_events_id_seq is required';
  END IF;
END
$hosted_generation_event_sequence_guard$;

REVOKE ALL ON SEQUENCE public.generation_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.generation_events_id_seq TO app_web, app_worker;
`;

/**
 * PostgreSQL requires UPDATE privilege and an UPDATE RLS policy for SELECT ...
 * FOR SHARE, even though the asset resolver never mutates the blob row. Grant
 * one inert key column solely to permit the lock, and make WITH CHECK false so
 * app_web still cannot update blob metadata or bytes. The USING clause mirrors
 * the owner-bound SELECT visibility through asset_entries.
 */
export const ACCOUNTS_RLS_SQL_V17 = `
DO $hosted_asset_blob_lock_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted asset blob lock grant on classroom database openmaic';
  END IF;
  IF to_regclass('public.asset_blobs') IS NULL OR to_regclass('public.asset_entries') IS NULL THEN
    RAISE EXCEPTION 'asset tables are required';
  END IF;
END
$hosted_asset_blob_lock_guard$;

REVOKE UPDATE ON TABLE public.asset_blobs FROM app_web;
GRANT UPDATE(content_hash) ON TABLE public.asset_blobs TO app_web;

DROP POLICY IF EXISTS asset_blobs_web_lock ON public.asset_blobs;
CREATE POLICY asset_blobs_web_lock ON public.asset_blobs
  FOR UPDATE TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM public.asset_entries entry
       WHERE entry.content_hash = asset_blobs.content_hash
         AND entry.principal = app_internal.current_owner_id()
    )
  )
  WITH CHECK (false);
`;

/**
 * Restricted hosted-Web mutations for the ownerless, content-addressed blob
 * registry. app_web retains no table-level INSERT/UPDATE privilege: all
 * validation and deduplication happens inside these fixed-search-path
 * functions, while asset_entries remains protected by owner RLS.
 */
export const ACCOUNTS_RLS_SQL_V18 = `
CREATE OR REPLACE FUNCTION app_internal.assert_asset_blob_owner()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $assert_asset_blob_owner$
DECLARE
  v_owner text := app_internal.current_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.app_accounts account
     WHERE account.owner_id = v_owner AND account.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active owner required' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END
$assert_asset_blob_owner$;

CREATE OR REPLACE FUNCTION app_internal.claim_asset_blob(p_hash text, p_byte_size bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $claim_asset_blob$
DECLARE
  affected integer;
BEGIN
  PERFORM app_internal.assert_asset_blob_owner();
  IF p_hash IS NULL OR p_hash !~ '^sha256-[0-9a-f]{64}$' OR p_byte_size IS NULL OR p_byte_size < 0 THEN
    RAISE EXCEPTION 'invalid asset blob claim' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.asset_blobs(content_hash, byte_size, bytes, unreferenced_at)
  VALUES(p_hash, p_byte_size, NULL, NULL)
  ON CONFLICT(content_hash) DO UPDATE
    SET unreferenced_at = NULL
    WHERE asset_blobs.byte_size = EXCLUDED.byte_size;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'asset blob size mismatch' USING ERRCODE = '23514';
  END IF;
END
$claim_asset_blob$;

CREATE OR REPLACE FUNCTION app_internal.release_asset_blob(p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $release_asset_blob$
BEGIN
  PERFORM app_internal.assert_asset_blob_owner();
  IF p_hash IS NULL OR p_hash !~ '^sha256-[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid asset blob release' USING ERRCODE = '22023';
  END IF;
  UPDATE public.asset_blobs blob
     SET unreferenced_at = clock_timestamp()
   WHERE blob.content_hash = p_hash
     AND NOT EXISTS (
       SELECT 1 FROM public.asset_entries entry WHERE entry.content_hash = p_hash
     );
END
$release_asset_blob$;

REVOKE ALL ON FUNCTION app_internal.assert_asset_blob_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.claim_asset_blob(text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_internal.release_asset_blob(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.claim_asset_blob(text,bigint) TO app_web;
GRANT EXECUTE ON FUNCTION app_internal.release_asset_blob(text) TO app_web;
`;

/**
 * Re-applies owner FORCE RLS after hosted generation/document tables exist.
 * Does not REVOKE authenticated self-select on app_accounts.
 */
export const ACCOUNTS_RLS_SQL_V8 = `
DO $hosted_gen_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'document_folders',
    'document_stages',
    'document_scenes',
    'document_outlines',
    'document_stage_revision',
    'document_scene_revision',
    'stage_meta',
    'runtime_sessions',
    'runtime_records',
    'asset_entries',
    'asset_blobs',
    'owner_material',
    'generation_jobs',
    'generation_ownership',
    'generation_scenes',
    'generation_steps',
    'generation_attempts',
    'generation_job_assets',
    'generation_events',
    'generation_commands',
    'generation_provider_slots',
    'generation_worker_heartbeats',
    'generation_schema_migrations',
    'media_config_snapshots',
    'generation_model_snapshots',
    'generation_search_snapshots'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    END IF;
  END LOOP;
END
$hosted_gen_rls$;

DO $hosted_gen_grant$
BEGIN
  IF to_regclass('public.document_stages') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      document_folders, document_stages, document_scenes, document_outlines,
      document_stage_revision, document_scene_revision, stage_meta,
      runtime_sessions, runtime_records, asset_entries, owner_material
    TO app_web, app_worker;
  END IF;
  IF to_regclass('public.asset_blobs') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE asset_blobs TO app_worker;
    GRANT SELECT ON TABLE asset_blobs TO app_web;
  END IF;
  IF to_regclass('public.generation_jobs') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      generation_jobs, generation_ownership, generation_scenes, generation_steps,
      generation_attempts, generation_job_assets, generation_events, generation_commands,
      media_config_snapshots, generation_model_snapshots, generation_search_snapshots
    TO app_web;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      generation_jobs, generation_ownership, generation_scenes, generation_steps,
      generation_attempts, generation_job_assets, generation_events, generation_commands,
      generation_provider_slots, generation_worker_heartbeats, generation_schema_migrations,
      media_config_snapshots, generation_model_snapshots, generation_search_snapshots
    TO app_worker;
  END IF;
END
$hosted_gen_grant$;

DO $hosted_gen_worker_rls$
DECLARE
  tbl text;
  policy_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'document_folders',
    'document_stages',
    'document_scenes',
    'document_outlines',
    'document_stage_revision',
    'document_scene_revision',
    'stage_meta',
    'runtime_sessions',
    'runtime_records',
    'asset_entries',
    'asset_blobs',
    'owner_material',
    'generation_jobs',
    'generation_ownership',
    'generation_scenes',
    'generation_steps',
    'generation_attempts',
    'generation_job_assets',
    'generation_events',
    'generation_commands',
    'generation_provider_slots',
    'generation_worker_heartbeats',
    'generation_schema_migrations',
    'media_config_snapshots',
    'generation_model_snapshots',
    'generation_search_snapshots'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      policy_name := tbl || '_worker_all';
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO app_worker USING (true) WITH CHECK (true)',
        policy_name,
        tbl
      );
    END IF;
  END LOOP;
END
$hosted_gen_worker_rls$;
${ifPublicTable(
  'document_stages',
  `
DROP POLICY IF EXISTS document_stages_web_select ON document_stages;
CREATE POLICY document_stages_web_select ON document_stages
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_insert ON document_stages
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_update ON document_stages
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY document_stages_web_delete ON document_stages
  FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'document_folders',
  `
DROP POLICY IF EXISTS document_folders_web_all ON document_folders;
CREATE POLICY document_folders_web_all ON document_folders
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'stage_meta',
  `
DROP POLICY IF EXISTS stage_meta_web_all ON stage_meta;
CREATE POLICY stage_meta_web_all ON stage_meta
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'document_scenes',
  `
DROP POLICY IF EXISTS document_scenes_web_all ON document_scenes;
CREATE POLICY document_scenes_web_all ON document_scenes
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scenes.stage_id AND s.owner_id = app_internal.current_owner_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_scenes.stage_id AND s.owner_id = app_internal.current_owner_id()))
`,
)}
${ifPublicTable(
  'document_outlines',
  `
DROP POLICY IF EXISTS document_outlines_web_all ON document_outlines;
CREATE POLICY document_outlines_web_all ON document_outlines
  FOR ALL TO app_web
  USING (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_outlines.stage_id AND s.owner_id = app_internal.current_owner_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM document_stages s WHERE s.id = document_outlines.stage_id AND s.owner_id = app_internal.current_owner_id()))
`,
)}
${ifPublicTable(
  'runtime_sessions',
  `
DROP POLICY IF EXISTS runtime_sessions_web_all ON runtime_sessions;
CREATE POLICY runtime_sessions_web_all ON runtime_sessions
  FOR ALL TO app_web
  USING (learner_key = app_internal.current_owner_id())
  WITH CHECK (
    learner_key = app_internal.current_owner_id()
    AND (
      stage_id IS NULL
      OR EXISTS (
        SELECT 1 FROM document_stages s
        WHERE s.id = runtime_sessions.stage_id AND s.owner_id = app_internal.current_owner_id()
      )
    )
  )
`,
)}
${ifPublicTable(
  'runtime_records',
  `
DROP POLICY IF EXISTS runtime_records_web_all ON runtime_records;
CREATE POLICY runtime_records_web_all ON runtime_records
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM runtime_sessions s
    WHERE s.id = runtime_records.session_id AND s.learner_key = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM runtime_sessions s
    WHERE s.id = runtime_records.session_id AND s.learner_key = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'asset_entries',
  `
DROP POLICY IF EXISTS asset_entries_web_all ON asset_entries;
CREATE POLICY asset_entries_web_all ON asset_entries
  FOR ALL TO app_web
  USING (principal = app_internal.current_owner_id())
  WITH CHECK (principal = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'asset_blobs',
  `
DROP POLICY IF EXISTS asset_blobs_web_insert ON asset_blobs;
DROP POLICY IF EXISTS asset_blobs_web_select ON asset_blobs;
CREATE POLICY asset_blobs_web_select ON asset_blobs
  FOR SELECT TO app_web
  USING (EXISTS (
    SELECT 1 FROM asset_entries e
    WHERE e.content_hash = asset_blobs.content_hash
      AND e.principal = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'owner_material',
  `
DROP POLICY IF EXISTS owner_material_web_all ON owner_material;
CREATE POLICY owner_material_web_all ON owner_material
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'generation_jobs',
  `
DROP POLICY IF EXISTS generation_jobs_web_all ON generation_jobs;
DROP POLICY IF EXISTS generation_jobs_web_select ON generation_jobs;
CREATE POLICY generation_jobs_web_select ON generation_jobs
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_jobs_web_insert ON generation_jobs
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_jobs_web_update ON generation_jobs
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_jobs_web_delete ON generation_jobs;
CREATE POLICY generation_jobs_web_delete ON generation_jobs
  FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_jobs_worker_all ON generation_jobs;
CREATE POLICY generation_jobs_worker_all ON generation_jobs
  FOR ALL TO app_worker USING (true) WITH CHECK (true)
`,
)}
`;

function jobOwnedPolicy(table: string, jobIdColumn = 'job_id'): string {
  return ifPublicTable(
    table,
    `
DROP POLICY IF EXISTS ${table}_web_all ON ${table};
CREATE POLICY ${table}_web_all ON ${table}
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM generation_jobs j
    WHERE j.id = ${table}.${jobIdColumn} AND j.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM generation_jobs j
    WHERE j.id = ${table}.${jobIdColumn} AND j.owner_id = app_internal.current_owner_id()
  ))
`,
  );
}

/**
 * Re-applies FORCE RLS + owner policies after hosted generation tables are
 * the real shapes (not v8 stubs). Hosted-only; refuses the classroom database.
 * Does not REVOKE authenticated self-select on app_accounts.
 */
export const ACCOUNTS_RLS_SQL_V9 = `
DO $hosted_real_shape_rls_guard$
BEGIN
  IF current_database() = 'openmaic' THEN
    RAISE EXCEPTION 'refusing hosted generation real-shape apply on classroom database openmaic';
  END IF;
END
$hosted_real_shape_rls_guard$;

${ifPublicTable(
  'document_stages',
  `
DROP POLICY IF EXISTS document_stages_web_insert ON document_stages;
DROP POLICY IF EXISTS document_stages_web_update ON document_stages;
DROP POLICY IF EXISTS document_stages_web_delete ON document_stages
`,
)}
${ifPublicTable(
  'generation_jobs',
  `
DROP POLICY IF EXISTS generation_jobs_web_insert ON generation_jobs;
DROP POLICY IF EXISTS generation_jobs_web_update ON generation_jobs;
DROP POLICY IF EXISTS generation_jobs_web_delete ON generation_jobs;
`,
)}

${ACCOUNTS_RLS_SQL_V8}

${ifPublicTable(
  'generation_ownership',
  `
DROP POLICY IF EXISTS generation_ownership_web_select ON generation_ownership;
DROP POLICY IF EXISTS generation_ownership_web_insert ON generation_ownership;
DROP POLICY IF EXISTS generation_ownership_web_update ON generation_ownership;
DROP POLICY IF EXISTS generation_ownership_web_all ON generation_ownership;
CREATE POLICY generation_ownership_web_select ON generation_ownership
  FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_ownership_web_insert ON generation_ownership
  FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id());
CREATE POLICY generation_ownership_web_update ON generation_ownership
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_ownership_web_delete ON generation_ownership;
CREATE POLICY generation_ownership_web_delete ON generation_ownership
  FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS generation_ownership_worker_all ON generation_ownership;
CREATE POLICY generation_ownership_worker_all ON generation_ownership
  FOR ALL TO app_worker USING (true) WITH CHECK (true)
`,
)}
${jobOwnedPolicy('generation_scenes')}
${jobOwnedPolicy('generation_steps')}
${jobOwnedPolicy('generation_job_assets')}
${jobOwnedPolicy('generation_events')}
${jobOwnedPolicy('generation_commands')}
${ifPublicTable(
  'generation_attempts',
  `
DROP POLICY IF EXISTS generation_attempts_web_all ON generation_attempts;
CREATE POLICY generation_attempts_web_all ON generation_attempts
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1
      FROM generation_steps st
      JOIN generation_jobs j ON j.id = st.job_id
     WHERE st.id = generation_attempts.step_id
       AND j.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM generation_steps st
      JOIN generation_jobs j ON j.id = st.job_id
     WHERE st.id = generation_attempts.step_id
       AND j.owner_id = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'media_config_snapshots',
  `
DROP POLICY IF EXISTS media_config_snapshots_web_all ON media_config_snapshots;
CREATE POLICY media_config_snapshots_web_all ON media_config_snapshots
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'generation_model_snapshots',
  `
DROP POLICY IF EXISTS generation_model_snapshots_web_all ON generation_model_snapshots;
CREATE POLICY generation_model_snapshots_web_all ON generation_model_snapshots
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'generation_search_snapshots',
  `
DROP POLICY IF EXISTS generation_search_snapshots_web_all ON generation_search_snapshots;
CREATE POLICY generation_search_snapshots_web_all ON generation_search_snapshots
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())
`,
)}
${ifPublicTable(
  'document_stage_revision',
  `
DROP POLICY IF EXISTS document_stage_revision_web_all ON document_stage_revision;
CREATE POLICY document_stage_revision_web_all ON document_stage_revision
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM document_stages s
    WHERE s.id = document_stage_revision.stage_id AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM document_stages s
    WHERE s.id = document_stage_revision.stage_id AND s.owner_id = app_internal.current_owner_id()
  ))
`,
)}
${ifPublicTable(
  'document_scene_revision',
  `
DROP POLICY IF EXISTS document_scene_revision_web_all ON document_scene_revision;
CREATE POLICY document_scene_revision_web_all ON document_scene_revision
  FOR ALL TO app_web
  USING (EXISTS (
    SELECT 1 FROM document_stages s
    WHERE s.id = document_scene_revision.stage_id AND s.owner_id = app_internal.current_owner_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM document_stages s
    WHERE s.id = document_scene_revision.stage_id AND s.owner_id = app_internal.current_owner_id()
  ))
`,
)}
`;
