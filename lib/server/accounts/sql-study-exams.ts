/**
 * v28: question bank, rule-built papers and objective attempts (learning
 * plan B07).
 *
 * - study_concepts: the flat knowledge-point list of one study space. Names
 *   are unique per space by their folded comparison key; questions refer to
 *   concepts by id, never by free text.
 * - study_questions + study_question_versions: a bank question and its
 *   immutable versions (web may insert versions, never update them). Editing
 *   adds a version and moves `current_version`. `source_fingerprint` is the
 *   content hash at creation (or the official pack question it was copied
 *   from) and is unique per space, so importing the same file again adds
 *   nothing. Origin and verification are separate columns. Deleting a
 *   question removes it and its versions; papers keep their own copies.
 * - study_exam_papers + study_exam_items: a published paper. Items freeze the
 *   question as shown (`snapshot`) apart from its key (`answer_key`,
 *   `explanation`), so the API can serve the view without the key. Both are
 *   immutable; deleting a paper removes its items and attempts.
 *   `idempotency_key` makes publishing a retry-safe single write.
 * - study_exam_attempts: one sitting of a paper. Drafts are saved with a
 *   revision check; submitting freezes the answers with the grading. The
 *   update policy only matches open attempts, so a submitted attempt cannot be
 *   changed even by a buggy query. At most one open attempt per paper.
 *
 * Owner isolation: web reads and writes owner-bound (app.owner_id); child
 * rows carry the owner and reference their parent through (owner_id, id).
 * The worker has no access (nothing in B07 runs in the background). Account
 * deletion runs as the migration administrator.
 *
 * STUDY_TABLES_SQL_V28 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same table text via `ensureStudySchema`.
 */
export const STUDY_EXAM_TABLES = [
  'study_concepts',
  'study_questions',
  'study_question_versions',
  'study_exam_papers',
  'study_exam_items',
  'study_exam_attempts',
] as const;

