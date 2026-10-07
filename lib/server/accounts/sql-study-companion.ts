/**
 * v26: after-class classmate chats (learning plan B05).
 *
 * - study_companion_chats: marks a durable agent session as an after-class
 *   chat with one classmate inside one study space. The session itself
 *   (prompt, events, entry tree, resume) stays in the agent-session tables;
 *   this row only adds purpose, space and classmate, plus the classroom
 *   origin it was opened from. The runner reads it when it claims a session
 *   and switches to the companion prompt and toolset. Rows are immutable:
 *   a chat never moves to another space or classmate.
 * - study_classmates.model_policy: an optional independent answer model for
 *   live answers (null = inherit the session / global model). It names an
 *   existing connection (platform default, saved credential id or a
 *   server-configured provider), never an API key.
 * - Worker read grants: the runner (generation worker) resolves a chat's
 *   material scope itself, so it reads spaces, space links and classmate
 *   material links, and may call the keyword/hybrid search function. Like the
 *   other worker grants its queries name the owner explicitly.
 *
 * Owner isolation: web reads, inserts and deletes chats owner-bound
 * (app.owner_id); the worker only reads. Account deletion runs as the
 * migration administrator.
 *
 * STUDY_TABLES_SQL_V26 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same table text via `ensureStudySchema`.
 */
export const STUDY_COMPANION_TABLES = ['study_companion_chats'] as const;

export const STUDY_TABLES_SQL_V26 = `
ALTER TABLE study_classmates ADD COLUMN IF NOT EXISTS model_policy jsonb
  CHECK (model_policy IS NULL OR jsonb_typeof(model_policy) = 'object');

CREATE TABLE IF NOT EXISTS study_companion_chats (
  session_id text PRIMARY KEY CHECK (char_length(session_id) BETWEEN 1 AND 128),
  owner_id text NOT NULL,
  space_id text NOT NULL,
  classmate_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'after_class_qa' CHECK (purpose IN ('after_class_qa')),
  origin jsonb CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_companion_chats_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_companion_chats_classmate_fk FOREIGN KEY (owner_id, classmate_id)
    REFERENCES study_classmates (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_companion_chats_owner_classmate
  ON study_companion_chats (owner_id, classmate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS study_companion_chats_owner_space
  ON study_companion_chats (owner_id, space_id, created_at DESC);
`;

export const ACCOUNTS_MIGRATION_26 = `${STUDY_TABLES_SQL_V26}
DO $study_companion_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_COMPANION_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_companion_rls$;

GRANT SELECT, INSERT, DELETE ON TABLE public.study_companion_chats TO app_web;
GRANT SELECT ON TABLE public.study_companion_chats TO app_worker;
GRANT SELECT ON TABLE
  public.study_spaces, public.study_space_materials, public.study_space_courses,
  public.study_classmate_materials
TO app_worker;

DROP POLICY IF EXISTS study_companion_chats_web_select ON public.study_companion_chats;
CREATE POLICY study_companion_chats_web_select ON public.study_companion_chats
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_companion_chats_web_insert ON public.study_companion_chats;
CREATE POLICY study_companion_chats_web_insert ON public.study_companion_chats
  FOR INSERT TO app_web
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_companion_chats_web_delete ON public.study_companion_chats;
CREATE POLICY study_companion_chats_web_delete ON public.study_companion_chats
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_companion_chats_worker_select ON public.study_companion_chats;
CREATE POLICY study_companion_chats_worker_select ON public.study_companion_chats
  FOR SELECT TO app_worker USING (true);

DROP POLICY IF EXISTS study_spaces_worker_select ON public.study_spaces;
CREATE POLICY study_spaces_worker_select ON public.study_spaces
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_space_materials_worker_select ON public.study_space_materials;
CREATE POLICY study_space_materials_worker_select ON public.study_space_materials
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_space_courses_worker_select ON public.study_space_courses;
CREATE POLICY study_space_courses_worker_select ON public.study_space_courses
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_classmate_materials_worker_select ON public.study_classmate_materials;
CREATE POLICY study_classmate_materials_worker_select ON public.study_classmate_materials
  FOR SELECT TO app_worker USING (true);

-- The search function exists only where vector and pgroonga were available (v24).
DO $study_companion_search_grant$
BEGIN
  IF to_regprocedure('public.study_knowledge_search(text,text[],text[],text,integer,integer)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.study_knowledge_search(text,text[],text[],text,integer,integer) TO app_worker';
  END IF;
END
$study_companion_search_grant$;
`;
