/**
 * B03 grounded-QA evaluation (learning plan B03 acceptance).
 *
 * Builds a disposable database with the production schema (vector + pgroonga),
 * seeds the labelled fixture (eval/study-qa/fixtures), indexes every version
 * through the real `material_index` task handler and measures, for the 48
 * labelled questions:
 *   - evidence recall@5 of hybrid retrieval (and of keyword-only retrieval);
 *   - permission isolation: retrieved/cited passages of another owner or
 *     outside the allowed scope (must be 0);
 *   - version correctness: pinned questions only see the pinned version, others
 *     never an old one (must be 100%);
 *   - with an answer model: citation support rate (each grounded claim cites a
 *     labelled evidence location or a passage containing an expected term),
 *     not-found accuracy, unknown citation ids rejected.
 *
 * Usage (Node 24; see eval/study-qa/README.md):
 *   EVAL_STUDY_DATABASE_URL=postgres://postgres:…@127.0.0.1:55435/knowledge_rls_proof \
 *   node eval/study-qa/run.mjs [--answers]
 *
 * Retrieval mode: EVAL_RETRIEVAL=keyword (default, the production default:
 * keyword-only indexes, no embedding calls) or hybrid. In hybrid mode the
 * embeddings are fake hashing unless EVAL_EMBEDDING_URL / EVAL_EMBEDDING_KEY /
 * EVAL_EMBEDDING_MODEL name a real OpenAI-compatible model (ask first).
 * Answers: `--answers` uses EVAL_ANSWER_MODEL (`provider:model`, real) or the
 * deterministic `fake` answerer. In keyword mode the "hybrid" columns of the
 * report are the keyword-only results.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';
import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';

import {
  createEmbeddingBinding,
  createEmbeddingGateway,
  type EmbeddingBinding,
  type EmbeddingGateway,
  type GatewayResult,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { createFauxGateway } from '@/lib/model-gateway/testing/faux-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { LearningTaskQueue } from '@/lib/server/learning-tasks/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import { runMaterialIndexTask } from '@/lib/server/study/knowledge/index-task';
import { STUDY_KEYWORD_SIGNATURE } from '@/lib/server/study/knowledge/config';
import {
  requestStudyIndexBuild,
  resetKnowledgeStorageReadiness,
  resolveQuestionScope,
  searchStudyKnowledge,
} from '@/lib/server/study/knowledge/repository';
import { askSpace } from '@/lib/server/study/knowledge/ask';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import type { StudyAnswerView } from '@/lib/study/knowledge/contracts';

import { fakeEmbedding, loadStudyQaFixture, type FixtureQuestion } from './fixture';
import { seedStudyQaFixture } from './seed';
import { resolveEvalModel } from '../shared/resolve-model';

export interface QuestionResult {
  id: string;
  category: string;
  owner: 'A' | 'B';
  answerable: boolean;
  hybridRefs: string[];
  lexicalRefs: string[];
  hybridHit: boolean | null;
  lexicalHit: boolean | null;
  foreignHits: number;
  outOfScopeHits: number;
  oldVersionHits: number;
  answer?: {
    status: StudyAnswerView['status'];
    groundedClaims: number;
    supportedClaims: number;
    citedRefs: string[];
    notFoundCorrect: boolean | null;
    supplements: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface EvalReport {
  startedAt: string;
  mode: 'keyword' | 'hybrid';
  embedding: { model: string; real: boolean; calls: number; inputTokens: number | null };
  answerModel: string | null;
  indexing: { versions: number; chunks: number; ms: number };
  retrieval: {
    recallAt5Hybrid: string;
    recallAt5Lexical: string;
    byCategory: Record<string, string>;
    latencyMsP50: number;
    latencyMsP95: number;
  };
  isolation: { checkedHits: number; foreignHits: number; outOfScopeHits: number };
  versions: { pinnedQuestions: number; correct: number; oldVersionHitsInCurrentScope: number };
  answers: null | {
    questions: number;
    groundedClaims: number;
    supportedClaims: number;
    citationSupportRate: string;
    notFoundQuestions: number;
    notFoundCorrect: number;
    /** Not-found answers that still carry a labelled supplement from the model. */
    notFoundWithSupplement: number;
    answerableAnsweredGrounded: number;
    answerableQuestions: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  questions: QuestionResult[];
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${n}/${d} = ${((n / d) * 100).toFixed(1)}%`;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(2)
    : 0;
}

function studyDb(pool: Pool): StudyDb {
  return Object.assign(
    { query: ((sql: string, params?: unknown[]) => pool.query(sql, params)) as Queryable['query'] },
    {
      withTransaction: async <T>(body: (tx: Queryable) => Promise<T>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await body({
            query: ((sql: string, params?: unknown[]) =>
              client.query(sql, params)) as Queryable['query'],
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },
  );
}

/** Deterministic extractive answerer: cites the passages sharing the most question terms. */
function fakeAnswerGateway(): Pick<ModelGateway, 'complete'> {
  return {
    async complete(_binding, request) {
      const prompt = request.messages
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => ('text' in part ? part.text : '')).join(''),
        )
        .join('\n');
      const question = /问题：(.*)/.exec(prompt)?.[1] ?? '';
      const terms = questionTerms(question);
      const passages = [...prompt.matchAll(/\[(E\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[E\d+\]|$)/g)].map(
        (match) => ({ ref: match[1]!, text: match[2]!.toLowerCase() }),
      );
      const scored = passages
        .map((passage) => ({
          ...passage,
          score: terms.filter((term) => passage.text.includes(term)).length,
        }))
        .sort((a, b) => b.score - a.score);
      const best = scored.filter((passage) => passage.score >= Math.max(2, scored[0]?.score ?? 0));
      const body =
        best.length === 0
          ? { status: 'not_found', segments: [], not_found_note: '片段与问题不匹配' }
          : {
              status: 'answered',
              segments: [
                {
                  kind: 'grounded',
                  text: '见资料。',
                  citations: best.slice(0, 2).map((p) => p.ref),
                },
              ],
            };
      const text = JSON.stringify(body);
      return {
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        text,
        reasoningText: '',
        toolCalls: [],
        stopReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
        attempts: 1,
      } as unknown as GatewayResult;
    },
  };
}

export async function runStudyQaEval(options: {
  databaseUrl: string;
  answers: boolean;
  outDir?: string;
}): Promise<EvalReport> {
  const parsed = new URL(options.databaseUrl);
  if (parsed.hostname !== '127.0.0.1')
    throw new Error('EVAL_STUDY_DATABASE_URL must be on 127.0.0.1');
  const fixture = loadStudyQaFixture();
  const admin = new Pool({ connectionString: options.databaseUrl, max: 1 });
  const dbName = `study_qa_eval_${randomBytes(5).toString('hex')}_rls_proof`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  parsed.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: parsed.toString(), max: 4 });
  const bytes = new Map<string, Buffer>();
  setMaterialByteStoreForTests({
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw new Error(`missing ${key}`);
      return value;
    },
    delete: async (key) => void bytes.delete(key),
  });
  resetKnowledgeStorageReadiness();
  try {
    const q: Queryable = {
      query: ((sql: string, p?: unknown[]) => pool.query(sql, p)) as Queryable['query'],
    };
    await ensureDocumentSchema(q);
    await ensureStageMetaSchema(q);
    await ensureOwnerMaterialSchema(q);
    await ensureAssetSchema(q);
    await ensureStudySchema(q);
    await migrateGenerationSchema(pool as never);
    const study = studyDb(pool);
    const queue = new LearningTaskQueue(pool as never, {
      leaseMs: 120_000,
      queueWaitMs: 3_600_000,
    });
    await queue.workerHeartbeat('eval-worker', false, ['material_index']);
    const seeded = await seedStudyQaFixture(
      q,
      fixture,
      async (key, body) => void bytes.set(key, body),
    );

    // Retrieval mode; in hybrid mode a real embedding only when explicitly configured.
    const mode = process.env.EVAL_RETRIEVAL === 'hybrid' ? 'hybrid' : 'keyword';
    const realEmbedding =
      mode === 'hybrid' &&
      Boolean(process.env.EVAL_EMBEDDING_URL && process.env.EVAL_EMBEDDING_MODEL);
    const hybridBinding: EmbeddingBinding = realEmbedding
      ? createEmbeddingBinding(
          {
            providerId: 'eval',
            modelId: process.env.EVAL_EMBEDDING_MODEL!,
            dimensions: 1024,
            requestDimensions: process.env.EVAL_EMBEDDING_SEND_DIMENSIONS === '1',
          },
          {
            baseUrl: process.env.EVAL_EMBEDDING_URL!,
            apiKey: process.env.EVAL_EMBEDDING_KEY ?? '',
          },
        )
      : createEmbeddingBinding(
          { providerId: 'fake', modelId: 'hash-1024', dimensions: 1024 },
          { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake' },
        );
    const binding: EmbeddingBinding | null = mode === 'hybrid' ? hybridBinding : null;
    const signature = binding?.signature ?? STUDY_KEYWORD_SIGNATURE;
    let embedCalls = 0;
    let embedTokens: number | null = 0;
    const realGateway = createEmbeddingGateway({
      quota: async () => undefined,
      recordUsage: () => undefined,
    });
    const embeddings: EmbeddingGateway = {
      async embed(b, inputs, opts) {
        embedCalls += 1;
        if (!realEmbedding) {
          return {
            vectors: inputs.map((text) => fakeEmbedding(text)),
            inputTokens: null,
            attempts: 1,
          };
        }
        const result = await realGateway.embed(b, inputs, opts);
        embedTokens =
          result.inputTokens === null || embedTokens === null
            ? null
            : embedTokens + result.inputTokens;
        return result;
      },
    };

    // Index every version through the real task handler.
    const indexStart = Date.now();
    let versions = 0;
    for (const material of fixture.materials) {
      const seededMaterial = seeded.materials.get(material.key)!;
      for (const version of material.versions) {
        const ownerId = fixture.owners[material.owner];
        // Real embeddings can outlast the worker heartbeat window: stay "live".
        await queue.workerHeartbeat('eval-worker', false, ['material_index']);
        await requestStudyIndexBuild(study, ownerId, {
          materialId: seededMaterial.materialId,
          versionId: seededMaterial.versions.get(version.no)!.versionId,
          signature,
        });
        const lease = await queue.claim('eval-worker', ['material_index']);
        if (!lease) throw new Error('index task not queued');
        await runMaterialIndexTask(
          lease,
          { queue, signal: new AbortController().signal },
          { embeddingBinding: () => binding, embed: embeddings.embed },
        );
        versions += 1;
      }
    }
    const chunks = Number(
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM study_knowledge_chunks')).rows[0]!
        .n,
    );
    const indexMs = Date.now() - indexStart;

    const answerModel = options.answers ? (process.env.EVAL_ANSWER_MODEL ?? 'fake') : null;
    let answerBinding: ModelBinding | null = null;
    let answerGateway: Pick<ModelGateway, 'complete'> | undefined;
    if (answerModel === 'fake') {
      answerBinding = createFauxGateway().binding({
        modelString: 'fake:extractive',
        funding: { kind: 'local' },
      });
      answerGateway = fakeAnswerGateway();
    } else if (answerModel) {
      answerBinding = (await resolveEvalModel('EVAL_ANSWER_MODEL')).model;
    }

    const ownerOf = (key: string) => fixture.materials.find((m) => m.key === key)!.owner;
    const label = (versionId: string, page: number | null) => {
      const meta = seeded.byVersionId.get(versionId)!;
      return { ref: `${meta.key}@${meta.no}#${page ?? 0}`, key: meta.key, no: meta.no };
    };
    const latestNo = (key: string) =>
      Math.max(...fixture.materials.find((m) => m.key === key)!.versions.map((v) => v.no));

    const results: QuestionResult[] = [];
    const latencies: number[] = [];
    const transact = <T>(body: (tx: Queryable) => Promise<T>) => study.withTransaction(body);
    for (const question of fixture.questions) {
      const owner = question.owner ?? 'A';
      const ownerId = fixture.owners[owner];
      const spaceId = seeded.spaceIds[owner];
      const pins = (question.scope?.pin ?? []).map((ref) => {
        const [key, no] = ref.split('@');
        return seeded.materials.get(key!)!.versions.get(Number(no))!.versionId;
      });
      const scope = await transact((tx) =>
        resolveQuestionScope(tx, ownerId, spaceId, signature, pins),
      );
      const allowed = new Set(scope.map((index) => index.versionId));
      const vector = binding
        ? (await embeddings.embed(binding, [question.question], { source: 'eval' })).vectors[0]!
        : null;
      const started = process.hrtime.bigint();
      const hybrid = await transact((tx) =>
        searchStudyKnowledge(tx, ownerId, scope, questionTerms(question.question), vector, 5),
      );
      latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      const lexical = await transact((tx) =>
        searchStudyKnowledge(tx, ownerId, scope, questionTerms(question.question), null, 5),
      );
      const refs = (hits: typeof hybrid) =>
        hits.map((hit) => label(hit.index.versionId, hit.pageNumber).ref);
      const hitOf = (found: string[]) =>
        question.evidence.length === 0
          ? null
          : question.requireAll
            ? question.evidence.every((e) => found.includes(e))
            : question.evidence.some((e) => found.includes(e));
      const all = [...hybrid, ...lexical];
      const result: QuestionResult = {
        id: question.id,
        category: question.category,
        owner,
        answerable: question.answerable !== false,
        hybridRefs: refs(hybrid),
        lexicalRefs: refs(lexical),
        hybridHit: hitOf(refs(hybrid)),
        lexicalHit: hitOf(refs(lexical)),
        foreignHits: all.filter((hit) => ownerOf(label(hit.index.versionId, null).key) !== owner)
          .length,
        outOfScopeHits: all.filter((hit) => !allowed.has(hit.index.versionId)).length,
        oldVersionHits:
          pins.length > 0
            ? all.filter((hit) => !pins.includes(hit.index.versionId)).length
            : all.filter((hit) => {
                const meta = label(hit.index.versionId, null);
                return meta.no !== latestNo(meta.key);
              }).length,
      };

      if (answerBinding) {
        const answer = await askSpace(
          transact,
          {
            ownerId,
            spaceId,
            question: question.question,
            pinnedVersionIds: pins,
            model: answerBinding,
            embedding: binding,
            signature,
            signal: new AbortController().signal,
            requestId: `eval-${question.id}`,
          },
          { embeddings, ...(answerGateway ? { gateway: answerGateway } : {}) },
        );
        result.answer = scoreAnswer(question, answer, label);
        // The per-hour answer budget would stop a long run; clear it between questions.
        await pool.query('DELETE FROM study_qa_answers WHERE owner_id=$1', [ownerId]);
      }
      results.push(result);
    }

    const answerable = results.filter((r) => r.answerable && r.hybridHit !== null);
    const byCategory: Record<string, string> = {};
    for (const category of [...new Set(results.map((r) => r.category))]) {
      const rows = answerable.filter((r) => r.category === category);
      if (rows.length)
        byCategory[category] = `${rows.filter((r) => r.hybridHit).length}/${rows.length}`;
    }
    const pinned = fixture.questions.filter((q) => q.scope?.pin?.length);
    const answered = results.filter((r) => r.answer);
    const report: EvalReport = {
      startedAt: new Date().toISOString(),
      mode,
      embedding: {
        model: binding?.modelString ?? 'none (keyword-only)',
        real: realEmbedding,
        calls: embedCalls,
        inputTokens: embedTokens,
      },
      answerModel,
      indexing: { versions, chunks, ms: indexMs },
      retrieval: {
        recallAt5Hybrid: pct(answerable.filter((r) => r.hybridHit).length, answerable.length),
        recallAt5Lexical: pct(answerable.filter((r) => r.lexicalHit).length, answerable.length),
        byCategory,
        latencyMsP50: percentile(latencies, 50),
        latencyMsP95: percentile(latencies, 95),
      },
      isolation: {
        checkedHits: results.reduce((n, r) => n + r.hybridRefs.length + r.lexicalRefs.length, 0),
        foreignHits: results.reduce((n, r) => n + r.foreignHits, 0),
        outOfScopeHits: results.reduce((n, r) => n + r.outOfScopeHits, 0),
      },
      versions: {
        pinnedQuestions: pinned.length,
        correct: results.filter((r) => pinned.some((q) => q.id === r.id) && r.oldVersionHits === 0)
          .length,
        oldVersionHitsInCurrentScope: results
          .filter((r) => !pinned.some((q) => q.id === r.id))
          .reduce((n, r) => n + r.oldVersionHits, 0),
      },
      answers: answered.length
        ? {
            questions: answered.length,
            groundedClaims: answered.reduce((n, r) => n + r.answer!.groundedClaims, 0),
            supportedClaims: answered.reduce((n, r) => n + r.answer!.supportedClaims, 0),
            citationSupportRate: pct(
              answered.reduce((n, r) => n + r.answer!.supportedClaims, 0),
              answered.reduce((n, r) => n + r.answer!.groundedClaims, 0),
            ),
            notFoundQuestions: answered.filter((r) => !r.answerable).length,
            notFoundCorrect: answered.filter((r) => !r.answerable && r.answer!.notFoundCorrect)
              .length,
            notFoundWithSupplement: answered.filter(
              (r) => r.answer!.status === 'not_found' && r.answer!.supplements > 0,
            ).length,
            answerableAnsweredGrounded: answered.filter(
              (r) => r.answerable && r.answer!.status === 'answered',
            ).length,
            answerableQuestions: answered.filter((r) => r.answerable).length,
            modelCalls: answered.reduce((n, r) => n + r.answer!.modelCalls, 0),
            inputTokens: answered.reduce((n, r) => n + r.answer!.inputTokens, 0),
            outputTokens: answered.reduce((n, r) => n + r.answer!.outputTokens, 0),
          }
        : null,
      questions: results,
    };
    if (options.outDir) {
      mkdirSync(options.outDir, { recursive: true });
      writeFileSync(join(options.outDir, 'report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(options.outDir, 'report.md'), markdown(report));
    }
    return report;
  } finally {
    setMaterialByteStoreForTests(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

function scoreAnswer(
  question: FixtureQuestion,
  answer: StudyAnswerView,
  label: (versionId: string, page: number | null) => { ref: string },
): NonNullable<QuestionResult['answer']> {
  const byRef = new Map(answer.citations.map((citation) => [citation.ref, citation]));
  const mentions = (question.mention ?? []).map((m) => m.toLowerCase().replace(/\s+/g, ''));
  let grounded = 0;
  let supported = 0;
  for (const segment of answer.segments) {
    if (segment.kind !== 'grounded') continue;
    grounded += 1;
    const ok = segment.citations.some((ref) => {
      const citation = byRef.get(ref);
      if (!citation) return false;
      const location = label(citation.versionId, citation.pageNumber).ref;
      const quote = citation.quote.toLowerCase().replace(/\s+/g, '');
      return question.evidence.includes(location) || mentions.some((term) => quote.includes(term));
    });
    if (ok) supported += 1;
  }
  return {
    status: answer.status,
    groundedClaims: grounded,
    supportedClaims: supported,
    citedRefs: answer.citations.map(
      (citation) => label(citation.versionId, citation.pageNumber).ref,
    ),
    notFoundCorrect: question.answerable === false ? answer.status === 'not_found' : null,
    supplements: answer.segments.filter((segment) => segment.kind === 'supplement').length,
    modelCalls: answer.usage?.modelCalls ?? 0,
    inputTokens: answer.usage?.inputTokens ?? 0,
    outputTokens: answer.usage?.outputTokens ?? 0,
  };
}

function markdown(report: EvalReport): string {
  const lines = [
    `# B03 grounded-QA evaluation (${report.startedAt})`,
    '',
    `- Retrieval mode: ${report.mode}`,
    `- Embedding: \`${report.embedding.model}\` (${report.mode === 'keyword' ? 'not used' : report.embedding.real ? 'real' : 'fake hashing stand-in'}), ${report.embedding.calls} calls`,
    `- Answer model: ${report.answerModel ?? '—'}`,
    `- Indexed ${report.indexing.versions} versions, ${report.indexing.chunks} chunks in ${report.indexing.ms} ms`,
    '',
    '| Metric | Result |',
    '| --- | --- |',
    `| Evidence recall@5 (${report.mode}) | ${report.retrieval.recallAt5Hybrid} |`,
    `| Evidence recall@5 (keyword only) | ${report.retrieval.recallAt5Lexical} |`,
    `| Search latency p50 / p95 | ${report.retrieval.latencyMsP50} / ${report.retrieval.latencyMsP95} ms |`,
    `| Foreign-owner hits | ${report.isolation.foreignHits} of ${report.isolation.checkedHits} |`,
    `| Out-of-scope hits | ${report.isolation.outOfScopeHits} of ${report.isolation.checkedHits} |`,
    `| Pinned-version questions correct | ${report.versions.correct}/${report.versions.pinnedQuestions} |`,
    `| Old-version hits in current scope | ${report.versions.oldVersionHitsInCurrentScope} |`,
  ];
  if (report.answers) {
    lines.push(
      `| Citation support rate | ${report.answers.citationSupportRate} |`,
      `| Not-found correct | ${report.answers.notFoundCorrect}/${report.answers.notFoundQuestions} |`,
      `| Not-found answers with a model supplement | ${report.answers.notFoundWithSupplement} |`,
      `| Answerable questions answered with evidence | ${report.answers.answerableAnsweredGrounded}/${report.answers.answerableQuestions} |`,
      `| Model calls / tokens in / out | ${report.answers.modelCalls} / ${report.answers.inputTokens} / ${report.answers.outputTokens} |`,
    );
  }
  lines.push('', `## By category (${report.mode} recall@5)`, '');
  for (const [category, value] of Object.entries(report.retrieval.byCategory)) {
    lines.push(`- ${category}: ${value}`);
  }
  lines.push('', '## Misses', '');
  for (const q of report.questions.filter((r) => r.hybridHit === false)) {
    lines.push(`- ${q.id} (${q.category}): got ${q.hybridRefs.join(', ') || '—'}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const databaseUrl = process.env.EVAL_STUDY_DATABASE_URL;
  if (!databaseUrl)
    throw new Error('Set EVAL_STUDY_DATABASE_URL (disposable database with vector + pgroonga).');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'eval/study-qa/results', stamp);
  const report = await runStudyQaEval({
    databaseUrl,
    answers: process.argv.includes('--answers'),
    outDir,
  });
  console.log(markdown(report));
  console.log(`Report: ${outDir}`);
}

if (process.env.STUDY_QA_EVAL_MAIN === '1') {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
