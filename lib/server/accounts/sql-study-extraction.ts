/**
 * v29: exercise extraction from study materials (learning plan B08).
 *
 * - study_question_extractions: one extraction of a page range of one parsed
 *   material version (the artifact it read is named, so a later re-parse never
 *   changes what the candidates point at). `request_key` = version + artifact
 *   + page range + strategy and is unique per space, so asking again returns
 *   the same extraction. `stats` records what the extractor saw (scanned pages
 *   without text, unmatched answers, unassigned figures, duration); `usage`
 *   adds up the optional model help (calls, tokens).
 * - study_question_candidates: the draft questions of an extraction with
 *   their source lines and pages, the extractor's own result (`original`, for
 *   "restore"), the answer evidence (`missing` / `source` / `model` / `user`)
 *   and a model suggestion kept apart from the answer. The student edits,
 *   splits, merges, discards and finally commits them into the question bank
 *   (`question_id` then names the bank question).
 * - study_question_versions.figures: up to four figure references (material
 *   version image ids) shown with a question; null for every earlier version.
 *
 * Both tables cascade from the space and from the parsed artifact (so
 * deleting the material removes its extractions). Owner isolation as in v28:
 * web owner-bound, no worker access (extraction runs in web), account
 * deletion as the migration administrator.
 *
 * STUDY_TABLES_SQL_V29 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_EXTRACTION_TABLES = [
  'study_question_extractions',
  'study_question_candidates',
] as const;

export const STUDY_TABLES_SQL_V29 = `
ALTER TABLE study_question_versions ADD COLUMN IF NOT EXISTS figures jsonb;
DO $study_question_figures$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_question_versions_figures'
       AND conrelid = 'study_question_versions'::regclass
  ) THEN
    ALTER TABLE study_question_versions ADD CONSTRAINT study_question_versions_figures CHECK (
      figures IS NULL OR (
        jsonb_typeof(figures) = 'array'
        AND jsonb_array_length(figures) BETWEEN 1 AND 4
        AND octet_length(figures::text) <= 2000
      )
    );
  END IF;
END
$study_question_figures$;

CREATE TABLE IF NOT EXISTS study_question_extractions (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  material_id text NOT NULL CHECK (char_length(material_id) BETWEEN 1 AND 64),
  version_id text NOT NULL CHECK (char_length(version_id) BETWEEN 1 AND 64),
  artifact_id text NOT NULL,
  page_from integer CHECK (page_from IS NULL OR page_from >= 1),
  page_to integer CHECK (page_to IS NULL OR page_to >= 1),
  strategy text NOT NULL CHECK (char_length(strategy) BETWEEN 1 AND 40),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object' AND octet_length(stats::text) <= 16000),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 2000
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_question_extractions_pages CHECK (
    (page_from IS NULL AND page_to IS NULL)
    OR (page_from IS NOT NULL AND page_to IS NOT NULL AND page_to >= page_from)
  ),
  CONSTRAINT study_question_extractions_request UNIQUE (owner_id, space_id, request_key),
  CONSTRAINT study_question_extractions_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_question_extractions_artifact_fk FOREIGN KEY (owner_id, artifact_id)
    REFERENCES study_material_artifacts (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_question_extractions_owner_space
  ON study_question_extractions (owner_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_question_candidates (
  owner_id text NOT NULL,
  extraction_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'discarded', 'committed')),
  label text CHECK (label IS NULL OR char_length(label) <= 40),
  section text CHECK (section IS NULL OR char_length(section) <= 120),
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 64000
  ),
  original jsonb NOT NULL CHECK (
    jsonb_typeof(original) = 'object' AND octet_length(original::text) <= 64000
  ),
  source_lines jsonb NOT NULL CHECK (
    jsonb_typeof(source_lines) = 'array' AND octet_length(source_lines::text) <= 32000
  ),
  pages integer[] NOT NULL CHECK (cardinality(pages) BETWEEN 1 AND 20),
  answer_basis text NOT NULL CHECK (answer_basis IN ('missing', 'source', 'model', 'user')),
  answer_ref jsonb CHECK (
    answer_ref IS NULL OR (jsonb_typeof(answer_ref) = 'object' AND octet_length(answer_ref::text) <= 1000)
  ),
  suggestion jsonb CHECK (
    suggestion IS NULL OR (jsonb_typeof(suggestion) = 'object' AND octet_length(suggestion::text) <= 8000)
  ),
  checked boolean NOT NULL DEFAULT false,
  question_id text CHECK (question_id IS NULL OR char_length(question_id) <= 64),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_question_candidates_committed CHECK (
    (status = 'committed') = (question_id IS NOT NULL)
  ),
  CONSTRAINT study_question_candidates_extraction_fk FOREIGN KEY (owner_id, extraction_id)
    REFERENCES study_question_extractions (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_question_candidates_owner_extraction
  ON study_question_candidates (owner_id, extraction_id, position);
`;

export const ACCOUNTS_MIGRATION_29 = `${STUDY_TABLES_SQL_V29}
DO $study_extraction_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_EXTRACTION_TABLES.map((table) => `'${table}'`).join(', ')}]
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_web_update', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO app_web USING (owner_id = app_internal.current_owner_id()) WITH CHECK (owner_id = app_internal.current_owner_id())',
      tbl || '_web_update', tbl
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_web_delete', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO app_web USING (owner_id = app_internal.current_owner_id())',
      tbl || '_web_delete', tbl
    );
  END LOOP;
END
$study_extraction_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.study_question_extractions, public.study_question_candidates TO app_web;
`;
