/**
 * v24: persistent retrieval and cited answers over study materials (learning
 * plan B03, candidate A: same-database pgvector + PGroonga, see
 * spikes/b03-candidate-a).
 *
 * - study_knowledge_indexes: one searchable index of one parse artifact of a
 *   material version, for one chunk policy and one embedding signature. It is
 *   written together with all of its chunks in the lease-fenced commit of a
 *   `material_index` learning task, so a row always means "complete". At most
 *   one index per version is active; a rebuild activates the new index in the
 *   same commit that retires the old one, so a failed rebuild never touches
 *   the active index.
 * - study_knowledge_chunks: the chunks with their locator (version, page,
 *   block), content hash and a halfvec(1024) embedding. A multi-column
 *   PGroonga index over (owner, index, text) runs scope and keyword match in
 *   one index scan; vector distance is exact over the already scoped rows.
 * - study_qa_answers / study_qa_citations: saved answers of the ask page and
 *   the server-approved citations they name. Citations reference the material
 *   version and go with it when the material is permanently deleted; the
 *   answer stays readable with "source deleted".
 * - learning_tasks.kind gains `material_index`.
 *
 * Extensions: vector and pgroonga are created in the `extensions` schema only
 * where both are available (hosted Supabase offers both). Databases without
 * them (PGlite, the plain PostgreSQL test containers, legacy installs) get
 * every other part of v24, and the application reports retrieval as
 * unavailable because study_knowledge_chunks does not exist. app_web and
 * app_worker do not have `extensions` on their search_path, so the column type
 * is schema-qualified and the search function pins its own search_path.
 *
 * STUDY_TABLES_SQL_V24 and STUDY_KNOWLEDGE_STORAGE_SQL_V24 are frozen with
 * this migration's checksum; legacy self-migrating installs apply the same
 * text through `ensureStudySchema`.
 */

/** Embedding width of the chunk column; changing it requires a new migration. */
export const STUDY_KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024;

export const STUDY_TABLES_SQL_V24 = `
ALTER TABLE learning_tasks DROP CONSTRAINT IF EXISTS learning_tasks_kind_check;
ALTER TABLE learning_tasks ADD CONSTRAINT learning_tasks_kind_check
  CHECK (kind IN ('material_parse', 'material_index'));

CREATE TABLE IF NOT EXISTS study_knowledge_indexes (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  material_id text NOT NULL,
  version_id text NOT NULL,
  artifact_id text NOT NULL,
  chunk_policy text NOT NULL CHECK (length(chunk_policy) BETWEEN 1 AND 200),
  embedding_signature text NOT NULL CHECK (length(embedding_signature) BETWEEN 1 AND 300),
  active boolean NOT NULL DEFAULT false,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  text_chars integer NOT NULL DEFAULT 0 CHECK (text_chars >= 0),
  unparsed_pages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unparsed_pages) = 'array'),
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_knowledge_indexes_owner_id_key UNIQUE (owner_id, id),
  CONSTRAINT study_knowledge_indexes_build UNIQUE
    (owner_id, artifact_id, chunk_policy, embedding_signature),
  CONSTRAINT study_knowledge_indexes_version_fk FOREIGN KEY (owner_id, version_id)
    REFERENCES study_material_versions (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_knowledge_indexes_artifact_fk FOREIGN KEY (owner_id, artifact_id)
    REFERENCES study_material_artifacts (owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS study_knowledge_indexes_one_active
  ON study_knowledge_indexes (owner_id, version_id) WHERE active;
CREATE INDEX IF NOT EXISTS study_knowledge_indexes_owner_material
  ON study_knowledge_indexes (owner_id, material_id);

CREATE TABLE IF NOT EXISTS study_qa_answers (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  space_id text NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('answered', 'not_found')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  model_string text CHECK (model_string IS NULL OR length(model_string) <= 300),
  usage jsonb,
  usage_completeness text NOT NULL DEFAULT 'unknown' CHECK (usage_completeness IN
    ('none', 'complete', 'partial', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_qa_answers_owner_id_key UNIQUE (owner_id, id),
  CONSTRAINT study_qa_answers_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_qa_answers_owner_space
  ON study_qa_answers (owner_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_qa_citations (
  owner_id text NOT NULL,
  answer_id text NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^E[0-9]{1,2}$'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  material_id text NOT NULL,
  version_id text NOT NULL,
  artifact_id text NOT NULL,
  chunk_id text NOT NULL CHECK (length(chunk_id) BETWEEN 1 AND 200),
  block_id text NOT NULL CHECK (length(block_id) BETWEEN 1 AND 200),
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  quote text NOT NULL CHECK (char_length(quote) <= 400),
  content_hash text NOT NULL CHECK (length(content_hash) BETWEEN 1 AND 128),
  PRIMARY KEY (owner_id, answer_id, ref),
  CONSTRAINT study_qa_citations_answer_fk FOREIGN KEY (owner_id, answer_id)
    REFERENCES study_qa_answers (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_qa_citations_version_fk FOREIGN KEY (owner_id, version_id)
    REFERENCES study_material_versions (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_qa_citations_owner_version
  ON study_qa_citations (owner_id, version_id);
`;

