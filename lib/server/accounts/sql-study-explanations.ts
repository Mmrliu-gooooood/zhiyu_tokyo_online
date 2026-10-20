/**
 * v34: explanations of one wrong question on request (learning plan B13).
 *
 * - study_explanations: one row per explanation the student asked for, under
 *   its wrong-answer item. `request` is frozen when it is asked for: the
 *   question as last answered wrongly, the student's answer, the grading,
 *   the knowledge points, passages of the subject's materials (fixed
 *   versions) and the student's explanation preferences — built on the
 *   server, never taken from the client. `reuse_key` hashes those inputs
 *   with the format and language, so the same question with nothing changed
 *   returns the saved explanation instead of calling the model again.
 *   `content` holds the result (text, whiteboard steps, or an interactive
 *   page); a full course stays a course and is only referenced (`job_id`,
 *   `stage_id`). One request runs at a time (`lease_*`), cancel and retry
 *   move `status`.
 *
 * Explanations contain the student's own answers, so nothing is shared
 * across owners. Owner isolation as in v27–v33: web reads and writes
 * owner-bound; no worker access. Rows cascade from the wrong item (deleting
 * the source answer deletes what was written from it) and from the space.
 *
 * STUDY_TABLES_SQL_V34 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_EXPLANATION_TABLES = ['study_explanations'] as const;

export const STUDY_TABLES_SQL_V34 = `
CREATE TABLE IF NOT EXISTS study_explanations (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  item_id text NOT NULL,
  format text NOT NULL CHECK (format IN ('text', 'whiteboard', 'interactive', 'course')),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'ready', 'failed', 'cancelled')
  ),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  request jsonb NOT NULL CHECK (
    jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 60000
  ),
  reuse_key text NOT NULL CHECK (char_length(reuse_key) BETWEEN 1 AND 128),
  content jsonb CHECK (
    content IS NULL OR (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 600000)
  ),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  call_cap integer NOT NULL CHECK (call_cap BETWEEN 0 AND 10),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  model text CHECK (model IS NULL OR char_length(model) <= 160),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 10),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 80),
  lease_token text,
  lease_until timestamptz,
  job_id text CHECK (job_id IS NULL OR char_length(job_id) BETWEEN 1 AND 200),
  stage_id text CHECK (stage_id IS NULL OR char_length(stage_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_explanations_idempotency UNIQUE (owner_id, idempotency_key),
  CONSTRAINT study_explanations_ready CHECK (
    status <> 'ready' OR content IS NOT NULL OR (format = 'course' AND stage_id IS NOT NULL)
  ),
  CONSTRAINT study_explanations_item_fk FOREIGN KEY (owner_id, item_id)
    REFERENCES study_wrong_items (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_explanations_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_explanations_owner_item
  ON study_explanations (owner_id, item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS study_explanations_owner_space
  ON study_explanations (owner_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS study_explanations_owner_reuse
  ON study_explanations (owner_id, reuse_key) WHERE status = 'ready';
`;

export const ACCOUNTS_MIGRATION_34 = `${STUDY_TABLES_SQL_V34}
DO $study_explanation_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_EXPLANATION_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app_web', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_web_owner', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO app_web '
      'USING (owner_id = app_internal.current_owner_id()) '
      'WITH CHECK (owner_id = app_internal.current_owner_id())',
      tbl || '_web_owner',
      tbl
    );
  END LOOP;
END
$study_explanation_rls$;
`;
