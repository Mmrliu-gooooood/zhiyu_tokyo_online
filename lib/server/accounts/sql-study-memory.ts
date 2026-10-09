/**
 * v27: learning events, editable preferences and Memory controls (learning
 * plan B06).
 *
 * - study_learning_events: small, versioned records derived by rule from
 *   facts the server already saved (course progress, classroom quiz
 *   attempts, after-class chat messages). `source_key` is unique per owner,
 *   so replaying a projection never duplicates an event. Events are
 *   immutable: web may insert and delete, never update. `seq` is the
 *   watermark later summaries (B12) compare against. Watching a course is a
 *   viewing record, never mastery evidence.
 * - study_learner_preferences: explicit preferences and goals (explanation
 *   length, example or definition first, hint first or direct), global or
 *   for one study space. Written only from the settings page or a prompt the
 *   student confirmed — never inferred from chats.
 * - study_memory_facts: short statements the student wrote or confirmed
 *   ("我在准备期中考试"), plus corrections attached to a learning record.
 * - study_memory_controls: the global personalisation switch and one switch
 *   per study space. No row = on. `enabled_since` marks the last time a
 *   switch was turned on: facts from before it (the off period) are never
 *   projected afterwards.
 * - study_memory_suppressions: what the student deleted or dismissed (an
 *   event's source key, a preference value, a suggestion), so a later
 *   projection, suggestion or summary rebuild cannot bring it back.
 *
 * Owner isolation: web reads and writes owner-bound (app.owner_id); an event
 * naming a course also requires the course to be the owner's live course.
 * The generation worker (the after-class chat runner) only reads controls,
 * preferences and facts, with the owner named in every query. Account
 * deletion runs as the migration administrator.
 *
 * STUDY_TABLES_SQL_V27 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same table text via `ensureStudySchema`.
 */
export const STUDY_MEMORY_TABLES = [
  'study_learning_events',
  'study_learner_preferences',
  'study_memory_facts',
  'study_memory_controls',
  'study_memory_suppressions',
] as const;

export const STUDY_TABLES_SQL_V27 = `
CREATE TABLE IF NOT EXISTS study_learning_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z_]{2,39}$'),
  payload_version smallint NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  source_type text NOT NULL CHECK (source_type ~ '^[a-z][a-z_]{2,39}$'),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 300),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 400),
  stage_id text REFERENCES document_stages(id) ON DELETE CASCADE,
  space_id text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4000
  ),
  CONSTRAINT study_learning_events_source_key UNIQUE (owner_id, source_key),
  CONSTRAINT study_learning_events_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_learning_events_owner_occurred
  ON study_learning_events (owner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS study_learning_events_owner_stage
  ON study_learning_events (owner_id, stage_id);

CREATE TABLE IF NOT EXISTS study_learner_preferences (
  owner_id text NOT NULL,
  space_id text,
  pref_key text NOT NULL CHECK (
    pref_key IN ('explanation_length', 'example_order', 'hint_mode', 'learning_goal')
  ),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 300),
  origin text NOT NULL CHECK (origin IN ('settings', 'confirmed_prompt')),
  evidence jsonb CHECK (
    evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 1000)
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_learner_preferences_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS study_learner_preferences_scope_key
  ON study_learner_preferences (owner_id, (COALESCE(space_id, '')), pref_key);

CREATE TABLE IF NOT EXISTS study_memory_facts (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  space_id text,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
  origin text NOT NULL CHECK (origin IN ('manual', 'confirmed_prompt', 'correction')),
  corrects_key text CHECK (corrects_key IS NULL OR char_length(corrects_key) <= 400),
  evidence jsonb CHECK (
    evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 1000)
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_memory_facts_correction CHECK ((origin = 'correction') = (corrects_key IS NOT NULL)),
  CONSTRAINT study_memory_facts_owner_id_key UNIQUE (owner_id, id),
  CONSTRAINT study_memory_facts_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_memory_facts_owner_updated
  ON study_memory_facts (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS study_memory_controls (
  owner_id text NOT NULL,
  space_id text,
  enabled boolean NOT NULL,
  enabled_since timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_memory_controls_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS study_memory_controls_scope
  ON study_memory_controls (owner_id, (COALESCE(space_id, '')));

CREATE TABLE IF NOT EXISTS study_memory_suppressions (
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'preference', 'suggestion', 'summary')),
  target_key text NOT NULL CHECK (char_length(target_key) BETWEEN 1 AND 400),
  reason text NOT NULL CHECK (reason IN ('deleted', 'dismissed', 'cleared')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, kind, target_key)
);
`;

export const ACCOUNTS_MIGRATION_27 = `${STUDY_TABLES_SQL_V27}
DO $study_memory_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_MEMORY_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_memory_rls$;

GRANT SELECT, INSERT, DELETE ON TABLE public.study_learning_events TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.study_learner_preferences, public.study_memory_facts, public.study_memory_controls
TO app_web;
GRANT SELECT, INSERT, DELETE ON TABLE public.study_memory_suppressions TO app_web;
GRANT SELECT ON TABLE
  public.study_learner_preferences, public.study_memory_facts, public.study_memory_controls
TO app_worker;

DROP POLICY IF EXISTS study_learning_events_web_select ON public.study_learning_events;
CREATE POLICY study_learning_events_web_select ON public.study_learning_events
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_learning_events_web_insert ON public.study_learning_events;
CREATE POLICY study_learning_events_web_insert ON public.study_learning_events
  FOR INSERT TO app_web
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND (
      stage_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.stage_meta m
        WHERE m.stage_id = study_learning_events.stage_id
          AND m.owner_id = app_internal.current_owner_id()
          AND m.deleted_at IS NULL
      )
    )
  );
DROP POLICY IF EXISTS study_learning_events_web_delete ON public.study_learning_events;
CREATE POLICY study_learning_events_web_delete ON public.study_learning_events
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_learner_preferences_web_all ON public.study_learner_preferences;
CREATE POLICY study_learner_preferences_web_all ON public.study_learner_preferences
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_memory_facts_web_all ON public.study_memory_facts;
CREATE POLICY study_memory_facts_web_all ON public.study_memory_facts
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_memory_controls_web_all ON public.study_memory_controls;
CREATE POLICY study_memory_controls_web_all ON public.study_memory_controls
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_memory_suppressions_web_select ON public.study_memory_suppressions;
CREATE POLICY study_memory_suppressions_web_select ON public.study_memory_suppressions
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_memory_suppressions_web_insert ON public.study_memory_suppressions;
CREATE POLICY study_memory_suppressions_web_insert ON public.study_memory_suppressions
  FOR INSERT TO app_web
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_memory_suppressions_web_delete ON public.study_memory_suppressions;
CREATE POLICY study_memory_suppressions_web_delete ON public.study_memory_suppressions
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_learner_preferences_worker_select ON public.study_learner_preferences;
CREATE POLICY study_learner_preferences_worker_select ON public.study_learner_preferences
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_memory_facts_worker_select ON public.study_memory_facts;
CREATE POLICY study_memory_facts_worker_select ON public.study_memory_facts
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_memory_controls_worker_select ON public.study_memory_controls;
CREATE POLICY study_memory_controls_worker_select ON public.study_memory_controls
  FOR SELECT TO app_worker USING (true);
`;