/**
 * Extension-backed part, run only where vector and pgroonga are available.
 * Statements are separated by the marker so the DO block can EXECUTE them.
 */
const KNOWLEDGE_STORAGE_STATEMENTS = [
  'CREATE SCHEMA IF NOT EXISTS extensions',
  'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions',
  'CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA extensions',
  `CREATE TABLE IF NOT EXISTS public.study_knowledge_chunks (
  owner_id text NOT NULL,
  index_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  material_id text NOT NULL,
  version_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  block_id text NOT NULL CHECK (length(block_id) BETWEEN 1 AND 200),
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  heading text CHECK (heading IS NULL OR char_length(heading) <= 300),
  block_type text NOT NULL CHECK (length(block_type) BETWEEN 1 AND 40),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  content_hash text NOT NULL CHECK (length(content_hash) BETWEEN 1 AND 128),
  embedding extensions.halfvec(${STUDY_KNOWLEDGE_EMBEDDING_DIMENSIONS}) NOT NULL,
  PRIMARY KEY (owner_id, index_id, id),
  CONSTRAINT study_knowledge_chunks_index_fk FOREIGN KEY (owner_id, index_id)
    REFERENCES public.study_knowledge_indexes (owner_id, id) ON DELETE CASCADE
)`,
  `CREATE INDEX IF NOT EXISTS study_knowledge_chunks_text ON public.study_knowledge_chunks
  USING pgroonga (
    owner_id extensions.pgroonga_text_term_search_ops_v2,
    index_id extensions.pgroonga_text_term_search_ops_v2,
    text extensions.pgroonga_text_full_text_search_ops_v2
  )`,
  `CREATE OR REPLACE FUNCTION public.study_knowledge_search(
  p_owner_id text,
  p_index_ids text[],
  p_terms text[],
  p_embedding text,
  p_k integer,
  p_candidates integer
)
RETURNS TABLE(
  index_id text,
  chunk_id text,
  vector_rank integer,
  lexical_rank integer,
  vector_distance double precision,
  lexical_score double precision,
  fused_score double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
SET enable_seqscan = off
AS $study_knowledge_search$
  WITH vec AS (
    SELECT c.index_id, c.id, (c.embedding <=> p_embedding::halfvec) AS dist,
           row_number() OVER (ORDER BY c.embedding <=> p_embedding::halfvec, c.id)::integer AS r
      FROM public.study_knowledge_chunks c
     WHERE p_embedding IS NOT NULL
       AND c.owner_id = p_owner_id AND c.index_id = ANY (p_index_ids)
     ORDER BY c.embedding <=> p_embedding::halfvec, c.id
     LIMIT LEAST(GREATEST(p_candidates, 1), 100)
  ), lex AS (
    SELECT s.index_id, s.id, s.score,
           row_number() OVER (ORDER BY s.score DESC, s.id)::integer AS r
      FROM (
        SELECT c.index_id, c.id, pgroonga_score(c.tableoid, c.ctid) AS score
          FROM public.study_knowledge_chunks c
         WHERE cardinality(p_terms) > 0
           AND c.owner_id = p_owner_id AND c.index_id = ANY (p_index_ids)
           AND c.text &@| p_terms
      ) s
     ORDER BY s.score DESC, s.id
     LIMIT LEAST(GREATEST(p_candidates, 1), 100)
  )
  SELECT COALESCE(vec.index_id, lex.index_id), COALESCE(vec.id, lex.id), vec.r, lex.r,
         vec.dist, lex.score,
         COALESCE(1.0 / (60 + vec.r), 0) + COALESCE(1.0 / (60 + lex.r), 0)
    FROM vec FULL OUTER JOIN lex ON lex.index_id = vec.index_id AND lex.id = vec.id
   ORDER BY 7 DESC, 2
   LIMIT LEAST(GREATEST(p_k, 1), 20)
$study_knowledge_search$`,
];

export const STUDY_KNOWLEDGE_STORAGE_SQL_V24 = KNOWLEDGE_STORAGE_STATEMENTS.join(';\n');

/**
 * Runs the extension-backed statements only when both extensions are
 * available. `tolerant` (legacy app start) turns any failure, such as a
 * database user that may not create extensions, into a notice.
 */
