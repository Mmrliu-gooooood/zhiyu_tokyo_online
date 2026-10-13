/**
 * v30: open questions and assisted grading (learning plan B09).
 *
 * - study_question_versions.subtype + guide: an open question
 *   (`qtype = 'short_answer'`) is a short answer, calculation or proof and
 *   carries its grading guide (reference answer, a calculation's final
 *   answer, scoring points) instead of options and a key. Choice versions
 *   keep both null.
 * - study_exam_items.guide: the guide frozen with the paper, read only for
 *   grading and the submitted report (like `answer_key`).
 * - study_exam_attempts.answers: open answers are text, so the stored answer
 *   set may now be up to 120 KB (was 12 KB).
 * - study_exam_gradings: one row per grading of one open item of a submitted
 *   attempt. `auto` is created at submission, `review` when the student asks
 *   for another look (earlier rows stay), `self` is the student's own score.
 *   A row is claimed (`running` with a lease) before the model is called, so
 *   a repeated or concurrent request never grades the same row twice; a
 *   succeeded row can no longer be changed (the update policy only matches
 *   unfinished rows). `usage` records the calls and tokens it took.
 *
 * Owner isolation as in v28: web owner-bound, no worker access (grading runs
 * in web), account deletion as the migration administrator; rows cascade
 * from their attempt.
 *
 * STUDY_TABLES_SQL_V30 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_GRADING_TABLES = ['study_exam_gradings'] as const;

export const STUDY_TABLES_SQL_V30 = `
ALTER TABLE study_question_versions ADD COLUMN IF NOT EXISTS subtype text;
ALTER TABLE study_question_versions ADD COLUMN IF NOT EXISTS guide jsonb;
ALTER TABLE study_exam_items ADD COLUMN IF NOT EXISTS guide jsonb;
DO $study_open_questions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_question_versions_open'
       AND conrelid = 'study_question_versions'::regclass
  ) THEN
    ALTER TABLE study_question_versions ADD CONSTRAINT study_question_versions_open CHECK (
      (qtype = 'short_answer') = (subtype IS NOT NULL)
      AND (subtype IS NULL OR subtype IN ('short', 'calculation', 'proof'))
      AND (guide IS NULL OR qtype = 'short_answer')
      AND (guide IS NULL OR (jsonb_typeof(guide) = 'object' AND octet_length(guide::text) <= 16000))
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_exam_items_guide'
       AND conrelid = 'study_exam_items'::regclass
  ) THEN
    ALTER TABLE study_exam_items ADD CONSTRAINT study_exam_items_guide CHECK (
      guide IS NULL OR (jsonb_typeof(guide) = 'object' AND octet_length(guide::text) <= 16000)
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_exam_attempts_answers_check'
       AND conrelid = 'study_exam_attempts'::regclass
  ) THEN
    ALTER TABLE study_exam_attempts DROP CONSTRAINT study_exam_attempts_answers_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_exam_attempts_answers_size'
       AND conrelid = 'study_exam_attempts'::regclass
  ) THEN
    ALTER TABLE study_exam_attempts ADD CONSTRAINT study_exam_attempts_answers_size CHECK (
      jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 120000
    );
  END IF;
END
$study_open_questions$;

CREATE TABLE IF NOT EXISTS study_exam_gradings (
  owner_id text NOT NULL,
  attempt_id text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('auto', 'review', 'self')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  points smallint NOT NULL CHECK (points BETWEEN 1 AND 100),
  earned smallint CHECK (earned IS NULL OR earned >= 0),
  result jsonb CHECK (
    result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16000)
  ),
  grader jsonb CHECK (
    grader IS NULL OR (jsonb_typeof(grader) = 'object' AND octet_length(grader::text) <= 1000)
  ),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  error text CHECK (error IS NULL OR char_length(error) <= 80),
  tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 20),
  lease_until timestamptz,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 2000
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (owner_id, attempt_id, position, seq),
  CONSTRAINT study_exam_gradings_succeeded CHECK (
    (status = 'succeeded') = (earned IS NOT NULL AND completed_at IS NOT NULL)
    AND (earned IS NULL OR earned <= points)
    AND (status <> 'succeeded' OR kind = 'self' OR result IS NOT NULL)
  ),
  CONSTRAINT study_exam_gradings_self CHECK (kind <> 'self' OR status = 'succeeded'),
  CONSTRAINT study_exam_gradings_attempt_fk FOREIGN KEY (owner_id, attempt_id)
    REFERENCES study_exam_attempts (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_exam_gradings_open
  ON study_exam_gradings (owner_id, attempt_id) WHERE status IN ('pending', 'running', 'failed');
`;

export const ACCOUNTS_MIGRATION_30 = `${STUDY_TABLES_SQL_V30}
ALTER TABLE public.study_exam_gradings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_exam_gradings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.study_exam_gradings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.study_exam_gradings TO app_web;

DROP POLICY IF EXISTS study_exam_gradings_web_select ON public.study_exam_gradings;
CREATE POLICY study_exam_gradings_web_select ON public.study_exam_gradings
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_exam_gradings_web_insert ON public.study_exam_gradings;
CREATE POLICY study_exam_gradings_web_insert ON public.study_exam_gradings
  FOR INSERT TO app_web
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_exam_gradings_web_update ON public.study_exam_gradings;
CREATE POLICY study_exam_gradings_web_update ON public.study_exam_gradings
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id() AND status <> 'succeeded')
  WITH CHECK (owner_id = app_internal.current_owner_id());
`;
