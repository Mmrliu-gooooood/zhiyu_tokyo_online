/**
 * v23: shared study materials, structured parse artifacts and the learning
 * task queue (learning plan B02).
 *
 * - study_materials: one long-lived material in the owner's library ("高数教材").
 *   Its bytes are never stored here; each version points at an existing
 *   owner_material upload (same upload endpoint, quota and private byte store).
 * - study_material_versions: immutable file versions. Replacing a file adds a
 *   version; older versions, their artifacts and any location that names them
 *   stay readable until the material is permanently deleted.
 * - study_material_artifacts: one normalized DocumentArtifact per (version,
 *   parse fingerprint). The fingerprint covers extractor id/version and the
 *   normalization version, so the same parse is never stored twice and a
 *   different parser yields a new artifact. Objects live in the material byte
 *   store; object_keys lists every key for deletion.
 * - study_space_materials: a material may sit in several of the owner's
 *   spaces; removing it from a space never deletes it.
 * - study_session_material_refs: agent sessions that read a version by
 *   reference instead of copying its bytes. A ref is the read authorization
 *   for the shared keys; deleting the version cascades and revokes it.
 * - learning_tasks / learning_task_attempts: the learning-task queue and its
 *   per-attempt call details. The lease/heartbeat/claim mechanics are shared
 *   with generation_jobs (lib/server/task-queue); the contract is separate so
 *   course generation is untouched. B02 only defines kind material_parse;
 *   later batches add kinds to the same table.
 *
 * Owner isolation: every web query is owner-bound (app.owner_id) with FORCE
 * RLS. Version inserts must name the owner's own ready upload and session refs
 * the owner's own live session. The worker may read what parsing needs and
 * write task state and artifacts; it cannot insert or delete tasks, materials
 * or versions. Account deletion runs as the migration administrator.
 *
 * heavy_task_capacity is replaced (forward-only) so durable learning-task
 * roots count toward the same personal/site admission, queue and fairness
 * limits as generation jobs, agent sessions and session material extraction.
 *
 * STUDY_TABLES_SQL_V23 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same table text via `ensureStudySchema`.
 */