export const STUDY_TABLES_SQL_V28 = `
CREATE TABLE IF NOT EXISTS study_concepts (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_concepts_name UNIQUE (owner_id, space_id, name_key),
  CONSTRAINT study_concepts_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_questions (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  origin text NOT NULL CHECK (
    origin IN ('user_import', 'manual', 'official', 'public_source', 'ai_generated', 'material_extracted')
  ),
  source_fingerprint text NOT NULL CHECK (char_length(source_fingerprint) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  stage_id text REFERENCES document_stages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_questions_fingerprint UNIQUE (owner_id, space_id, source_fingerprint),
  CONSTRAINT study_questions_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_questions_owner_space
  ON study_questions (owner_id, space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS study_question_versions (
  owner_id text NOT NULL,
  question_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  qtype text NOT NULL CHECK (qtype IN ('single', 'multiple', 'short_answer')),
  stem text NOT NULL CHECK (char_length(stem) BETWEEN 1 AND 4000),
  options jsonb NOT NULL CHECK (
    jsonb_typeof(options) = 'array' AND octet_length(options::text) <= 16000
  ),
  answer jsonb NOT NULL CHECK (jsonb_typeof(answer) = 'array' AND octet_length(answer::text) <= 200),
  explanation text CHECK (explanation IS NULL OR char_length(explanation) <= 4000),
  concept_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(concept_ids) <= 8),
  difficulty smallint CHECK (difficulty IS NULL OR difficulty BETWEEN 1 AND 5),
  points smallint NOT NULL DEFAULT 1 CHECK (points BETWEEN 1 AND 100),
  source jsonb CHECK (
    source IS NULL OR (jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 2000)
  ),
  verification text NOT NULL CHECK (
    verification IN ('unverified', 'user_verified', 'official_verified')
  ),
  gradable boolean NOT NULL,
  content_hash text NOT NULL CHECK (char_length(content_hash) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, question_id, version),
  CONSTRAINT study_question_versions_question_fk FOREIGN KEY (owner_id, question_id)
    REFERENCES study_questions (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_exam_papers (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  mode text NOT NULL DEFAULT 'bank' CHECK (mode IN ('bank', 'ai', 'mixed')),
  blueprint jsonb NOT NULL CHECK (
    jsonb_typeof(blueprint) = 'object' AND octet_length(blueprint::text) <= 8000
  ),
  item_count smallint NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  total_points integer NOT NULL CHECK (total_points > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  request_hash text NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_exam_papers_idempotency UNIQUE (owner_id, idempotency_key),
  CONSTRAINT study_exam_papers_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_exam_papers_owner_space
  ON study_exam_papers (owner_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_exam_items (
  owner_id text NOT NULL,
  paper_id text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  question_id text,
  question_version integer,
  pack_question text CHECK (pack_question IS NULL OR char_length(pack_question) <= 200),
  content_hash text NOT NULL CHECK (char_length(content_hash) BETWEEN 1 AND 128),
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 24000
  ),
  answer_key jsonb NOT NULL CHECK (
    jsonb_typeof(answer_key) = 'array' AND octet_length(answer_key::text) <= 200
  ),
  explanation text CHECK (explanation IS NULL OR char_length(explanation) <= 4000),
  PRIMARY KEY (owner_id, paper_id, position),
  CONSTRAINT study_exam_items_origin CHECK (
    (question_id IS NOT NULL AND question_version IS NOT NULL AND pack_question IS NULL)
    OR (question_id IS NULL AND question_version IS NULL AND pack_question IS NOT NULL)
  ),
  CONSTRAINT study_exam_items_paper_fk FOREIGN KEY (owner_id, paper_id)
    REFERENCES study_exam_papers (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_exam_attempts (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  paper_id text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 12000
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  submit_key text CHECK (submit_key IS NULL OR char_length(submit_key) BETWEEN 8 AND 100),
  submitted_digest text CHECK (submitted_digest IS NULL OR char_length(submitted_digest) <= 128),
  grading jsonb CHECK (
    grading IS NULL OR (jsonb_typeof(grading) = 'object' AND octet_length(grading::text) <= 16000)
  ),
  earned integer,
  total_points integer,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_exam_attempts_submitted CHECK (
    (status = 'submitted') = (
      submitted_at IS NOT NULL AND grading IS NOT NULL AND submitted_digest IS NOT NULL
      AND earned IS NOT NULL AND total_points IS NOT NULL
    )
  ),
  CONSTRAINT study_exam_attempts_paper_fk FOREIGN KEY (owner_id, paper_id)
    REFERENCES study_exam_papers (owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS study_exam_attempts_open
  ON study_exam_attempts (owner_id, paper_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS study_exam_attempts_owner_paper
  ON study_exam_attempts (owner_id, paper_id, started_at DESC);
`;

export const ACCOUNTS_MIGRATION_28 = `${STUDY_TABLES_SQL_V28}
DO $study_exam_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_EXAM_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_web_select', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO app_web USING (owner_id = app_internal.current_owner_id())',
      tbl || '_web_select', tbl
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_web_insert', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO app_web WITH CHECK (owner_id = app_internal.current_owner_id())',
      tbl || '_web_insert', tbl
    );
  END LOOP;
END
$study_exam_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_concepts, public.study_questions TO app_web;
GRANT SELECT, INSERT ON TABLE public.study_question_versions, public.study_exam_items TO app_web;
GRANT SELECT, INSERT, DELETE ON TABLE public.study_exam_papers TO app_web;
GRANT SELECT, INSERT, UPDATE ON TABLE public.study_exam_attempts TO app_web;

DROP POLICY IF EXISTS study_concepts_web_update ON public.study_concepts;
CREATE POLICY study_concepts_web_update ON public.study_concepts
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_concepts_web_delete ON public.study_concepts;
CREATE POLICY study_concepts_web_delete ON public.study_concepts
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_questions_web_update ON public.study_questions;
CREATE POLICY study_questions_web_update ON public.study_questions
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_questions_web_delete ON public.study_questions;
CREATE POLICY study_questions_web_delete ON public.study_questions
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_exam_papers_web_delete ON public.study_exam_papers;
CREATE POLICY study_exam_papers_web_delete ON public.study_exam_papers
  FOR DELETE TO app_web
  USING (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_exam_attempts_web_update ON public.study_exam_attempts;
CREATE POLICY study_exam_attempts_web_update ON public.study_exam_attempts
  FOR UPDATE TO app_web
  USING (owner_id = app_internal.current_owner_id() AND status = 'in_progress')
  WITH CHECK (owner_id = app_internal.current_owner_id());
`;
