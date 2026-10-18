/**
 * v32: AI top-ups, variants and practice assistance (learning plan B11).
 *
 * - study_practice_jobs: one request to write new questions with the
 *   student's model — the gap of a mixed paper, a whole AI paper, or
 *   variants of one wrong question. The student confirmed the plan (counts,
 *   types, materials, call cap) before the row exists; nothing calls a model
 *   without it. `evidence` freezes the material passages (and, for variants,
 *   the original question) the questions may be written from; `produced`
 *   lists the bank questions it added (origin `ai_generated`, never checked)
 *   and `rejected` what the program or the review turned down. `calls`
 *   never passes `call_cap`; a stopped job continues only when the student
 *   asks (at most twice). One step runs at a time (`lease_*`); a job feeds at
 *   most one paper (`paper_id`), and `idempotency_key` makes creating it a
 *   retry-safe single write.
 * - study_exam_attempts.assistance: per item, whether the question was new
 *   to the student when the attempt opened and when a hint or the solution
 *   was shown (practice papers only). Written by the server while the
 *   attempt is open (the update policy only matches open attempts), so a
 *   submitted attempt keeps what really happened.
 *
 * Owner isolation as in v28–v31: web owner-bound, no worker access (B11 runs
 * in web), account deletion as the migration administrator; jobs cascade
 * from their space.
 *
 * STUDY_TABLES_SQL_V32 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same text via `ensureStudySchema`.
 */
export const STUDY_PRACTICE_TABLES = ['study_practice_jobs'] as const;

export const STUDY_TABLES_SQL_V32 = `
CREATE TABLE IF NOT EXISTS study_practice_jobs (
  owner_id text NOT NULL,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
  space_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('paper', 'variant')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'stopped', 'cancelled')),
  request jsonb NOT NULL CHECK (
    jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 24000
  ),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 80000
  ),
  produced jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(produced) = 'array' AND octet_length(produced::text) <= 40000
  ),
  rejected jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(rejected) = 'array' AND octet_length(rejected::text) <= 40000
  ),
  request_hash text NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  calls smallint NOT NULL DEFAULT 0 CHECK (calls >= 0),
  call_cap smallint NOT NULL CHECK (call_cap BETWEEN 1 AND 60),
  continues smallint NOT NULL DEFAULT 0 CHECK (continues BETWEEN 0 AND 2),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  usage_known boolean NOT NULL DEFAULT true,
  models text[] NOT NULL DEFAULT '{}' CHECK (cardinality(models) <= 6),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 80),
  lease_token text CHECK (lease_token IS NULL OR char_length(lease_token) <= 64),
  lease_until timestamptz,
  steps smallint NOT NULL DEFAULT 0 CHECK (steps >= 0),
  paper_id text CHECK (paper_id IS NULL OR char_length(paper_id) <= 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT study_practice_jobs_idempotency UNIQUE (owner_id, idempotency_key),
  CONSTRAINT study_practice_jobs_calls CHECK (calls <= call_cap),
  CONSTRAINT study_practice_jobs_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_practice_jobs_owner_space
  ON study_practice_jobs (owner_id, space_id, created_at DESC);

ALTER TABLE study_exam_attempts ADD COLUMN IF NOT EXISTS assistance jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $study_attempt_assistance$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'study_exam_attempts_assistance'
       AND conrelid = 'study_exam_attempts'::regclass
  ) THEN
    ALTER TABLE study_exam_attempts ADD CONSTRAINT study_exam_attempts_assistance CHECK (
      jsonb_typeof(assistance) = 'object' AND octet_length(assistance::text) <= 16000
    );
  END IF;
END
$study_attempt_assistance$;
`;

export const ACCOUNTS_MIGRATION_32 = `${STUDY_TABLES_SQL_V32}
ALTER TABLE public.study_practice_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_practice_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.study_practice_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_practice_jobs TO app_web;

DROP POLICY IF EXISTS study_practice_jobs_web_owner ON public.study_practice_jobs;
CREATE POLICY study_practice_jobs_web_owner ON public.study_practice_jobs
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());
`;
