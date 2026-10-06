/**
 * Candidate A spike (learning plan B03 step 1): same-database pgvector +
 * PGroonga + RRF hybrid retrieval, measured on the synthetic B03 corpus.
 *
 * Not production code. Run through run.mjs, which bundles this file with
 * esbuild so it can use the repository's real chunker (lib/rag).
 *
 * Env:
 *   SPIKE_DATABASE_URL   superuser URL of the throwaway database (127.0.0.1 only)
 *   SPIKE_EMBEDDING      fake (default) | http
 *   SPIKE_EMBED_URL / SPIKE_EMBED_KEY / SPIKE_EMBED_MODEL / SPIKE_EMBED_DIMENSIONS
 *                        OpenAI-compatible /embeddings endpoint (only with explicit approval)
 *   SPIKE_SCALE_CHUNKS   extra synthetic chunks for the load test (default 20000)
 *   SPIKE_OUT            output JSON path
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';

import { chunkDocumentArtifact } from '@/lib/rag/chunking';
import type { DocumentArtifact, DocumentBlock } from '@/lib/document/types';

const DIM = 1024;
const MAX_CHARS = 800;
const ROOT = process.cwd();
const corpus = JSON.parse(
  readFileSync(resolve(ROOT, 'eval/study-qa/fixtures/corpus.json'), 'utf8'),
) as Corpus;
// Distractors join account A's library as single-version materials.
for (const material of JSON.parse(
  readFileSync(resolve(ROOT, 'eval/study-qa/fixtures/distractors.json'), 'utf8'),
).materials as { key: string; owner: string; title: string; pages: string[] }[]) {
  corpus.materials.push({
    key: material.key,
    owner: material.owner,
    title: material.title,
    versions: [{ no: 1, pages: material.pages.map((text) => ({ text })), images: [] }],
  });
}
const questionSet = JSON.parse(
  readFileSync(resolve(ROOT, 'eval/study-qa/fixtures/questions.json'), 'utf8'),
) as { questions: Question[] };

interface Corpus {
  owners: Record<string, string>;
  materials: {
    key: string;
    owner: string;
    title: string;
    versions: {
      no: number;
      pages: {
        text?: string;
        scanned?: boolean;
        tables?: { caption: string; cells: string[][] }[];
      }[];
      images: { page: number; description: string }[];
    }[];
  }[];
}
interface Question {
  id: string;
  category: string;
  owner?: string;
  question: string;
  answerable?: boolean;
  evidence: string[];
  requireAll?: boolean;
  scope?: { pin?: string[] };
}

// ── embeddings ─────────────────────────────────────────────────────────────

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stand-in for a real embedding model: signed feature hashing of
 * CJK unigrams/bigrams and Latin/number tokens. It measures the pipeline, not
 * semantic quality (it behaves like a second lexical signal).
 */
function fakeEmbed(text: string): number[] {
  const v = new Float64Array(DIM);
  const features: string[] = [];
  const lower = text.toLowerCase();
  const cjk = [...lower.replace(/[^\p{Script=Han}]+/gu, ' ')];
  for (let i = 0; i < cjk.length; i += 1) {
    if (cjk[i] === ' ') continue;
    features.push(`u:${cjk[i]}`);
    if (cjk[i + 1] && cjk[i + 1] !== ' ') features.push(`b:${cjk[i]}${cjk[i + 1]}`);
  }
  for (const token of lower.match(/[a-z0-9_']+/g) ?? []) features.push(`w:${token}`);
  for (const feature of features) {
    const h = fnv(feature);
    v[h % DIM] += h & 0x80000000 ? -1 : 1;
  }
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Array.from(v, (x) => x / norm);
}

interface EmbedUsage {
  calls: number;
  inputs: number;
  promptTokens: number;
  ms: number;
}
const embedUsage: EmbedUsage = { calls: 0, inputs: 0, promptTokens: 0, ms: 0 };

async function embed(texts: string[]): Promise<number[][]> {
  const started = Date.now();
  embedUsage.calls += 1;
  embedUsage.inputs += texts.length;
  try {
    if ((process.env.SPIKE_EMBEDDING ?? 'fake') === 'fake') return texts.map(fakeEmbed);
    const url = `${process.env.SPIKE_EMBED_URL!.replace(/\/$/, '')}/embeddings`;
    const dimensions = Number(process.env.SPIKE_EMBED_DIMENSIONS ?? 0) || undefined;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.SPIKE_EMBED_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.SPIKE_EMBED_MODEL,
        input: texts,
        encoding_format: 'float',
        ...(dimensions ? { dimensions } : {}),
      }),
    });
    if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
    const body = (await response.json()) as {
      data: { index: number; embedding: number[] }[];
      usage?: { prompt_tokens?: number };
    };
    embedUsage.promptTokens += body.usage?.prompt_tokens ?? 0;
    return body.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  } finally {
    embedUsage.ms += Date.now() - started;
  }
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