function conditionalKnowledgeStorage(grants: string, tolerant = false): string {
  const handler = tolerant
    ? `
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'study knowledge storage skipped: %', SQLERRM;`
    : '';
  const body = [...KNOWLEDGE_STORAGE_STATEMENTS, ...(grants ? grants.split(';\n') : [])]
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement, index) => `    EXECUTE $kst${index}$${statement}$kst${index}$;`)
    .join('\n');
  return `
DO $study_knowledge_storage$
BEGIN
  IF (SELECT count(*) FROM pg_available_extensions WHERE name IN ('vector', 'pgroonga')) = 2 THEN
${body}
  ELSE
    RAISE NOTICE 'study knowledge storage skipped: vector and pgroonga are not both available';
  END IF;${handler}
END
$study_knowledge_storage$;
`;
}

/** Legacy installs (no hosted roles): the same storage, no grants, never fatal. */
export const STUDY_KNOWLEDGE_STORAGE_LEGACY_SQL_V24 = conditionalKnowledgeStorage('', true);

const KNOWLEDGE_TABLES = ['study_knowledge_indexes', 'study_qa_answers', 'study_qa_citations'];

const HOSTED_STORAGE_GRANTS = [
  'ALTER TABLE public.study_knowledge_chunks ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.study_knowledge_chunks FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE public.study_knowledge_chunks FROM PUBLIC, anon, authenticated',
  'GRANT USAGE ON SCHEMA extensions TO app_web, app_worker',
  'GRANT SELECT, DELETE ON TABLE public.study_knowledge_chunks TO app_web',
  'GRANT SELECT, INSERT, DELETE ON TABLE public.study_knowledge_chunks TO app_worker',
  'DROP POLICY IF EXISTS study_knowledge_chunks_web ON public.study_knowledge_chunks',
  `CREATE POLICY study_knowledge_chunks_web ON public.study_knowledge_chunks
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id())`,
  'DROP POLICY IF EXISTS study_knowledge_chunks_worker ON public.study_knowledge_chunks',
  `CREATE POLICY study_knowledge_chunks_worker ON public.study_knowledge_chunks
  FOR ALL TO app_worker USING (true) WITH CHECK (true)`,
  'REVOKE ALL ON FUNCTION public.study_knowledge_search(text,text[],text[],text,integer,integer) FROM PUBLIC, anon, authenticated',
  'GRANT EXECUTE ON FUNCTION public.study_knowledge_search(text,text[],text[],text,integer,integer) TO app_web',
].join(';\n');

export const ACCOUNTS_MIGRATION_24 = `${STUDY_TABLES_SQL_V24}
DO $study_knowledge_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${KNOWLEDGE_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_knowledge_rls$;

GRANT SELECT, DELETE ON TABLE public.study_knowledge_indexes TO app_web;
GRANT SELECT, INSERT, DELETE ON TABLE public.study_qa_answers, public.study_qa_citations TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_knowledge_indexes TO app_worker;

DROP POLICY IF EXISTS study_knowledge_indexes_web ON public.study_knowledge_indexes;
CREATE POLICY study_knowledge_indexes_web ON public.study_knowledge_indexes
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_knowledge_indexes_worker ON public.study_knowledge_indexes;
CREATE POLICY study_knowledge_indexes_worker ON public.study_knowledge_indexes
  FOR ALL TO app_worker USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS study_qa_answers_web ON public.study_qa_answers;
CREATE POLICY study_qa_answers_web ON public.study_qa_answers
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_qa_citations_web ON public.study_qa_citations;
CREATE POLICY study_qa_citations_web ON public.study_qa_citations
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.study_qa_answers answer
       WHERE answer.owner_id = app_internal.current_owner_id()
         AND answer.id = study_qa_citations.answer_id
    )
  );

-- Web accepts a task kind only while a worker that runs it is live.
CREATE OR REPLACE FUNCTION app_internal.learning_task_kind_ready(p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $learning_task_kind_ready$
  SELECT p_capability ~ '^learning-kind:[a-z_]{1,40}$' AND EXISTS (
    SELECT 1 FROM public.generation_worker_heartbeats
     WHERE heartbeat_at > clock_timestamp() - interval '30 seconds'
       AND NOT draining
       AND pipeline_versions @> jsonb_build_array(p_capability)
  )
$learning_task_kind_ready$;

REVOKE ALL ON FUNCTION app_internal.learning_task_kind_ready(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_internal.learning_task_kind_ready(text) TO app_web, app_worker;
${conditionalKnowledgeStorage(HOSTED_STORAGE_GRANTS)}`;