export const STUDY_TABLES_SQL_V23 = `
CREATE TABLE IF NOT EXISTS study_materials (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting')),
  current_version_id text,
  version_count integer NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_materials_owner_id_key UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS study_materials_owner_updated
  ON study_materials (owner_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS study_material_versions (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  material_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  owner_material_id text NOT NULL UNIQUE,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL CHECK (length(mime) BETWEEN 1 AND 200),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 512),
  active_artifact_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_material_versions_owner_id_key UNIQUE (owner_id, id),
  CONSTRAINT study_material_versions_number UNIQUE (owner_id, material_id, version_no),
  CONSTRAINT study_material_versions_material_fk FOREIGN KEY (owner_id, material_id)
    REFERENCES study_materials (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_material_versions_owner_sha
  ON study_material_versions (owner_id, sha256);

CREATE TABLE IF NOT EXISTS study_material_artifacts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  version_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  extractor_id text NOT NULL CHECK (length(extractor_id) BETWEEN 1 AND 100),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 100),
  transform_version text NOT NULL CHECK (length(transform_version) BETWEEN 1 AND 100),
  artifact_key text NOT NULL,
  text_key text NOT NULL,
  object_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(object_keys) = 'array'),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  block_count integer NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  text_chars integer NOT NULL DEFAULT 0 CHECK (text_chars >= 0),
  image_count integer NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  paged boolean NOT NULL DEFAULT false,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_material_artifacts_owner_id_key UNIQUE (owner_id, id),
  CONSTRAINT study_material_artifacts_fingerprint UNIQUE (owner_id, version_id, fingerprint),
  CONSTRAINT study_material_artifacts_version_fk FOREIGN KEY (owner_id, version_id)
    REFERENCES study_material_versions (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_space_materials (
  owner_id text NOT NULL,
  space_id text NOT NULL,
  material_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, space_id, material_id),
  CONSTRAINT study_space_materials_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_space_materials_material_fk FOREIGN KEY (owner_id, material_id)
    REFERENCES study_materials (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_space_materials_owner_material
  ON study_space_materials (owner_id, material_id);

CREATE TABLE IF NOT EXISTS study_session_material_refs (
  owner_id text NOT NULL,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  session_material_id text NOT NULL CHECK (length(session_material_id) BETWEEN 1 AND 200),
  version_id text NOT NULL,
  artifact_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, session_material_id),
  CONSTRAINT study_session_material_refs_version_fk FOREIGN KEY (owner_id, version_id)
    REFERENCES study_material_versions (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_session_material_refs_owner_version
  ON study_session_material_refs (owner_id, version_id);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  root_task_id text NOT NULL CHECK (length(root_task_id) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('material_parse')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_completeness text NOT NULL DEFAULT 'none' CHECK (usage_completeness IN
    ('none', 'complete', 'partial', 'unknown')),
  worker_id text,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancel_requested_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  last_error_summary text CHECK (last_error_summary IS NULL OR char_length(last_error_summary) <= 240),
  state_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT learning_tasks_idempotency UNIQUE (owner_id, idempotency_key),
  CONSTRAINT learning_tasks_running_lease CHECK (
    status <> 'running' OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS learning_tasks_claim
  ON learning_tasks (available_at, created_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS learning_tasks_running
  ON learning_tasks (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS learning_tasks_owner_subject
  ON learning_tasks (owner_id, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_task_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES learning_tasks(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  lease_epoch bigint NOT NULL,
  worker_id text NOT NULL,
  provider_id text,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN
    ('running', 'succeeded', 'failed', 'uncertain', 'cancelled', 'lease_lost')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$'),
  usage jsonb,
  usage_completeness text NOT NULL DEFAULT 'unknown' CHECK (usage_completeness IN
    ('none', 'complete', 'partial', 'unknown')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT learning_task_attempts_number UNIQUE (task_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS learning_task_attempts_owner
  ON learning_task_attempts (owner_id, started_at DESC);
`;

const STUDY_MATERIAL_TABLES = [
  'study_materials',
  'study_material_versions',
  'study_material_artifacts',
  'study_space_materials',
  'study_session_material_refs',
  'learning_tasks',
  'learning_task_attempts',
];

/**
 * Hosted capacity seam with learning-task roots added to every operation.
 * Body is v11's verbatim except for the four `learning_tasks` branches.
 */
const HEAVY_TASK_CAPACITY_WITH_LEARNING_TASKS = `
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
      UNION
      SELECT owner_id, root_task_id
        FROM public.learning_tasks
       WHERE status='running' AND lease_expires_at > clock_timestamp()
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
      UNION
      SELECT owner_id, root_task_id FROM public.learning_tasks WHERE status='queued'
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
    UNION
    SELECT owner_id, root_task_id FROM public.learning_tasks
     WHERE status='running' AND lease_expires_at > clock_timestamp()
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
    SELECT owner_id,root_task_id,created_at FROM public.learning_tasks
     WHERE ((status='queued' AND updated_at > to_timestamp(p_queue_fresh_after/1000.0))
        OR (status='retry_wait' AND available_at <= clock_timestamp()))
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

REVOKE ALL ON FUNCTION app_internal.heavy_task_capacity(text,text,text,bigint,bigint,bigint,bigint,bigint,integer,integer,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.heavy_task_capacity(text,text,text,bigint,bigint,bigint,bigint,bigint,integer,integer,boolean) TO app_web, app_worker;
`;

