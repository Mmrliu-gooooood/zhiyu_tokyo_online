/**
 * v33: review tasks, mastery evidence and short Memory summaries (learning
 * plan B12).
 *
 * - study_review_cards: one card per wrong-answer item. Everything in it is
 *   derived again from the item's graded answers (v31 occurrences) and the
 *   student's own review actions, so a regrade or a new answer recomputes it:
 *   the FSRS state that decides *when* to review (`card`, `fsrs_due_at`), the
 *   evidence rule that decides what the answers show (`evidence_state`), and
 *   the digest of the inputs (`input_digest` + `rule_version`), so an
 *   unchanged item is not recomputed. `actions` is the only thing the student
 *   writes: done, postponed to a date, rescheduled, skipped (bounded list).
 * - study_review_settings: per space, how many minutes a day the student has
 *   for review (the daily list is cut to it).
 * - study_memory_summaries: per space, a short model-written summary of the
 *   recent learning records, rebuilt only when its inputs changed (`input_hash`
 *   over the records up to `source_watermark`, `policy_version`). A failed
 *   attempt keeps a row without text so the page does not retry at once.
 *   Deleting or correcting records, turning Memory off or a regrade deletes
 *   the row; it is derived data and never overrides grading facts.
 *
 * Owner isolation as in v27–v32: web reads and writes owner-bound. The
 * generation worker (the after-class chat runner) reads summaries — as it
 * reads preferences and facts — with the owner named in every query. Account
 * deletion runs as the migration administrator; every row cascades from its
 * space (cards also from their wrong item).
 *
 * STUDY_TABLES_SQL_V33 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_REVIEW_TABLES = [
  'study_review_cards',
  'study_review_settings',
  'study_memory_summaries',
] as const;

export const STUDY_TABLES_SQL_V33 = `
CREATE TABLE IF NOT EXISTS study_review_cards (
  owner_id text NOT NULL,
  item_id text NOT NULL,
  space_id text NOT NULL,
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 80),
  input_digest text NOT NULL CHECK (char_length(input_digest) BETWEEN 1 AND 100),
  card jsonb NOT NULL CHECK (jsonb_typeof(card) = 'object' AND octet_length(card::text) <= 2000),
  fsrs_due_at timestamptz NOT NULL,
  evidence_state text NOT NULL CHECK (
    evidence_state IN ('pending', 'practiced', 'helped', 'independent', 'stable')
  ),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4000
  ),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(actions) = 'array' AND octet_length(actions::text) <= 8000
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, item_id),
  CONSTRAINT study_review_cards_item_fk FOREIGN KEY (owner_id, item_id)
    REFERENCES study_wrong_items (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_review_cards_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_review_cards_owner_space_due
  ON study_review_cards (owner_id, space_id, fsrs_due_at);

CREATE TABLE IF NOT EXISTS study_review_settings (
  owner_id text NOT NULL,
  space_id text NOT NULL,
  daily_minutes smallint NOT NULL CHECK (daily_minutes BETWEEN 5 AND 600),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, space_id),
  CONSTRAINT study_review_settings_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_memory_summaries (
  owner_id text NOT NULL,
  space_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed')),
  text text CHECK (text IS NULL OR char_length(text) BETWEEN 1 AND 400),
  source_watermark bigint,
  input_hash text NOT NULL CHECK (char_length(input_hash) BETWEEN 1 AND 128),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  model text CHECK (model IS NULL OR char_length(model) <= 160),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, space_id),
  CONSTRAINT study_memory_summaries_text CHECK ((status = 'ready') = (text IS NOT NULL)),
  CONSTRAINT study_memory_summaries_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
`;

export const ACCOUNTS_MIGRATION_33 = `${STUDY_TABLES_SQL_V33}
DO $study_review_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_REVIEW_TABLES.map((table) => `'${table}'`).join(', ')}]
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
$study_review_rls$;

GRANT SELECT ON TABLE public.study_memory_summaries TO app_worker;
DROP POLICY IF EXISTS study_memory_summaries_worker_select ON public.study_memory_summaries;
CREATE POLICY study_memory_summaries_worker_select ON public.study_memory_summaries
  FOR SELECT TO app_worker USING (true);
`;
