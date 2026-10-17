/**
 * v31: the wrong-answer book (learning plan B10).
 *
 * - study_wrong_items: one question the student got wrong in one study
 *   space, identified by `question_key` (a question-bank question, a
 *   classroom quiz question, a learning-check question). Holds only what the
 *   student sets — "to review" and archived — plus the knowledge points used
 *   for filtering. A course in two spaces gives each space its own item.
 * - study_wrong_occurrences: every graded answer to that question, keyed by
 *   its source (`exam:<attempt>:<position>`, `quiz:<session>:<question>`,
 *   `check:<attempt>:<question>`), so replaying a projection never adds a
 *   second row. Each row keeps the question as it was asked, the student's
 *   answer and the grading it got; a later answer is a new row, never an
 *   overwrite. Correct answers are kept only after a first wrong one (the
 *   history of an item). `digest` lets a replay skip unchanged rows; a row
 *   changes only when its grading changes (a review of an open item).
 *   Rows of a paper attempt cascade from the attempt; course rows cascade
 *   from the course.
 *
 * Owner isolation: web reads and writes owner-bound (app.owner_id); workers
 * have no access (a classmate chat about a wrong question carries a bounded
 * copy of it in its own origin). Account deletion runs as the migration
 * administrator.
 *
 * STUDY_TABLES_SQL_V31 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_WRONGBOOK_TABLES = ['study_wrong_items', 'study_wrong_occurrences'] as const;

export const STUDY_TABLES_SQL_V31 = `
CREATE TABLE IF NOT EXISTS study_wrong_items (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  question_key text NOT NULL CHECK (char_length(question_key) BETWEEN 1 AND 300),
  source_type text NOT NULL CHECK (source_type IN ('exam_attempt', 'quiz_attempt', 'learning_check')),
  stage_id text REFERENCES document_stages(id) ON DELETE CASCADE,
  concepts text[] NOT NULL DEFAULT '{}' CHECK (cardinality(concepts) <= 20),
  review_state text NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'to_review')),
  archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_wrong_items_question UNIQUE (owner_id, space_id, question_key),
  CONSTRAINT study_wrong_items_stage CHECK ((source_type = 'exam_attempt') = (stage_id IS NULL)),
  CONSTRAINT study_wrong_items_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_wrong_occurrences (
  owner_id text NOT NULL,
  item_id text NOT NULL,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 300),
  attempt_id text,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('incorrect', 'partial', 'unanswered', 'correct')),
  earned numeric NOT NULL CHECK (earned >= 0),
  points numeric NOT NULL CHECK (points > 0 AND earned <= points),
  question jsonb NOT NULL CHECK (
    jsonb_typeof(question) = 'object' AND octet_length(question::text) <= 40000
  ),
  response jsonb CHECK (response IS NULL OR octet_length(response::text) <= 20000),
  grading jsonb NOT NULL CHECK (
    jsonb_typeof(grading) = 'object' AND octet_length(grading::text) <= 20000
  ),
  origin jsonb NOT NULL CHECK (
    jsonb_typeof(origin) = 'object' AND octet_length(origin::text) <= 4000
  ),
  digest text NOT NULL CHECK (char_length(digest) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, item_id, source_key),
  CONSTRAINT study_wrong_occurrences_item_fk FOREIGN KEY (owner_id, item_id)
    REFERENCES study_wrong_items (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_wrong_occurrences_attempt_fk FOREIGN KEY (owner_id, attempt_id)
    REFERENCES study_exam_attempts (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_wrong_occurrences_item_time
  ON study_wrong_occurrences (owner_id, item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS study_wrong_occurrences_attempt
  ON study_wrong_occurrences (owner_id, attempt_id) WHERE attempt_id IS NOT NULL;
`;

export const ACCOUNTS_MIGRATION_31 = `${STUDY_TABLES_SQL_V31}
ALTER TABLE public.study_wrong_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_wrong_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.study_wrong_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_wrong_occurrences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.study_wrong_items, public.study_wrong_occurrences
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.study_wrong_items, public.study_wrong_occurrences TO app_web;

DROP POLICY IF EXISTS study_wrong_items_web_owner ON public.study_wrong_items;
CREATE POLICY study_wrong_items_web_owner ON public.study_wrong_items
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_wrong_occurrences_web_owner ON public.study_wrong_occurrences;
CREATE POLICY study_wrong_occurrences_web_owner ON public.study_wrong_occurrences
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
`;