// ── corpus → chunks (through the repository's lib/rag chunker) ─────────────

interface SpikeChunk {
  id: string;
  ownerId: string;
  indexId: string;
  materialKey: string;
  versionNo: number;
  ordinal: number;
  blockId: string;
  pageNumber?: number;
  blockType: string;
  text: string;
  contentHash: string;
}

const indexId = (key: string, no: number) => `idx_${key}_v${no}`;

function buildChunks(): { chunks: SpikeChunk[]; unparsedPages: string[] } {
  const chunks: SpikeChunk[] = [];
  const unparsedPages: string[] = [];
  for (const material of corpus.materials) {
    for (const version of material.versions) {
      const blocks: DocumentBlock[] = [];
      version.pages.forEach((page, index) => {
        const pageNumber = index + 1;
        if (page.scanned || !page.text?.trim()) {
          unparsedPages.push(`${material.key}@${version.no}#${pageNumber}`);
          return;
        }
        blocks.push({ id: `page_${pageNumber}`, type: 'text', text: page.text, pageNumber });
        (page.tables ?? []).forEach((table, t) =>
          blocks.push({
            id: `table_${pageNumber}_${t + 1}`,
            type: 'table',
            text: `${table.caption}\n${table.cells.map((row) => row.join('\t')).join('\n')}`,
            pageNumber,
          }),
        );
      });
      version.images.forEach((image, i) =>
        blocks.push({
          id: `block_img_${i + 1}`,
          type: 'image',
          text: image.description,
          pageNumber: image.page,
        }),
      );
      const artifact: DocumentArtifact = {
        id: `${material.key}-v${version.no}`,
        source: { kind: 'upload', fileName: `${material.key}.pdf` },
        metadata: { mimeType: 'application/pdf', pageCount: version.pages.length },
        blocks,
      } as unknown as DocumentArtifact;
      const resource = {
        id: material.key,
        resourceVersionId: indexId(material.key, version.no),
        workspaceId: corpus.owners[material.owner],
        modality: 'document' as const,
        title: material.title,
        sourceRef: `${material.key}@${version.no}`,
        contentHash: createHash('sha256').update(JSON.stringify(version)).digest('hex'),
        status: 'ready' as const,
        lineage: {
          sourceHash: 'spike',
          extractor: { id: 'unpdf', version: 'spike' },
          transforms: [],
          chunkPolicy: { id: 'study-knowledge', version: 'spike-1' },
        },
        metadata: {},
      };
      for (const chunk of chunkDocumentArtifact(artifact, resource, { maxChars: MAX_CHARS })) {
        chunks.push({
          id: chunk.id,
          ownerId: corpus.owners[material.owner],
          indexId: indexId(material.key, version.no),
          materialKey: material.key,
          versionNo: version.no,
          ordinal: chunk.ordinal,
          blockId: chunk.locator.blockId,
          pageNumber: chunk.locator.pageNumber,
          blockType: String(chunk.metadata.blockType ?? 'text'),
          text: chunk.text,
          contentHash: chunk.contentHash,
        });
      }
    }
  }
  return { chunks, unparsedPages };
}

// ── query terms (PGroonga keyword OR search) ───────────────────────────────

const STOPWORDS = new Set(
  '什么 怎么 怎样 如何 哪些 哪个 哪种 为什么 是否 多少 可以 能否 之间 关系 以及 的 了 吗 呢 是 有 和 与 在 对 中 时 会 得到 结果 需要 满足 要求 本身 一 下 请问 表中 写 内容 结论 几'.split(
    ' ',
  ),
);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function queryTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const part of segmenter.segment(question)) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim();
    if (!word || STOPWORDS.has(word)) continue;
    if (/^\p{Script=Han}$/u.test(word)) continue;
    terms.add(word);
  }
  // Formula-like fragments ("1 - cos x", "a^x") survive as their Latin tokens.
  for (const token of question.match(/[A-Za-z][A-Za-z0-9_]*|\d+/g) ?? []) terms.add(token);
  return [...terms].slice(0, 16);
}

