import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { shouldIsolateOwner } from '@/lib/auth/principal';
import { createLogger } from '@/lib/logger';
import { getHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';
import { getProviderQuotaOwner } from '@/lib/server/generation-jobs/provider-call-context';
import { hasBillableTokens, type NormalizedUsage } from '@/lib/usage/normalize';
import type { UsageFunding } from '@/lib/model-gateway/runtime/usage';

const log = createLogger('UsageStorage');

/** Base directory for usage logs; lands in the openmaic-data volume in Docker. */
function usageDir(baseDir?: string): string {
  return baseDir ?? path.join(process.cwd(), 'data', 'usage');
}

/** Current month's jsonl file name, e.g. usage/2026-06.jsonl. */
function monthlyFile(dir: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(dir, `${y}-${m}.jsonl`);
}

/** What kind of generation produced this usage. */
export type UsageKind = 'llm' | 'image' | 'video' | 'tts' | 'asr';
/** Unit of the non-token quantity. */
export type UsageUnit = 'token' | 'image' | 'second' | 'character';

/** Input to record one generation's usage. LLM rows carry the gateway's funding fields. */
export interface UsageRecordInput extends Partial<UsageFunding> {
  /** Modality. Defaults to 'llm'. */
  kind?: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  /** Token usage (LLM only). */
  usage?: NormalizedUsage;
  /** Non-token quantity: images count / seconds / characters. */
  quantity?: number;
  /** Unit for `quantity`. */
  unit?: UsageUnit;
  /** Hosted-account owner. Absent on historical deployment-wide rows. */
  ownerId?: string;
  /** Stable caller identifier used to make retried usage writes idempotent. */
  eventKey?: string;
  jobId?: string;
  sessionId?: string;
  requestId?: string;
}

/**
 * A persisted usage row. `estimatedCostUsd` is the catalog estimate, not a
 * bill; funding fields are absent on rows written before they existed.
 */
export interface UsageRecord extends Partial<UsageFunding> {
  id: string;
  createdAt: number;
  kind: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  // LLM token counts (0 for non-LLM rows).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  // Non-token usage (e.g. image count, video seconds, TTS characters).
  quantity?: number;
  unit?: UsageUnit;
  ownerId?: string;
}

interface RecordOptions {
  baseDir?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

/** Only the funding fields that are set (a row omits unknown values). */
function fundingFields(input: Partial<UsageFunding>): Partial<UsageFunding> {
  return {
    ...(input.fundingKind ? { fundingKind: input.fundingKind } : {}),
    ...(input.platformDefaultId ? { platformDefaultId: input.platformDefaultId } : {}),
    ...(input.platformRevision ? { platformRevision: input.platformRevision } : {}),
    ...(input.credentialKind ? { credentialKind: input.credentialKind } : {}),
    ...(input.api ? { api: input.api } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.estimatedCostUsd !== undefined &&
    Number.isFinite(input.estimatedCostUsd) &&
    input.estimatedCostUsd >= 0
      ? { estimatedCostUsd: input.estimatedCostUsd }
      : {}),
  };
}

function makeId(now: Date): string {
  return `${now.getTime()}-${randomUUID()}`;
}

const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

/**
 * Records one generation's usage as a jsonl line. Fire-and-forget: never throws —
 * a logging failure must not break generation.
 *
 * - LLM rows: require billable tokens (skips empty usage, e.g. a streamed
 *   OpenAI-compatible response that omitted usage).
 * - Non-LLM rows (image/video/tts/asr): require quantity > 0.
 */
export async function recordUsage(
  input: UsageRecordInput,
  opts: RecordOptions = {},
): Promise<void> {
  // A test run must never append to the app's real usage log. Any test that
  // exercises the model gateway reaches this through `recordUsageSafe` without
  // asking for it, and used to write rows into the live `data/usage/` file —
  // `minimax-auth-test`, `serialization-test` and friends were sitting in there
  // next to production traffic, corrupting any real usage analysis. Tests that
  // mean to exercise storage pass an explicit `baseDir` (or mock this module),
  // so both of those keep working.
  if (
    !opts.baseDir &&
    !isHostedAuthEnabled() &&
    (process.env.VITEST || process.env.NODE_ENV === 'test')
  ) {
    return;
  }

  try {
    const kind: UsageKind = input.kind ?? 'llm';
    const usage = input.usage ?? ZERO_USAGE;

    if (kind === 'llm') {
      if (!hasBillableTokens(usage)) return;
    } else if (!input.quantity || input.quantity <= 0) {
      return;
    }

    const now = opts.now ?? new Date();
    const rootContext = getHeavyTaskRootContext();
    const ownerId = input.ownerId ?? rootContext?.ownerId ?? getProviderQuotaOwner();
    const record: UsageRecord = {
      id: makeId(now),
      createdAt: now.getTime(),
      kind,
      source: input.source,
      providerId: input.providerId,
      modelId: input.modelId,
      modelString: input.modelString,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      reasoningTokens: usage.reasoningTokens,
      ...(input.quantity != null ? { quantity: input.quantity } : {}),
      ...(input.unit ? { unit: input.unit } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...fundingFields(input),
    };

    if (isHostedAuthEnabled() && !opts.baseDir) {
      if (!record.ownerId) {
        log.warn('Skipped hosted usage event without a verified owner');
        return;
      }
      const db = createOwnerBoundQueryable(getPersistencePool(), record.ownerId);
      await db.query(
        `INSERT INTO usage_events (
           owner_id, event_key, source, kind, job_id, session_id, request_id,
           model, provider_id, model_id, model_string,
           input_tokens, output_tokens, cache_read_tokens,
           cache_creation_tokens, reasoning_tokens, quantity, unit, created_at,
           funding_kind, platform_default_id, platform_revision, credential_kind,
           api, status, estimated_cost_usd
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,$24,$25,$26
         )
         ON CONFLICT (owner_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          record.ownerId,
          input.eventKey ?? record.id,
          record.source,
          record.kind,
          input.jobId ?? rootContext?.rootTaskId ?? null,
          input.sessionId ?? null,
          input.requestId ?? null,
          record.modelString,
          record.providerId,
          record.modelId,
          record.modelString,
          record.inputTokens,
          record.outputTokens,
          record.cacheReadTokens,
          record.cacheCreationTokens,
          record.reasoningTokens,
          record.quantity ?? null,
          record.unit ?? null,
          new Date(record.createdAt),
          record.fundingKind ?? null,
          record.platformDefaultId ?? null,
          record.platformRevision ?? null,
          record.credentialKind ?? null,
          record.api ?? null,
          record.status ?? null,
          record.estimatedCostUsd ?? null,
        ],
      );
      return;
    }

    const dir = usageDir(opts.baseDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(monthlyFile(dir, now), JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.warn('Failed to record usage (ignored):', err);
  }
}

/** A non-LLM modality usage event (image / video / tts / asr). */
export interface GenerationUsageInput {
  kind: Exclude<UsageKind, 'llm'>;
  unit: UsageUnit;
  providerId: string;
  /** The client-requested model id; falls back to providerId when absent. */
  modelId?: string;
  quantity: number;
  ownerId?: string;
  eventKey?: string;
  jobId?: string;
  sessionId?: string;
  requestId?: string;
}

/**
 * Records a non-LLM generation's usage. Thin wrapper over {@link recordUsage}
 * that derives `source` (= kind) and `modelString` (`provider:model`) from the
 * modality, so the generate routes don't each repeat that construction.
 * Fire-and-forget like `recordUsage`.
 */
export function recordGenerationUsage(input: GenerationUsageInput): Promise<void> {
  const modelId = input.modelId || input.providerId;
  return recordUsage({
    kind: input.kind,
    unit: input.unit,
    source: input.kind,
    providerId: input.providerId,
    modelId,
    modelString: `${input.providerId}:${modelId}`,
    quantity: input.quantity,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.eventKey ? { eventKey: input.eventKey } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
}

interface ReadOptions {
  baseDir?: string;
  /** Limit to specific YYYY-MM month files; defaults to all files in the dir. */
  months?: string[];
}

/**
 * Reads all usage records (across monthly files). Returns [] when the dir is
 * absent. Malformed lines are skipped. Legacy rows without `kind` are treated as
 * 'llm'; any legacy cost fields are simply ignored.
 */
export async function readUsageRecords(
  opts: ReadOptions & { ownerId?: string } = {},
): Promise<UsageRecord[]> {
  if (isHostedAuthEnabled() && !opts.baseDir) {
    if (!opts.ownerId) throw new Error('HOSTED_USAGE_OWNER_REQUIRED');
    const db = createOwnerBoundQueryable(getPersistencePool(), opts.ownerId);
    const months = opts.months?.filter((month) => /^\d{4}-\d{2}$/.test(month));
    const result = await db.query<{
      id: string | number;
      created_at: Date | string;
      kind: UsageKind;
      source: string;
      provider_id: string | null;
      model_id: string | null;
      model_string: string | null;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      reasoning_tokens: number;
      quantity: string | number | null;
      unit: UsageUnit | null;
      owner_id: string;
      funding_kind: UsageFunding['fundingKind'] | null;
      platform_default_id: string | null;
      platform_revision: string | null;
      credential_kind: UsageFunding['credentialKind'] | null;
      api: string | null;
      status: UsageFunding['status'] | null;
      estimated_cost_usd: string | number | null;
    }>(
      `SELECT id, created_at, kind, source, provider_id, model_id, model_string, model,
              input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, reasoning_tokens, quantity, unit, owner_id,
              funding_kind, platform_default_id, platform_revision, credential_kind,
              api, status, estimated_cost_usd
         FROM usage_events
        WHERE owner_id=$1
          AND ($2::text[] IS NULL OR to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = ANY($2))
        ORDER BY created_at, id`,
      [opts.ownerId, months?.length ? months : null],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      createdAt: new Date(row.created_at).getTime(),
      kind: row.kind || 'llm',
      source: row.source,
      providerId: row.provider_id ?? 'unknown',
      modelId: row.model_id ?? row.model ?? 'unknown',
      modelString: row.model_string ?? row.model ?? row.model_id ?? 'unknown',
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      reasoningTokens: row.reasoning_tokens,
      ...(row.quantity == null ? {} : { quantity: Number(row.quantity) }),
      ...(row.unit ? { unit: row.unit } : {}),
      ownerId: row.owner_id,
      ...fundingFields({
        fundingKind: row.funding_kind ?? undefined,
        platformDefaultId: row.platform_default_id ?? undefined,
        platformRevision: row.platform_revision ?? undefined,
        credentialKind: row.credential_kind ?? undefined,
        api: row.api ?? undefined,
        status: row.status ?? undefined,
        estimatedCostUsd:
          row.estimated_cost_usd == null ? undefined : Number(row.estimated_cost_usd),
      }),
    }));
  }

  const dir = usageDir(opts.baseDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  if (opts.months?.length) {
    files = files.filter((f) => opts.months!.some((m) => f.startsWith(m)));
  }

  const records: UsageRecord[] = [];
  for (const file of files.sort()) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as UsageRecord;
        if (!row.kind) row.kind = 'llm'; // backward-compat
        if (opts.ownerId) {
          if (row.ownerId !== opts.ownerId) continue;
        } else if (shouldIsolateOwner(row.ownerId)) {
          continue;
        }
        records.push(row);
      } catch {
        // skip malformed line
      }
    }
  }
  return records;
}