export const ACCOUNTS_MIGRATION_23 = `${STUDY_TABLES_SQL_V23}
DO $study_materials_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_MATERIAL_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_materials_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.study_materials, public.study_material_versions, public.study_material_artifacts,
  public.study_space_materials, public.study_session_material_refs, public.learning_tasks
TO app_web;
GRANT SELECT ON TABLE public.learning_task_attempts TO app_web;

GRANT SELECT ON TABLE public.study_materials, public.study_session_material_refs TO app_worker;
GRANT SELECT, UPDATE ON TABLE public.study_material_versions, public.learning_tasks TO app_worker;
GRANT SELECT, INSERT ON TABLE public.study_material_artifacts TO app_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.learning_task_attempts TO app_worker;

DROP POLICY IF EXISTS study_materials_web_all ON public.study_materials;
CREATE POLICY study_materials_web_all ON public.study_materials
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_material_versions_web_all ON public.study_material_versions;
CREATE POLICY study_material_versions_web_all ON public.study_material_versions
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.owner_material upload
      WHERE upload.id = study_material_versions.owner_material_id
        AND upload.owner_id = app_internal.current_owner_id()
        AND upload.status = 'ready'
        AND upload.deleted_at IS NULL
        AND upload.oss_key = study_material_versions.object_key
    )
  );

DROP POLICY IF EXISTS study_material_artifacts_web_all ON public.study_material_artifacts;
CREATE POLICY study_material_artifacts_web_all ON public.study_material_artifacts
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_space_materials_web_all ON public.study_space_materials;
CREATE POLICY study_space_materials_web_all ON public.study_space_materials
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_session_material_refs_web_all ON public.study_session_material_refs;
CREATE POLICY study_session_material_refs_web_all ON public.study_session_material_refs
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.agent_sessions session
      WHERE session.id = study_session_material_refs.session_id
        AND session.owner_id = app_internal.current_owner_id()
        AND session.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS learning_tasks_web_all ON public.learning_tasks;
CREATE POLICY learning_tasks_web_all ON public.learning_tasks
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS learning_task_attempts_web_select ON public.learning_task_attempts;
CREATE POLICY learning_task_attempts_web_select ON public.learning_task_attempts
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_materials_worker_select ON public.study_materials;
CREATE POLICY study_materials_worker_select ON public.study_materials
  FOR SELECT TO app_worker USING (true);

DROP POLICY IF EXISTS study_material_versions_worker_select ON public.study_material_versions;
CREATE POLICY study_material_versions_worker_select ON public.study_material_versions
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_material_versions_worker_update ON public.study_material_versions;
CREATE POLICY study_material_versions_worker_update ON public.study_material_versions
  FOR UPDATE TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS study_material_artifacts_worker_select ON public.study_material_artifacts;
CREATE POLICY study_material_artifacts_worker_select ON public.study_material_artifacts
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_material_artifacts_worker_insert ON public.study_material_artifacts;
CREATE POLICY study_material_artifacts_worker_insert ON public.study_material_artifacts
  FOR INSERT TO app_worker WITH CHECK (true);

DROP POLICY IF EXISTS study_session_material_refs_worker_select ON public.study_session_material_refs;
CREATE POLICY study_session_material_refs_worker_select ON public.study_session_material_refs
  FOR SELECT TO app_worker USING (true);

DROP POLICY IF EXISTS learning_tasks_worker_select ON public.learning_tasks;
CREATE POLICY learning_tasks_worker_select ON public.learning_tasks
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS learning_tasks_worker_update ON public.learning_tasks;
CREATE POLICY learning_tasks_worker_update ON public.learning_tasks
  FOR UPDATE TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS learning_task_attempts_worker_all ON public.learning_task_attempts;
CREATE POLICY learning_task_attempts_worker_all ON public.learning_task_attempts
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION app_internal.learning_task_readiness()
RETURNS TABLE(worker_live boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $learning_task_readiness$
  SELECT EXISTS (
    SELECT 1 FROM public.generation_worker_heartbeats
     WHERE heartbeat_at > clock_timestamp() - interval '30 seconds'
       AND NOT draining
       AND pipeline_versions @> '["learning-tasks-v1"]'::jsonb
  )
$learning_task_readiness$;

REVOKE ALL ON FUNCTION app_internal.learning_task_readiness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.learning_task_readiness() TO app_web, app_worker;
${HEAVY_TASK_CAPACITY_WITH_LEARNING_TASKS}`;