// ── evaluation helpers ─────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function allowedIndexes(question: Question): string[] {
  const owner = question.owner ?? 'A';
  if (question.scope?.pin) {
    return question.scope.pin.map((ref) => {
      const [key, no] = ref.split('@');
      return indexId(key, Number(no));
    });
  }
  return corpus.materials
    .filter((m) => m.owner === owner)
    .map((m) => indexId(m.key, Math.max(...m.versions.map((v) => v.no))));
}

async function main() {
  const url = process.env.SPIKE_DATABASE_URL ?? '';
  if (!/@127\.0\.0\.1:/.test(url)) throw new Error('SPIKE_DATABASE_URL must point at 127.0.0.1');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const report: Record<string, unknown> = {
    embedding: process.env.SPIKE_EMBEDDING ?? 'fake',
    embeddingModel: process.env.SPIKE_EMBED_MODEL ?? 'fake-hash-1024',
    chunkPolicy: { maxChars: MAX_CHARS, unit: 'grapheme' },
  };
  const versions = await admin.query(
    `SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgroonga')`,
  );
  report.extensions = Object.fromEntries(versions.rows.map((r) => [r.extname, r.extversion]));
  report.server = (await admin.query('SHOW server_version')).rows[0].server_version;

  // 1. Index the corpus.
  const { chunks, unparsedPages } = buildChunks();
  const indexStart = Date.now();
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 32) {
    vectors.push(...(await embed(chunks.slice(i, i + 32).map((c) => c.text))));
  }
  const embedMs = Date.now() - indexStart;
  const insertStart = Date.now();
  await admin.query('TRUNCATE spike_chunks');
  for (const [i, c] of chunks.entries()) {
    await admin.query(
      `INSERT INTO spike_chunks (id, owner_id, index_id, material_id, version_id, ordinal, block_id,
         page_number, block_type, text, content_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::extensions.halfvec)`,
      [
        c.id,
        c.ownerId,
        c.indexId,
        c.materialKey,
        `${c.materialKey}@${c.versionNo}`,
        c.ordinal,
        c.blockId,
        c.pageNumber ?? null,
        c.blockType,
        c.text,
        c.contentHash,
        vectorLiteral(vectors[i]),
      ],
    );
  }
  report.indexing = {
    chunks: chunks.length,
    unparsedPages,
    embedMs,
    insertMs: Date.now() - insertStart,
    perIndex: Object.fromEntries(
      [...new Set(chunks.map((c) => c.indexId))].map((id) => [
        id,
        chunks.filter((c) => c.indexId === id).length,
      ]),
    ),
  };

  // 2. Query through the restricted role (RLS on), per mode.
  const web = new pg.Client({ connectionString: url });
  await web.connect();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const modes = ['hybrid', 'vector', 'lexical'] as const;
  const results: Record<string, unknown>[] = [];
  const latencies: Record<string, number[]> = { hybrid: [], vector: [], lexical: [] };
  const isolation = { checkedHits: 0, foreignOwner: 0, outsideScope: 0, unknownChunk: 0 };
  const fidelity = { checkedHits: 0, textNotInSource: 0, hashMismatch: 0, pageMismatch: 0 };
  const sourcePageText = (c: SpikeChunk) => {
    const material = corpus.materials.find((m) => m.key === c.materialKey)!;
    const version = material.versions.find((v) => v.no === c.versionNo)!;
    const page = version.pages[(c.pageNumber ?? 1) - 1];
    const tableText = (page.tables ?? [])
      .map((t) => `${t.caption}\n${t.cells.map((row) => row.join('\t')).join('\n')}`)
      .join('\n');
    const images = version.images
      .filter((img) => img.page === c.pageNumber)
      .map((img) => img.description)
      .join('\n');
    return `${page.text ?? ''}\n${tableText}\n${images}`;
  };

  for (const question of questionSet.questions) {
    const ownerId = corpus.owners[question.owner ?? 'A'];
    const allowed = allowedIndexes(question);
    const terms = queryTerms(question.question);
    const [qv] = await embed([question.question]);
    const row: Record<string, unknown> = {
      id: question.id,
      category: question.category,
      answerable: question.answerable !== false,
      terms,
    };
    for (const mode of modes) {
      await web.query('BEGIN');
      await web.query('SET LOCAL ROLE spike_web');
      await web.query(`SELECT set_config('app.owner_id', $1, true)`, [ownerId]);
      const started = process.hrtime.bigint();
      const hits = await web.query('SELECT * FROM spike_hybrid_search($1,$2,$3,$4,$5,$6,$7)', [
        ownerId,
        allowed,
        terms,
        vectorLiteral(qv),
        5,
        30,
        mode,
      ]);
      latencies[mode].push(Number(process.hrtime.bigint() - started) / 1e6);
      await web.query('COMMIT');
      const top = hits.rows.map((hit) => byId.get(hit.id));
      for (const c of top) {
        isolation.checkedHits += 1;
        if (!c) {
          isolation.unknownChunk += 1;
          continue;
        }
        if (c.ownerId !== ownerId) isolation.foreignOwner += 1;
        if (!allowed.includes(c.indexId)) isolation.outsideScope += 1;
        if (mode === 'hybrid') {
          fidelity.checkedHits += 1;
          const source = sourcePageText(c).replace(/\s+/g, '');
          if (!source.includes(c.text.replace(/\s+/g, ''))) fidelity.textNotInSource += 1;
          if (c.pageNumber === undefined) fidelity.pageMismatch += 1;
        }
      }
      const refs = top
        .filter(Boolean)
        .map((c) => `${c!.materialKey}@${c!.versionNo}#${c!.pageNumber}`);
      const hit =
        question.evidence.length === 0
          ? null
          : question.requireAll
            ? question.evidence.every((e) => refs.includes(e))
            : question.evidence.some((e) => refs.includes(e));
      row[mode] = {
        hit,
        refs,
        topRrf: hits.rows[0]?.rrf ?? null,
        topVectorDistance: hits.rows.find((h) => h.vector_rank === 1)?.vector_distance ?? null,
        lexicalHits: hits.rows.filter((h) => h.lexical_rank !== null).length,
      };
    }
    results.push(row);
  }
  report.questions = results;

  const summary: Record<string, unknown> = {};
  for (const mode of modes) {
    const answerable = results.filter((r) => r.answerable);
    const hits = answerable.filter((r) => (r[mode] as { hit: boolean }).hit).length;
    const byCategory: Record<string, string> = {};
    for (const category of [...new Set(answerable.map((r) => r.category as string))]) {
      const rows = answerable.filter((r) => r.category === category);
      byCategory[category] =
        `${rows.filter((r) => (r[mode] as { hit: boolean }).hit).length}/${rows.length}`;
    }
    summary[mode] = {
      recallAt5: `${hits}/${answerable.length} = ${((hits / answerable.length) * 100).toFixed(1)}%`,
      byCategory,
      latencyMs: {
        p50: +percentile(latencies[mode], 50).toFixed(2),
        p95: +percentile(latencies[mode], 95).toFixed(2),
      },
    };
  }
  report.summary = summary;
  report.isolation = isolation;
  report.fidelity = fidelity;

  // 3. Direct RLS probes: owner A cannot see B's rows even without the owner filter.
  await web.query('BEGIN');
  await web.query('SET LOCAL ROLE spike_web');
  await web.query(`SELECT set_config('app.owner_id', $1, true)`, [corpus.owners.A]);
  const visible = await web.query(
    'SELECT owner_id, count(*)::int AS n FROM spike_chunks GROUP BY owner_id',
  );
  const crossCall = await web.query(
    'SELECT count(*)::int AS n FROM spike_hybrid_search($1,$2,$3,$4,10,30)',
    [corpus.owners.B, [indexId('linalg_b', 1)], ['矩阵'], vectorLiteral(fakeEmbed('矩阵'))],
  );
  await web.query('COMMIT');
  report.rlsProbe = { visibleAsA: visible.rows, crossOwnerCallRows: crossCall.rows[0].n };

  // 4. Plans for the two candidate generators (does each use its index?).
  await admin.query(`SET enable_seqscan = off`);
  const explain = async (sql: string, params: unknown[]) =>
    (await admin.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  report.plans = {
    vector: await explain(
      `SELECT id FROM spike_chunks WHERE owner_id=$1 AND index_id = ANY($2)
        ORDER BY embedding OPERATOR(extensions.<=>) $3::extensions.halfvec LIMIT 30`,
      [corpus.owners.A, [indexId('calc', 1)], vectorLiteral(fakeEmbed('导数'))],
    ),
    lexical: await explain(
      `SELECT id, extensions.pgroonga_score(tableoid, ctid) FROM spike_chunks
        WHERE owner_id=$1 AND index_id = ANY($2) AND text OPERATOR(extensions.&@|) $3::text[]`,
      [corpus.owners.A, [indexId('calc', 1)], ['导数']],
    ),
  };
  await admin.query(`RESET enable_seqscan`);

  // 5. Load test: add synthetic chunks for other owners, measure build, size and latency.
  const scale = Number(process.env.SPIKE_SCALE_CHUNKS ?? 20000);
  if (scale > 0) {
    const texts = chunks.map((c) => c.text);
    const loadStart = Date.now();
    for (let i = 0; i < scale; i += 500) {
      const rows: unknown[] = [];
      const values: string[] = [];
      for (let j = i; j < Math.min(scale, i + 500); j += 1) {
        const text = `${texts[j % texts.length]}（合成负载 ${j}）`;
        const base = rows.length;
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},'load','load@1',${j},'page_1',1,'text',$${base + 4},'x',$${base + 5}::extensions.halfvec)`,
        );
        rows.push(
          `load-${j}`,
          'user:load-big',
          'idx_load_big',
          text,
          vectorLiteral(fakeEmbed(text)),
        );
      }
      await admin.query(
        `INSERT INTO spike_chunks (id, owner_id, index_id, material_id, version_id, ordinal, block_id,
           page_number, block_type, text, content_hash, embedding) VALUES ${values.join(',')}`,
        rows,
      );
    }
    const loadMs = Date.now() - loadStart;
    await admin.query('ANALYZE spike_chunks');
    const pgroongaBytes = async () =>
      Number(
        (
          await admin.query(`
            SELECT COALESCE(sum((pg_stat_file('base/' || d.oid || '/' || f)).size), 0)::bigint AS bytes
              FROM pg_database d, LATERAL pg_ls_dir('base/' || d.oid) AS f
             WHERE d.datname = current_database() AND f LIKE 'pgrn%'`)
        ).rows[0].bytes,
      );
    const sizes = await admin.query(`
      SELECT pg_size_pretty(pg_relation_size('spike_chunks')) AS heap,
             pg_size_pretty(pg_total_relation_size('spike_chunks')) AS heap_toast_btree,
             (SELECT count(*) FROM spike_chunks)::int AS rows`);
    const timeScope = async (ownerId: string, indexIds: string[], questions: Question[]) => {
      const samples: number[] = [];
      for (const question of questions) {
        await web.query('BEGIN');
        await web.query('SET LOCAL ROLE spike_web');
        await web.query(`SELECT set_config('app.owner_id', $1, true)`, [ownerId]);
        const started = process.hrtime.bigint();
        await web.query('SELECT * FROM spike_hybrid_search($1,$2,$3,$4,5,30)', [
          ownerId,
          indexIds,
          queryTerms(question.question),
          vectorLiteral(fakeEmbed(question.question)),
        ]);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        await web.query('COMMIT');
      }
      return { p50: +percentile(samples, 50).toFixed(2), p95: +percentile(samples, 95).toFixed(2) };
    };
    const sample = questionSet.questions.slice(0, 30);
    report.load = {
      addedChunks: scale,
      insertMs: loadMs,
      msPerChunk: +(loadMs / scale).toFixed(2),
      sizes: {
        ...sizes.rows[0],
        pgroongaFiles: `${((await pgroongaBytes()) / 1048576).toFixed(1)} MB`,
      },
      // A's normal scope (~20 chunks) while 20k other chunks exist.
      normalScopeLatencyMs: await timeScope(corpus.owners.A, allowedIndexes(sample[0]), sample),
      // Worst case: one owner whose allowed scope holds every load chunk (exact scan).
      fullScopeLatencyMs: await timeScope('user:load-big', ['idx_load_big'], sample),
    };
    if (process.env.SPIKE_HNSW === '1') {
      const started = Date.now();
      await admin.query(
        'CREATE INDEX spike_chunks_embedding ON spike_chunks USING hnsw (embedding extensions.halfvec_cosine_ops)',
      );
      const hnsw = await admin.query(
        `SELECT pg_size_pretty(pg_relation_size('spike_chunks_embedding')) AS size`,
      );
      report.load = {
        ...(report.load as object),
        hnsw: { buildMs: Date.now() - started, size: hnsw.rows[0].size },
      };
    }
    const deleteStart = Date.now();
    const deleted = await admin.query(`DELETE FROM spike_chunks WHERE material_id='load'`);
    report.load = {
      ...(report.load as object),
      deleteRows: deleted.rowCount,
      deleteMs: Date.now() - deleteStart,
    };
  }

  report.embeddingUsage = embedUsage;
  const out = process.env.SPIKE_OUT ?? resolve(ROOT, '.scratch/b03-spike/report.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ summary: report.summary, isolation, fidelity, load: report.load }, null, 2),
  );
  await web.end();
  await admin.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
