-- Candidate A spike schema (learning plan B03 step 1). Throwaway database only.
-- Mirrors the shape planned for production: extensions in their own schema,
-- owner-bound FORCE RLS, retrieval restricted to an allowed index set inside
-- the SQL that produces candidates (never filtered afterwards).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA extensions;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spike_web') THEN
    CREATE ROLE spike_web NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA extensions TO spike_web;

DROP TABLE IF EXISTS spike_chunks;
CREATE TABLE spike_chunks (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  index_id text NOT NULL,
  material_id text NOT NULL,
  version_id text NOT NULL,
  ordinal integer NOT NULL,
  block_id text NOT NULL,
  page_number integer,
  block_type text NOT NULL,
  text text NOT NULL,
  content_hash text NOT NULL,
  embedding extensions.halfvec(1024) NOT NULL
);
CREATE INDEX spike_chunks_owner_index ON spike_chunks (owner_id, index_id);
-- No HNSW by default: a query only ranks one owner's allowed indexes, which the
-- (owner_id, index_id) btree narrows to a few thousand rows; exact distance over
-- them has perfect recall and costs no extra index storage. run.mjs --hnsw adds
-- one to measure its size.
-- One PGroonga index over (owner, index, text): the scope predicates and the
-- keyword match run in a single index scan, so pgroonga_score is real and the
-- candidates are scoped before they are ranked.
CREATE INDEX spike_chunks_text ON spike_chunks USING pgroonga (
  owner_id extensions.pgroonga_text_term_search_ops_v2,
  index_id extensions.pgroonga_text_term_search_ops_v2,
  text extensions.pgroonga_text_full_text_search_ops_v2
);

ALTER TABLE spike_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE spike_chunks FORCE ROW LEVEL SECURITY;
GRANT SELECT ON spike_chunks TO spike_web;
CREATE POLICY spike_chunks_owner ON spike_chunks FOR SELECT TO spike_web
  USING (owner_id = current_setting('app.owner_id', true));

-- Hybrid retrieval: vector top-N and lexical top-N over the allowed indexes,
-- fused with reciprocal rank fusion (k = 60). SECURITY INVOKER, so RLS of the
-- calling role applies; search_path is pinned because app roles do not have
-- the extensions schema on theirs (checked on the hosted project).
CREATE OR REPLACE FUNCTION spike_hybrid_search(
  p_owner_id text,
  p_index_ids text[],
  p_terms text[],
  p_embedding text,
  p_k integer,
  p_candidates integer,
  p_mode text DEFAULT 'hybrid'
)
RETURNS TABLE(id text, vector_rank integer, lexical_rank integer, vector_distance double precision,
              lexical_score double precision, rrf double precision)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
SET enable_seqscan = off
AS $fn$
  WITH vec AS (
    SELECT c.id, (c.embedding <=> p_embedding::halfvec) AS dist,
           row_number() OVER (ORDER BY c.embedding <=> p_embedding::halfvec)::integer AS r
      FROM spike_chunks c
     WHERE p_mode IN ('hybrid', 'vector')
       AND c.owner_id = p_owner_id AND c.index_id = ANY (p_index_ids)
     ORDER BY c.embedding <=> p_embedding::halfvec
     LIMIT p_candidates
  ), lex AS (
    SELECT s.id, s.score, row_number() OVER (ORDER BY s.score DESC, s.id)::integer AS r
      FROM (
        SELECT c.id, pgroonga_score(c.tableoid, c.ctid) AS score
          FROM spike_chunks c
         WHERE p_mode IN ('hybrid', 'lexical') AND cardinality(p_terms) > 0
           AND c.owner_id = p_owner_id AND c.index_id = ANY (p_index_ids)
           AND c.text &@| p_terms
      ) s
     ORDER BY s.score DESC, s.id
     LIMIT p_candidates
  )
  SELECT COALESCE(vec.id, lex.id), vec.r, lex.r, vec.dist, lex.score,
         COALESCE(1.0 / (60 + vec.r), 0) + COALESCE(1.0 / (60 + lex.r), 0)
    FROM vec FULL OUTER JOIN lex ON lex.id = vec.id
   ORDER BY 6 DESC, 1
   LIMIT p_k
$fn$;
GRANT EXECUTE ON FUNCTION spike_hybrid_search(text, text[], text[], text, integer, integer, text) TO spike_web;
