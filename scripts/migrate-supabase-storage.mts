/**
 * Idempotent local-Postgres -> hosted-Postgres/private-S3 migration.
 *
 * Default is a read-only dry run. `--apply` requires CONFIRM_STORAGE_MIGRATION=YES.
 * Credentials are loaded from gitignored operator files and are never logged.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool, type PoolClient } from 'pg';

import {
  proModelConnectionCiphertextsEqual,
  reassignProModelConnectionCiphertext,
} from '../lib/server/agent-runtime/model-connections';
import { reassignGenerationModelSnapshot } from '../lib/server/generation-model-snapshots';
import { reassignGenerationSearchSnapshot } from '../lib/server/generation-search-snapshots';
import { reassignMediaConfigSnapshot } from '../lib/server/media-config-snapshots';
import {
  HOSTED_PROJECT_REF,
  hostedAdminDatabaseUrl,
  hostedPgPool,
  loadHostedOperatorEnv,
} from './lib/hosted-operator-env';

type Row = Record<string, unknown>;

// The migration entry point is bundled into a temporary directory by
// run-storage-migration.mjs. Resolve operator files from the launch directory,
// which the wrapper intentionally pins to the repository root.
const ROOT = resolve(process.cwd());
const APPLY = process.argv.includes('--apply');
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
let adminUserId = '';
let adminOwnerId = '';

const TABLES = [
  'document_folders',
  'document_stages',
  'document_scenes',
  'document_outlines',
  'document_stage_revision',
  'document_scene_revision',
  'stage_meta',
  'runtime_sessions',
  'runtime_records',
  'asset_blobs',
  'asset_entries',
  'owner_material',
  'media_config_snapshots',
  'generation_model_snapshots',
  'generation_search_snapshots',
  'generation_jobs',
  'generation_ownership',
  'generation_scenes',
  'generation_steps',
  'generation_attempts',
  'generation_job_assets',
  'generation_events',
  'generation_commands',
  'agent_user_skill',
  'agent_sessions',
  'agent_session_events',
  'agent_session_entries',
  'agent_owner_session_events',
  'agent_owner_session_event_counters',
  'agent_session_urls',
  'agent_session_materials',
  'pro_model_connections',
  'pro_model_connection_revisions',
] as const;

type SnapshotTable =
  | 'media_config_snapshots'
  | 'generation_model_snapshots'
  | 'generation_search_snapshots';

interface MigrationTransformContext {
  folderIds: Map<string, string>;
  skillRefs: Map<string, string>;
  snapshotRefs: Record<SnapshotTable, Map<string, { id: string; revision: number }>>;
  ownerEventMax: Map<string, bigint>;
  resolutions: Array<Record<string, string>>;
}

function migrationContext(): MigrationTransformContext {
  return {
    folderIds: new Map(),
    skillRefs: new Map(),
    snapshotRefs: {
      media_config_snapshots: new Map(),
      generation_model_snapshots: new Map(),
      generation_search_snapshots: new Map(),
    },
    ownerEventMax: new Map(),
    resolutions: [],
  };
}

const OWNER_COLUMNS: Record<string, string[]> = {
  document_folders: ['owner_id'],
  document_stages: ['owner_id'],
  stage_meta: ['owner_id'],
  runtime_sessions: ['learner_key'],
  asset_entries: ['principal'],
  owner_material: ['owner_id'],
  media_config_snapshots: ['owner_id'],
  generation_model_snapshots: ['owner_id'],
  generation_search_snapshots: ['owner_id'],
  generation_jobs: ['owner_id'],
  generation_ownership: ['owner_id'],
  agent_sessions: ['owner_id'],
  agent_owner_session_event_counters: ['owner_id'],
  agent_owner_session_events: ['owner_id'],
  agent_user_skill: ['owner_id'],
  pro_model_connections: ['owner_id'],
};

function loadPrivateEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]!] === undefined) {
      const raw = match[2] ?? '';
      const quoted =
        raw.length >= 2 &&
        ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
      process.env[match[1]!] = quoted ? raw.slice(1, -1) : raw;
    }
  }
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function migrationObjectConcurrency(): number {
  const raw = process.env.MIGRATION_OBJECT_CONCURRENCY?.trim();
  if (!raw) return 8;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('MIGRATION_OBJECT_CONCURRENCY must be an integer from 1 to 32');
  }
  return value;
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await task(items[index]!);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

function mappedOwner(value: unknown): unknown {
  return typeof value === 'string' && value.startsWith('anon:') ? adminOwnerId : value;
}

function sourceKey(ownerId: string, value: unknown): string {
  return `${ownerId}\0${String(value ?? '')}`;
}

function stableSuffix(...parts: unknown[]): string {
  return createHash('sha256').update(parts.map(String).join('\0')).digest('hex').slice(0, 10);
}

export function assertMigrationArgs(args: readonly string[]): void {
  if (args.includes('--skip-object-readback')) {
    throw new Error('--skip-object-readback is not supported; object readback is mandatory');
  }
}

function agentEntryIdentity(row: Row): { sessionId: string; entryId: string } {
  if (typeof row.session_id !== 'string' || !row.session_id) {
    throw new Error('agent session entry has an invalid session_id');
  }
  if (typeof row.entry_id !== 'string' || !row.entry_id) {
    throw new Error(`agent session entry in ${row.session_id} has an invalid entry_id`);
  }
  return { sessionId: row.session_id, entryId: row.entry_id };
}

function compareAgentEntries(left: Row, right: Row): number {
  const a = agentEntryIdentity(left);
  const b = agentEntryIdentity(right);
  return a.sessionId.localeCompare(b.sessionId) || a.entryId.localeCompare(b.entryId);
}

/**
 * PostgreSQL checks the self-FK at each INSERT statement. Keep every parent in
 * an earlier (or the same) batch, independent of source query order, and stop
 * rather than silently dropping broken ancestry.
 */
export function sortAgentSessionEntriesParentFirst<T extends Row>(rows: readonly T[]): T[] {
  const byIdentity = new Map<string, T>();
  const children = new Map<string, T[]>();
  const indegree = new Map<string, number>();
  const identity = (sessionId: string, entryId: string) => `${sessionId}\0${entryId}`;

  for (const row of rows) {
    const { sessionId, entryId } = agentEntryIdentity(row);
    const key = identity(sessionId, entryId);
    if (byIdentity.has(key)) {
      throw new Error(`duplicate agent session entry: ${sessionId}/${entryId}`);
    }
    byIdentity.set(key, row);
    indegree.set(key, 0);
  }

  for (const row of rows) {
    const { sessionId, entryId } = agentEntryIdentity(row);
    if (row.parent_id == null) continue;
    if (typeof row.parent_id !== 'string' || !row.parent_id) {
      throw new Error(`agent session entry has an invalid parent: ${sessionId}/${entryId}`);
    }
    const parentKey = identity(sessionId, row.parent_id);
    if (!byIdentity.has(parentKey)) {
      throw new Error(
        `agent session entry missing parent: ${sessionId}/${entryId} -> ${row.parent_id}`,
      );
    }
    const childKey = identity(sessionId, entryId);
    indegree.set(childKey, 1);
    const siblings = children.get(parentKey) ?? [];
    siblings.push(row);
    children.set(parentKey, siblings);
  }

  const ready = rows.filter((row) => {
    const { sessionId, entryId } = agentEntryIdentity(row);
    return indegree.get(identity(sessionId, entryId)) === 0;
  });
  ready.sort(compareAgentEntries);
  const ordered: T[] = [];
  while (ready.length) {
    const row = ready.shift()!;
    ordered.push(row);
    const { sessionId, entryId } = agentEntryIdentity(row);
    for (const child of children.get(identity(sessionId, entryId)) ?? []) {
      const childIdentity = agentEntryIdentity(child);
      const childKey = identity(childIdentity.sessionId, childIdentity.entryId);
      indegree.set(childKey, 0);
      ready.push(child);
    }
    ready.sort(compareAgentEntries);
  }
  if (ordered.length !== rows.length) {
    const cycle = rows
      .filter((row) => !ordered.includes(row))
      .sort(compareAgentEntries)
      .map((row) => {
        const { sessionId, entryId } = agentEntryIdentity(row);
        return `${sessionId}/${entryId}`;
      });
    throw new Error(`agent session entry parent cycle: ${cycle.join(',')}`);
  }
  return ordered;
}

function deterministicRunId(...parts: string[]): string {
  const bytes = Buffer.from(createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function refKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Row;
  if (typeof ref.id !== 'string' || !Number.isInteger(Number(ref.revision))) return undefined;
  return `${ref.id}\0${Number(ref.revision)}`;
}

function rewriteRef(value: unknown, refs: Map<string, { id: string; revision: number }>): unknown {
  const key = refKey(value);
  return key && refs.has(key) ? refs.get(key) : value;
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`unsafe identifier ${identifier}`);
  return `"${identifier}"`;
}

function canonical(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('base64')}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Row)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function counts(pool: Pool): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quote(table)}`);
    result[table] = Number(row.rows[0]?.n ?? 0);
  }
  return result;
}

async function sourceFingerprint(
  pool: Pool,
): Promise<{ fingerprint: string; counts: Record<string, number> }> {
  const tableCounts = await counts(pool);
  const stats = await pool.query<{ stages: string; tombstones: string; bytes: string }>(
    `SELECT
       (SELECT count(*)::text FROM document_stages) AS stages,
       (SELECT count(*)::text FROM stage_meta WHERE deleted_at IS NOT NULL) AS tombstones,
       (SELECT coalesce(sum(octet_length(bytes)),0)::text FROM asset_blobs) AS bytes`,
  );
  const digest = createHash('sha256').update(canonical({ ...tableCounts, ...stats.rows[0] }));
  for (const table of TABLES) {
    digest.update(`\0table:${table}\0`);
    const rows = await pool.query<{ encoded: string }>(
      table === 'asset_blobs'
        ? `SELECT to_jsonb(x)::text AS encoded FROM (
             SELECT content_hash,byte_size,unreferenced_at FROM asset_blobs
             ORDER BY content_hash
           ) x`
        : `SELECT to_jsonb(t)::text AS encoded FROM ${quote(table)} t
             ORDER BY to_jsonb(t)::text`,
    );
    for (const row of rows.rows) digest.update(row.encoded).update('\0');
  }
  return {
    fingerprint: digest.digest('hex'),
    counts: tableCounts,
  };
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: required('ASSET_S3_ENDPOINT', process.env.ASSET_S3_ENDPOINT),
    region: required('ASSET_S3_REGION', process.env.ASSET_S3_REGION),
    forcePathStyle: process.env.ASSET_S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: required('ASSET_S3_ACCESS_KEY_ID', process.env.ASSET_S3_ACCESS_KEY_ID),
      secretAccessKey: required(
        'ASSET_S3_SECRET_ACCESS_KEY',
        process.env.ASSET_S3_SECRET_ACCESS_KEY,
      ),
    },
  });
}

const S3_OPERATION_TIMEOUT_MS = 60_000;

function s3SendOptions() {
  return { abortSignal: AbortSignal.timeout(S3_OPERATION_TIMEOUT_MS) };
}

async function ensurePrivateBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), s3SendOptions());
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }), s3SendOptions());
  }
}

async function readS3Bytes(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const object = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    s3SendOptions(),
  );
  if (!object.Body) throw new Error(`object read returned no body: ${bucket}/${key}`);
  return Buffer.from(await object.Body.transformToByteArray());
}

async function recordObject(
  target: Pool,
  runId: string,
  sourceKind: string,
  sourceKey: string,
  bucket: string,
  key: string,
  bytes: Buffer,
): Promise<void> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  await target.query(
    `INSERT INTO storage_migration_objects
       (run_id,source_kind,source_key,target_bucket,target_key,byte_size,sha256,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,'pending')
     ON CONFLICT(run_id,source_kind,source_key) DO UPDATE SET
       target_bucket=EXCLUDED.target_bucket,target_key=EXCLUDED.target_key,
       byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,status='pending',last_error=NULL,
       updated_at=clock_timestamp()`,
    [runId, sourceKind, sourceKey, bucket, key, bytes.byteLength, digest],
  );
}

function missingS3Object(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function sameObjectBytes(actual: Buffer, expected: Buffer): boolean {
  if (actual.byteLength !== expected.byteLength) return false;
  const actualHash = createHash('sha256').update(actual).digest('hex');
  const expectedHash = createHash('sha256').update(expected).digest('hex');
  return actualHash === expectedHash;
}

interface VerifiedObjectLedgerRow {
  source_key: string;
  target_bucket: string;
  target_key: string;
  byte_size: string;
  sha256: string;
  status: string;
}

export function canReuseVerifiedObject(
  row: VerifiedObjectLedgerRow | undefined,
  expected: { sourceKey: string; bucket: string; key: string; byteSize: number; sha256: string },
): boolean {
  return Boolean(
    row &&
      row.status === 'verified' &&
      row.source_key === expected.sourceKey &&
      row.target_bucket === expected.bucket &&
      row.target_key === expected.key &&
      Number(row.byte_size) === expected.byteSize &&
      row.sha256 === expected.sha256,
  );
}

async function markObjectVerified(
  target: Pool,
  runId: string,
  sourceKind: string,
  sourceKey: string,
): Promise<void> {
  await target.query(
    `UPDATE storage_migration_objects SET status='verified',last_error=NULL,updated_at=clock_timestamp()
     WHERE run_id=$1 AND source_kind=$2 AND source_key=$3`,
    [runId, sourceKind, sourceKey],
  );
}

export async function copyObject(
  client: S3Client,
  target: Pool,
  runId: string,
  sourceKind: string,
  sourceKey: string,
  bucket: string,
  key: string,
  bytes: Buffer,
  mime?: string,
): Promise<void> {
  await recordObject(target, runId, sourceKind, sourceKey, bucket, key, bytes);
  try {
    let existing: Buffer | undefined;
    try {
      existing = await readS3Bytes(client, bucket, key);
    } catch (error) {
      if (!missingS3Object(error)) throw error;
    }
    if (existing) {
      if (!sameObjectBytes(existing, bytes)) {
        throw new Error(`destination object conflict: ${bucket}/${key}`);
      }
      await markObjectVerified(target, runId, sourceKind, sourceKey);
      return;
    }

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ...(mime ? { ContentType: mime } : {}),
      }),
      s3SendOptions(),
    );
    await target.query(
      `UPDATE storage_migration_objects SET status='copied',last_error=NULL,updated_at=clock_timestamp()
       WHERE run_id=$1 AND source_kind=$2 AND source_key=$3`,
      [runId, sourceKind, sourceKey],
    );
    const roundTrip = await readS3Bytes(client, bucket, key);
    if (!sameObjectBytes(roundTrip, bytes)) {
      throw new Error(`object verification mismatch: ${sourceKind}/${sourceKey}`);
    }
    await markObjectVerified(target, runId, sourceKind, sourceKey);
  } catch (error) {
    await target.query(
      `UPDATE storage_migration_objects SET status='failed',last_error=$4,updated_at=clock_timestamp()
       WHERE run_id=$1 AND source_kind=$2 AND source_key=$3`,
      [runId, sourceKind, sourceKey, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}

async function primaryKey(client: PoolClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey,a.attnum)`,
    [`public.${table}`],
  );
  return result.rows.map((row) => row.column_name);
}

async function targetColumns(client: PoolClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function targetJsonColumns(client: PoolClient, table: string): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
        AND data_type IN ('json','jsonb')`,
    [table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function databaseComparableValue(column: string, value: unknown, jsonColumns: Set<string>) {
  if (!jsonColumns.has(column)) return value;
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Keep the indexed partition and the HTTP ownership payload atomic during migration. */
export function remapRuntimeSessionLearner(sourceRow: Row, targetLearnerKey: string): Row {
  const sourceLearner = sourceRow.learner_key;
  const data = sourceRow.data;
  if (
    typeof sourceLearner !== 'string' ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    (data as Row).learnerKey !== sourceLearner
  ) {
    throw new Error('Runtime session source learner column and JSON disagree');
  }
  if (sourceLearner !== targetLearnerKey && !sourceLearner.startsWith('anon:')) {
    throw new Error('Refusing to remap a signed-user runtime learner');
  }
  return {
    ...sourceRow,
    learner_key: targetLearnerKey,
    data: { ...data, learnerKey: targetLearnerKey },
  };
}

function transformRow(table: string, sourceRow: Row, context: MigrationTransformContext): Row {
  const row = { ...sourceRow };
  const oldOwner = OWNER_COLUMNS[table]
    ?.map((column) => row[column])
    .find((value) => (typeof value === 'string' ? value.startsWith('anon:') : false));
  for (const column of OWNER_COLUMNS[table] ?? []) row[column] = mappedOwner(row[column]);

  if (table === 'runtime_sessions') {
    return remapRuntimeSessionLearner(sourceRow, String(row.learner_key));
  }

  if (table === 'document_stages' && oldOwner && row.folder_id) {
    row.folder_id =
      context.folderIds.get(sourceKey(String(oldOwner), row.folder_id)) ?? row.folder_id;
  }
  if (table === 'agent_sessions' && oldOwner) {
    if (row.skill_id) {
      row.skill_id =
        context.skillRefs.get(sourceKey(String(oldOwner), row.skill_id)) ?? row.skill_id;
    }
    row.media_config_ref = rewriteRef(
      row.media_config_ref,
      context.snapshotRefs.media_config_snapshots,
    );
    row.active_media_config_ref = rewriteRef(
      row.active_media_config_ref,
      context.snapshotRefs.media_config_snapshots,
    );
  }

  if (table === 'generation_jobs') {
    row.worker_id = null;
    row.lease_expires_at = null;
    row.heartbeat_at = null;
    if (
      row.status === 'running' ||
      row.status === 'queued' ||
      row.status === 'retry_wait' ||
      row.status === 'awaiting_confirmation'
    ) {
      row.status = 'needs_attention';
      row.last_error_code = 'MIGRATED_INTERRUPTED_TASK';
      row.last_error_summary = 'Historical task requires explicit review after migration';
      row.auto_continue_at = null;
    }
    if (row.input_snapshot && typeof row.input_snapshot === 'object') {
      const input = { ...(row.input_snapshot as Row) };
      input.mediaConfigRef = rewriteRef(
        input.mediaConfigRef,
        context.snapshotRefs.media_config_snapshots,
      );
      input.modelConfigRef = rewriteRef(
        input.modelConfigRef,
        context.snapshotRefs.generation_model_snapshots,
      );
      input.searchConfigRef = rewriteRef(
        input.searchConfigRef,
        context.snapshotRefs.generation_search_snapshots,
      );
      row.input_snapshot = input;
    }
  }
  if (table === 'agent_sessions') {
    row.lease_worker_id = null;
    row.lease_worker_pid = null;
    row.lease_heartbeat_at = null;
    if (oldOwner && (row.status === 'running' || row.status === 'queued')) {
      row.status = 'failed';
      row.error = 'Historical anonymous session was migrated without automatic replay';
    }
  }
  if (table === 'agent_session_materials') {
    row.extraction_lease_worker_id = null;
    row.extraction_lease_worker_pid = null;
    row.extraction_lease_heartbeat_at = null;
    if (row.extraction_status === 'pending' || row.extraction_status === 'running') {
      row.extraction_status = 'failed';
      row.extraction_error = 'Historical extraction was migrated without automatic replay';
    }
  }
  if (table === 'generation_attempts' && row.outcome === 'running') {
    row.outcome = 'uncertain';
    row.finished_at = row.finished_at ?? row.started_at;
  }
  return row;
}

function reencryptRow(table: string, row: Row, oldOwner: string | undefined): Row {
  if (!oldOwner || oldOwner === row.owner_id) return row;
  if (table === 'generation_model_snapshots') {
    const ref = { id: String(row.id), revision: Number(row.revision) };
    const migrated = reassignGenerationModelSnapshot(
      String(row.ciphertext),
      oldOwner,
      String(row.owner_id),
      ref,
    );
    return { ...row, ciphertext: migrated.ciphertext, intent_digest: migrated.intentDigest };
  }
  if (table === 'media_config_snapshots') {
    const ref = { id: String(row.id), revision: Number(row.revision) };
    const migrated = reassignMediaConfigSnapshot(
      String(row.ciphertext),
      oldOwner,
      String(row.owner_id),
      ref,
      Number(row.schema_version),
    );
    return { ...row, ciphertext: migrated.ciphertext, intent_digest: migrated.intentDigest };
  }
  if (table === 'generation_search_snapshots') {
    const ref = { id: String(row.id), revision: Number(row.revision) };
    const migrated = reassignGenerationSearchSnapshot(
      String(row.ciphertext),
      oldOwner,
      String(row.owner_id),
      ref,
    );
    return { ...row, ciphertext: migrated.ciphertext, intent_digest: migrated.intentDigest };
  }
  return row;
}

async function upsertRows(target: Pool, table: string, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const client = await target.connect();
  try {
    const allowed = await targetColumns(client, table);
    const columns = allowed.filter((column) => column !== 'bytes' && column in rows[0]!);
    const jsonColumns = await targetJsonColumns(client, table);
    const pk = await primaryKey(client, table);
    if (!pk.length) throw new Error(`missing primary key for ${table}`);
    const monotonicColumn =
      table === 'document_stage_revision' || table === 'document_scene_revision'
        ? 'rev'
        : table === 'agent_owner_session_event_counters'
          ? 'n'
          : undefined;
    // Keep retries efficient over the hosted pooler while staying comfortably
    // below PostgreSQL's parameter limit for the widest migrated table.
    const batchSize = 250;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const params: unknown[] = [];
      const values = batch
        .map((row) => {
          const placeholders = columns.map((column) => {
            const value = row[column];
            // node-postgres serializes JavaScript arrays as PostgreSQL arrays,
            // which is not valid input for json/jsonb columns. Preserve the
            // source JSON shape explicitly for both arrays and objects.
            params.push(jsonColumns.has(column) && value != null ? JSON.stringify(value) : value);
            return `$${params.length}`;
          });
          return `(${placeholders.join(',')})`;
        })
        .join(',');
      await client.query(
        `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')})${
          table === 'generation_events' ? ' OVERRIDING SYSTEM VALUE' : ''
        } VALUES ${values}
         ON CONFLICT (${pk.map(quote).join(',')}) ${
           monotonicColumn
             ? `DO UPDATE SET ${quote(monotonicColumn)}=GREATEST(${quote(table)}.${quote(monotonicColumn)},EXCLUDED.${quote(monotonicColumn)})`
             : 'DO NOTHING'
         }`,
        params,
      );

      // Never overwrite a hosted row.  Exact rows make retries idempotent;
      // any unequal primary-key collision is a hard stop requiring an explicit
      // reference mapping rather than silent corruption of signed-in data.
      const keyParams: unknown[] = [];
      const keyTuples = batch
        .map((row) => {
          const placeholders = pk.map((column) => {
            keyParams.push(row[column]);
            return `$${keyParams.length}`;
          });
          return `(${placeholders.join(',')})`;
        })
        .join(',');
      const found = await client.query<Row>(
        `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}
          WHERE (${pk.map(quote).join(',')}) IN (${keyTuples})`,
        keyParams,
      );
      const expected = new Map(
        batch.map((row) => [
          canonical(pk.map((column) => row[column])),
          canonical(
            columns.map((column) => databaseComparableValue(column, row[column], jsonColumns)),
          ),
        ]),
      );
      for (const row of found.rows) {
        const key = canonical(pk.map((column) => row[column]));
        const expectedRow = batch.find(
          (candidate) => canonical(pk.map((column) => candidate[column])) === key,
        );
        const matches = monotonicColumn
          ? Boolean(expectedRow) &&
            BigInt(String(row[monotonicColumn])) >= BigInt(String(expectedRow![monotonicColumn]))
          : expected.get(key) ===
            canonical(
              columns.map((column) => databaseComparableValue(column, row[column], jsonColumns)),
            );
        if (!matches) {
          const differingColumns = expectedRow
            ? columns.filter(
                (column) =>
                  canonical([databaseComparableValue(column, row[column], jsonColumns)]) !==
                  canonical([databaseComparableValue(column, expectedRow[column], jsonColumns)]),
              )
            : ['primary_key'];
          throw new Error(
            `target row conflict for ${table} (columns: ${differingColumns.join(',')})`,
          );
        }
        expected.delete(key);
      }
      if (expected.size) throw new Error(`row verification failed for ${table}`);
    }
  } finally {
    client.release();
  }
}

async function resolveFolderConflicts(
  target: Pool,
  sourceRows: Row[],
  migratedRows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const targetRows = await target.query<Row>(
    'SELECT owner_id,id,name,normalized_name FROM document_folders',
  );
  const usedIds = new Map<string, Set<string>>();
  const usedNames = new Map<string, Map<string, string>>();
  const existingByKey = new Map<string, Row>();
  for (const row of targetRows.rows) {
    const owner = String(row.owner_id);
    (usedIds.get(owner) ?? usedIds.set(owner, new Set()).get(owner)!).add(String(row.id));
    (usedNames.get(owner) ?? usedNames.set(owner, new Map()).get(owner)!).set(
      String(row.normalized_name),
      String(row.id),
    );
    existingByKey.set(sourceKey(owner, row.id), row);
  }
  const pairs = sourceRows
    .map((source, index) => ({ source, row: { ...migratedRows[index]! } }))
    .sort((a, b) => {
      const aAnon = String(a.source.owner_id).startsWith('anon:') ? 1 : 0;
      const bAnon = String(b.source.owner_id).startsWith('anon:') ? 1 : 0;
      return (
        aAnon - bAnon ||
        String(a.source.owner_id).localeCompare(String(b.source.owner_id)) ||
        String(a.source.id).localeCompare(String(b.source.id))
      );
    });
  for (const pair of pairs) {
    const oldOwner = String(pair.source.owner_id);
    const owner = String(pair.row.owner_id);
    const originalId = String(pair.row.id);
    const isAnonymous = oldOwner.startsWith('anon:');
    const possibleTarget = existingByKey.get(sourceKey(owner, originalId));
    const suffix = stableSuffix(oldOwner, originalId);
    const priorMigration =
      isAnonymous &&
      possibleTarget &&
      [
        String(pair.row.normalized_name),
        `${String(pair.row.normalized_name)}--migrated-${suffix}`,
      ].includes(String(possibleTarget.normalized_name));
    const exactTarget = !isAnonymous || priorMigration ? possibleTarget : undefined;
    if (priorMigration) {
      pair.row.name = possibleTarget!.name;
      pair.row.normalized_name = possibleTarget!.normalized_name;
    }
    const ids = usedIds.get(owner) ?? new Set<string>();
    const names = usedNames.get(owner) ?? new Map<string, string>();
    usedIds.set(owner, ids);
    usedNames.set(owner, names);
    if (!exactTarget && ids.has(String(pair.row.id))) {
      pair.row.id = `migrated-folder-${stableSuffix(oldOwner, originalId)}`;
      context.resolutions.push({
        kind: 'folder-id',
        sourceOwner: oldOwner,
        sourceId: originalId,
        targetId: String(pair.row.id),
      });
    }
    let normalized = String(pair.row.normalized_name);
    const holder = names.get(normalized);
    if (!exactTarget && holder && holder !== String(pair.row.id)) {
      pair.row.name = `${String(pair.row.name)} (migrated ${suffix})`;
      normalized = `${normalized}--migrated-${suffix}`;
      pair.row.normalized_name = normalized;
      context.resolutions.push({
        kind: 'folder-name',
        sourceOwner: oldOwner,
        sourceId: originalId,
        targetId: String(pair.row.id),
      });
    }
    ids.add(String(pair.row.id));
    names.set(normalized, String(pair.row.id));
    context.folderIds.set(sourceKey(oldOwner, originalId), String(pair.row.id));
  }
  return pairs.map((pair) => pair.row);
}

async function resolveSkillConflicts(
  target: Pool,
  sourceRows: Row[],
  migratedRows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const targetRows = await target.query<Row>(
    'SELECT id,owner_id,name,deleted_at FROM agent_user_skill',
  );
  const targetIds = new Map(targetRows.rows.map((row) => [String(row.id), row]));
  const liveNames = new Map<string, string>();
  for (const row of targetRows.rows) {
    if (row.deleted_at == null)
      liveNames.set(sourceKey(String(row.owner_id), row.name), String(row.id));
  }
  const pairs = sourceRows
    .map((source, index) => ({ source, row: { ...migratedRows[index]! } }))
    .sort((a, b) => {
      const aAnon = String(a.source.owner_id).startsWith('anon:') ? 1 : 0;
      const bAnon = String(b.source.owner_id).startsWith('anon:') ? 1 : 0;
      return aAnon - bAnon || String(a.source.id).localeCompare(String(b.source.id));
    });
  for (const pair of pairs) {
    const oldOwner = String(pair.source.owner_id);
    const owner = String(pair.row.owner_id);
    const originalId = String(pair.row.id);
    const originalName = String(pair.row.name);
    const targetId = targetIds.get(originalId);
    const suffix = stableSuffix(oldOwner, originalId);
    const expectedRenamed = `${originalName
      .slice(0, Math.max(3, 64 - suffix.length - 1))
      .replace(/-+$/g, '')}-${suffix}`;
    const priorMigration =
      oldOwner.startsWith('anon:') &&
      targetId &&
      String(targetId.owner_id) === owner &&
      [originalName, expectedRenamed].includes(String(targetId.name));
    if (priorMigration) {
      pair.row.name = targetId!.name;
    } else if (targetId && (oldOwner.startsWith('anon:') || String(targetId.owner_id) !== owner)) {
      pair.row.id = `migrated-skill-${stableSuffix(oldOwner, originalId)}`;
      context.resolutions.push({
        kind: 'skill-id',
        sourceOwner: oldOwner,
        sourceId: originalId,
        targetId: String(pair.row.id),
      });
    }
    if (pair.row.deleted_at == null) {
      const holder = liveNames.get(sourceKey(owner, pair.row.name));
      if (holder && holder !== String(pair.row.id)) {
        const base = originalName.slice(0, Math.max(3, 64 - suffix.length - 1)).replace(/-+$/g, '');
        pair.row.name = `${base}-${suffix}`;
        context.resolutions.push({
          kind: 'skill-name',
          sourceOwner: oldOwner,
          sourceId: originalId,
          targetId: String(pair.row.id),
        });
      }
      liveNames.set(sourceKey(owner, pair.row.name), String(pair.row.id));
    }
    targetIds.set(String(pair.row.id), pair.row);
    context.skillRefs.set(sourceKey(oldOwner, originalId), String(pair.row.id));
    context.skillRefs.set(sourceKey(oldOwner, originalName), String(pair.row.name));
  }
  return pairs.map((pair) => pair.row);
}

async function resolveGenerationJobConflicts(
  target: Pool,
  sourceRows: Row[],
  migratedRows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const targetRows = await target.query<Row>(
    'SELECT id,owner_id,idempotency_key FROM generation_jobs',
  );
  const keys = new Map<string, string>();
  const targetIds = new Map<string, Row>();
  for (const row of targetRows.rows) {
    keys.set(sourceKey(String(row.owner_id), row.idempotency_key), String(row.id));
    targetIds.set(String(row.id), row);
  }
  const pairs = sourceRows
    .map((source, index) => ({ source, row: { ...migratedRows[index]! } }))
    .sort((a, b) => {
      const aAnon = String(a.source.owner_id).startsWith('anon:') ? 1 : 0;
      const bAnon = String(b.source.owner_id).startsWith('anon:') ? 1 : 0;
      return aAnon - bAnon || String(a.source.id).localeCompare(String(b.source.id));
    });
  for (const pair of pairs) {
    const oldOwner = String(pair.source.owner_id);
    const owner = String(pair.row.owner_id);
    const id = String(pair.row.id);
    const existingId = targetIds.get(id);
    if (existingId && String(existingId.owner_id) === owner) {
      pair.row.idempotency_key = existingId.idempotency_key;
    }
    const holder = keys.get(sourceKey(owner, pair.row.idempotency_key));
    if ((!existingId || String(existingId.owner_id) !== owner) && holder && holder !== id) {
      pair.row.idempotency_key = `${String(pair.row.idempotency_key)}:migrated:${stableSuffix(oldOwner, id)}`;
      context.resolutions.push({
        kind: 'generation-idempotency',
        sourceOwner: oldOwner,
        sourceId: id,
      });
    }
    keys.set(sourceKey(owner, pair.row.idempotency_key), id);
    targetIds.set(id, pair.row);
  }
  return pairs.map((pair) => pair.row);
}

async function resolveOwnerEventConflicts(
  target: Pool,
  sourceRows: Row[],
  migratedRows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const targetRows = await target.query<Row>('SELECT * FROM agent_owner_session_events');
  const occupied = new Map<string, Row>();
  for (const row of targetRows.rows) {
    const owner = String(row.owner_id);
    const id = BigInt(String(row.id));
    occupied.set(sourceKey(owner, id), row);
    const previous = context.ownerEventMax.get(owner) ?? BIGINT_ZERO;
    if (id > previous) context.ownerEventMax.set(owner, id);
  }
  const pairs = sourceRows.map((source, index) => ({
    source,
    row: { ...migratedRows[index]! },
  }));
  const anonymous = pairs
    .filter((pair) => String(pair.source.owner_id).startsWith('anon:'))
    .sort(
      (a, b) =>
        Number(BigInt(String(a.source.ts)) - BigInt(String(b.source.ts))) ||
        String(a.source.owner_id).localeCompare(String(b.source.owner_id)) ||
        Number(BigInt(String(a.source.id)) - BigInt(String(b.source.id))),
    );
  const targetColumns = ['owner_id', 'id', 'ts', 'session_id', 'type', 'status', 'attempt', 'data'];
  let priorTimestamp = -BIGINT_ONE;
  let timestampOrdinal = BIGINT_ZERO;
  for (const pair of anonymous) {
    const timestamp = BigInt(String(pair.source.ts));
    timestampOrdinal = timestamp === priorTimestamp ? timestampOrdinal + BIGINT_ONE : BIGINT_ZERO;
    priorTimestamp = timestamp;
    let candidate = timestamp * BigInt(1_000_000) + timestampOrdinal;
    if (candidate > BigInt('9223372036854775807')) {
      throw new Error('owner event id migration exceeds bigint range');
    }
    const owner = String(pair.row.owner_id);
    while (true) {
      const found = occupied.get(sourceKey(owner, candidate));
      if (!found) break;
      const expected: Row = { ...pair.row, id: candidate.toString() };
      if (
        canonical(targetColumns.map((column) => found[column])) ===
        canonical(targetColumns.map((column) => expected[column]))
      ) {
        break;
      }
      candidate += BIGINT_ONE;
    }
    pair.row.id = candidate.toString();
    occupied.set(sourceKey(owner, candidate), pair.row);
    const previous = context.ownerEventMax.get(owner) ?? BIGINT_ZERO;
    if (candidate > previous) context.ownerEventMax.set(owner, candidate);
    context.resolutions.push({
      kind: 'owner-event-id',
      sourceOwner: String(pair.source.owner_id),
      sourceId: String(pair.source.id),
      targetId: candidate.toString(),
    });
  }
  for (const pair of pairs.filter((item) => !String(item.source.owner_id).startsWith('anon:'))) {
    const owner = String(pair.row.owner_id);
    const id = BigInt(String(pair.row.id));
    const previous = context.ownerEventMax.get(owner) ?? BIGINT_ZERO;
    if (id > previous) context.ownerEventMax.set(owner, id);
  }
  return pairs.map((pair) => pair.row);
}

async function resolveOwnerEventCounters(
  target: Pool,
  migratedRows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const existing = await target.query<Row>(
    'SELECT owner_id,n FROM agent_owner_session_event_counters',
  );
  const maximum = new Map<string, bigint>();
  for (const row of [...existing.rows, ...migratedRows]) {
    const owner = String(row.owner_id);
    const value = BigInt(String(row.n));
    if (value > (maximum.get(owner) ?? BIGINT_ZERO)) maximum.set(owner, value);
  }
  for (const [owner, value] of context.ownerEventMax) {
    if (value > (maximum.get(owner) ?? BIGINT_ZERO)) maximum.set(owner, value);
  }
  return [...maximum].map(([owner_id, n]) => ({ owner_id, n: n.toString() }));
}

async function deduplicateSnapshotRows(
  target: Pool,
  table: SnapshotTable,
  rows: Row[],
  context: MigrationTransformContext,
): Promise<Row[]> {
  const targetRows = await target.query<Row>(
    `SELECT id,revision,owner_id,intent_digest FROM ${quote(table)}
      WHERE revoked_at IS NULL ORDER BY owner_id,intent_digest,id,revision`,
  );
  const canonicalRefs = new Map<string, { id: string; revision: number }>();
  for (const row of targetRows.rows) {
    const key = sourceKey(String(row.owner_id), row.intent_digest);
    if (!canonicalRefs.has(key)) {
      canonicalRefs.set(key, {
        id: String(row.id),
        revision: Number(row.revision),
      });
    }
  }
  const result: Row[] = [];
  for (const row of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const ownRef = { id: String(row.id), revision: Number(row.revision) };
    const ownKey = `${ownRef.id}\0${ownRef.revision}`;
    if (row.revoked_at != null) {
      context.snapshotRefs[table].set(ownKey, ownRef);
      result.push(row);
      continue;
    }
    const digestKey = sourceKey(String(row.owner_id), row.intent_digest);
    const canonicalRef = canonicalRefs.get(digestKey);
    if (
      canonicalRef &&
      (canonicalRef.id !== ownRef.id || canonicalRef.revision !== ownRef.revision)
    ) {
      context.snapshotRefs[table].set(ownKey, canonicalRef);
      context.resolutions.push({
        kind: 'snapshot-dedup',
        table,
        sourceId: ownRef.id,
        targetId: canonicalRef.id,
      });
      continue;
    }
    canonicalRefs.set(digestKey, ownRef);
    context.snapshotRefs[table].set(ownKey, ownRef);
    result.push(row);
  }
  return result;
}

async function reuseVerifiedCiphertextOnRetry(
  target: Pool,
  table: string,
  rows: Row[],
): Promise<Row[]> {
  if (
    table === 'media_config_snapshots' ||
    table === 'generation_model_snapshots' ||
    table === 'generation_search_snapshots'
  ) {
    const ids = rows.map((row) => String(row.id));
    if (!ids.length) return rows;
    const existing = await target.query<Row>(
      `SELECT id,revision,owner_id,intent_digest,ciphertext FROM ${quote(table)}
        WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(existing.rows.map((row) => [String(row.id), row]));
    return rows.map((row) => {
      const found = byId.get(String(row.id));
      return found &&
        Number(found.revision) === Number(row.revision) &&
        found.owner_id === row.owner_id &&
        found.intent_digest === row.intent_digest
        ? { ...row, ciphertext: found.ciphertext }
        : row;
    });
  }
  if (table === 'pro_model_connection_revisions') {
    const ids = [...new Set(rows.map((row) => String(row.connection_id)))];
    if (!ids.length) return rows;
    const existing = await target.query<Row>(
      `SELECT r.connection_id,r.revision,r.ciphertext,c.owner_id
         FROM pro_model_connection_revisions r
         JOIN pro_model_connections c ON c.id=r.connection_id
        WHERE r.connection_id=ANY($1::uuid[])`,
      [ids],
    );
    const byRef = new Map(
      existing.rows.map((row) => [`${String(row.connection_id)}\0${Number(row.revision)}`, row]),
    );
    return rows.map((row) => {
      const ref = { id: String(row.connection_id), revision: Number(row.revision) };
      const found = byRef.get(`${ref.id}\0${ref.revision}`);
      if (!found) return row;
      if (
        !proModelConnectionCiphertextsEqual(
          String(found.ciphertext),
          String(row.ciphertext),
          String(found.owner_id),
          ref,
        )
      ) {
        throw new Error('target row conflict for pro_model_connection_revisions');
      }
      return { ...row, ciphertext: found.ciphertext };
    });
  }
  return rows;
}

async function copyTable(
  source: Pool,
  target: Pool,
  table: string,
  context: MigrationTransformContext,
): Promise<{ source: number; written: number }> {
  const sourceRows = await source.query<Row>(
    table === 'asset_blobs'
      ? 'SELECT content_hash,byte_size,NULL::bytea AS bytes,unreferenced_at FROM asset_blobs'
      : table === 'document_stage_revision'
        ? `SELECT r.* FROM document_stage_revision r
             JOIN document_stages s ON s.id=r.stage_id`
      : table === 'pro_model_connection_revisions'
        ? `SELECT r.*, c.owner_id AS __source_owner_id
             FROM pro_model_connection_revisions r
             JOIN pro_model_connections c ON c.id=r.connection_id`
        : `SELECT * FROM ${quote(table)}`,
  );
  let migrated = sourceRows.rows.map((sourceRow) => {
    const ownerColumn = OWNER_COLUMNS[table]?.find((column) =>
      typeof sourceRow[column] === 'string' ? String(sourceRow[column]).startsWith('anon:') : false,
    );
    const oldOwner = ownerColumn
      ? String(sourceRow[ownerColumn])
      : typeof sourceRow.__source_owner_id === 'string' &&
          String(sourceRow.__source_owner_id).startsWith('anon:')
        ? String(sourceRow.__source_owner_id)
        : undefined;
    const withoutJoinColumn = { ...sourceRow };
    delete withoutJoinColumn.__source_owner_id;
    let row = reencryptRow(table, transformRow(table, withoutJoinColumn, context), oldOwner);
    if (table === 'pro_model_connection_revisions' && oldOwner) {
      row = {
        ...row,
        ciphertext: reassignProModelConnectionCiphertext(
          String(row.ciphertext),
          oldOwner,
          adminOwnerId,
          { id: String(row.connection_id), revision: Number(row.revision) },
        ),
      };
    }
    return row;
  });

  if (
    table === 'media_config_snapshots' ||
    table === 'generation_model_snapshots' ||
    table === 'generation_search_snapshots'
  ) {
    migrated = await deduplicateSnapshotRows(target, table, migrated, context);
  }
  if (table === 'document_folders') {
    migrated = await resolveFolderConflicts(target, sourceRows.rows, migrated, context);
  }
  if (table === 'agent_user_skill') {
    migrated = await resolveSkillConflicts(target, sourceRows.rows, migrated, context);
  }
  if (table === 'generation_jobs') {
    migrated = await resolveGenerationJobConflicts(target, sourceRows.rows, migrated, context);
  }
  if (table === 'agent_owner_session_events') {
    migrated = await resolveOwnerEventConflicts(target, sourceRows.rows, migrated, context);
  }
  if (table === 'agent_owner_session_event_counters') {
    migrated = await resolveOwnerEventCounters(target, migrated, context);
  }
  if (table === 'agent_session_entries') {
    migrated = sortAgentSessionEntriesParentFirst(migrated);
  }
  migrated = await reuseVerifiedCiphertextOnRetry(target, table, migrated);
  await upsertRows(target, table, migrated);
  if (table === 'generation_events' && migrated.length) {
    await target.query(
      `SELECT setval(pg_get_serial_sequence('generation_events','id'),
        (SELECT max(id) FROM generation_events),true)`,
    );
  }
  return { source: sourceRows.rows.length, written: migrated.length };
}

async function walkFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

interface ClassroomSnapshotMigration {
  classroomId: string;
  stageId: string;
  bytes: Buffer;
  targetKey: string;
  storageRef: string;
}

function classroomSnapshotMigration(
  sourceKey: string,
  sourceBytes: Buffer,
  ownerId: string,
  bucket: string,
): ClassroomSnapshotMigration {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(sourceKey)) {
    throw new Error(`invalid classroom snapshot path: ${sourceKey}`);
  }
  const classroomId = sourceKey.slice(0, -'.json'.length);
  let parsed: Row;
  try {
    const value = JSON.parse(sourceBytes.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object');
    parsed = value as Row;
  } catch (error) {
    throw new Error(
      `invalid classroom snapshot JSON: ${sourceKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.id !== classroomId) {
    throw new Error(`classroom snapshot id/path mismatch: ${sourceKey}`);
  }
  if (!parsed.stage || typeof parsed.stage !== 'object' || Array.isArray(parsed.stage)) {
    throw new Error(`classroom snapshot stage is invalid: ${sourceKey}`);
  }
  const stageId = (parsed.stage as Row).id;
  if (typeof stageId !== 'string' || !stageId) {
    throw new Error(`classroom snapshot stage id is invalid: ${sourceKey}`);
  }
  if (!Array.isArray(parsed.scenes) || typeof parsed.createdAt !== 'string') {
    throw new Error(`classroom snapshot payload is invalid: ${sourceKey}`);
  }
  const bytes = Buffer.from(
    JSON.stringify({
      id: classroomId,
      stage: parsed.stage,
      scenes: parsed.scenes,
      createdAt: parsed.createdAt,
      ownerId,
    }),
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  const targetKey = `snapshots/${encodeURIComponent(ownerId)}/${encodeURIComponent(classroomId)}/1-${digest}.json`;
  return {
    classroomId,
    stageId,
    bytes,
    targetKey,
    storageRef: `s3://${bucket}/${targetKey}`,
  };
}

interface ClassroomMediaMigration {
  classroomId: string;
  legacyPath: string;
  assetId: string;
  contentHash: string;
  mime: string;
}

// Reverse the exact extensions emitted by classroom-media-bytes.ts. Legacy
// files have no sidecar metadata, so their producer-owned suffix is the only
// durable MIME signal available to the migration.
const CLASSROOM_MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

function classroomMediaMigration(
  sourceKey: string,
  bytes: Buffer,
  ownerId: string,
): ClassroomMediaMigration {
  const parts = sourceKey.split('/');
  if (
    parts.length !== 3 ||
    !/^[a-zA-Z0-9_-]+$/.test(parts[0] ?? '') ||
    (parts[1] !== 'media' && parts[1] !== 'audio') ||
    !parts[2] ||
    parts[2] === '.' ||
    parts[2] === '..' ||
    parts[2]!.includes('\0')
  ) {
    throw new Error(`invalid classroom media path: ${sourceKey}`);
  }
  const classroomId = parts[0]!;
  const legacyPath = `${parts[1]}/${parts[2]}`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const contentHash = `sha256-${digest}`;
  const assetId = `ast_${createHash('sha256')
    .update(['classroom-media', ownerId, classroomId, legacyPath].join('\0'))
    .digest('hex')
    .slice(0, 32)}`;
  const extension = basename(parts[2]!).split('.').pop()?.toLowerCase() ?? '';
  const mime = CLASSROOM_MEDIA_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  return { classroomId, legacyPath, assetId, contentHash, mime };
}

export async function migrateFilesystemObjects(
  client: S3Client,
  target: Pool,
  runId: string,
  dataRoot: string,
  buckets: { assets: string; materials: string; classrooms: string },
  ownerId: string,
): Promise<number> {
  let migrated = 0;
  const materialsRoot = join(dataRoot, 'materials');
  for (const file of await walkFiles(materialsRoot)) {
    const key = relative(dataRoot, file).replace(/\\/g, '/');
    const bytes = await readFile(file);
    await copyObject(client, target, runId, 'material-file', key, buckets.materials, key, bytes);
    migrated += 1;
  }
  const classroomsRoot = join(dataRoot, 'classrooms');
  const classroomFiles = await walkFiles(classroomsRoot);
  const snapshots: Array<{ file: string; key: string }> = [];
  const media: Array<{ file: string; key: string }> = [];
  for (const file of classroomFiles) {
    const key = relative(classroomsRoot, file).replace(/\\/g, '/');
    if (key.endsWith('.json') && !key.includes('/')) snapshots.push({ file, key });
    else media.push({ file, key });
  }
  for (const { file, key } of snapshots) {
    const bytes = await readFile(file);
    const snapshot = classroomSnapshotMigration(key, bytes, ownerId, buckets.classrooms);
    await copyObject(
      client,
      target,
      runId,
      'classroom-snapshot',
      key,
      buckets.classrooms,
      snapshot.targetKey,
      snapshot.bytes,
      'application/json',
    );
    await upsertRows(target, 'classroom_snapshots', [
      {
        classroom_id: snapshot.classroomId,
        owner_id: ownerId,
        stage_id: snapshot.stageId,
        storage_ref: snapshot.storageRef,
        version: 1,
      },
    ]);
    migrated += 1;
  }
  for (const { file, key } of media) {
    const bytes = await readFile(file);
    const object = classroomMediaMigration(key, bytes, ownerId);
    const classroom = await target.query<{ owner_id: string }>(
      'SELECT owner_id FROM classroom_snapshots WHERE classroom_id=$1',
      [object.classroomId],
    );
    if (classroom.rows[0]?.owner_id !== ownerId) {
      throw new Error(`classroom media has no migrated owner-bound snapshot: ${key}`);
    }
    await copyObject(
      client,
      target,
      runId,
      'classroom-media',
      key,
      buckets.assets,
      object.contentHash,
      bytes,
      object.mime,
    );
    await upsertRows(target, 'asset_blobs', [
      {
        content_hash: object.contentHash,
        byte_size: bytes.byteLength,
        unreferenced_at: null,
      },
    ]);
    await upsertRows(target, 'asset_entries', [
      {
        id: object.assetId,
        principal: ownerId,
        content_hash: object.contentHash,
        mime: object.mime,
        meta: {},
        revision: 1,
        created_at: 0,
      },
    ]);
    await upsertRows(target, 'classroom_media_objects', [
      {
        owner_id: ownerId,
        classroom_id: object.classroomId,
        legacy_path: object.legacyPath,
        asset_id: object.assetId,
        mime: object.mime,
        byte_size: bytes.byteLength,
      },
    ]);
    migrated += 1;
  }
  return migrated;
}

async function verifyMaterialObjectReferences(
  source: Pool,
  target: Pool,
  runId: string,
  bucket: string,
): Promise<void> {
  const references = await source.query<{
    object_key: string;
    expected_bytes: string | null;
    expected_sha256: string | null;
  }>(
    `SELECT oss_key AS object_key, bytes::text AS expected_bytes,
            nullif(regexp_replace(coalesce(sha256,''),'^sha256-',''),'') AS expected_sha256
       FROM owner_material WHERE oss_key<>''
     UNION ALL
     SELECT object_key, NULL, NULL FROM (
       SELECT m.text_asset_id AS object_key
         FROM agent_session_materials m WHERE m.text_asset_id IS NOT NULL
       UNION
       SELECT m.raw_asset_id AS object_key
         FROM agent_session_materials m WHERE m.raw_asset_id IS NOT NULL
     ) session_objects`,
  );
  for (const reference of references.rows) {
    const ledger = await target.query<{ byte_size: string; sha256: string; status: string }>(
      `SELECT byte_size::text,sha256,status FROM storage_migration_objects
        WHERE run_id=$1 AND source_kind='material-file' AND source_key=$2
          AND target_bucket=$3 AND target_key=$2`,
      [runId, reference.object_key, bucket],
    );
    const row = ledger.rows[0];
    if (!row || row.status !== 'verified') {
      throw new Error(`material object missing or unverified: ${reference.object_key}`);
    }
    if (reference.expected_bytes !== null && row.byte_size !== reference.expected_bytes) {
      throw new Error(`material object length mismatch: ${reference.object_key}`);
    }
    if (
      reference.expected_sha256 &&
      row.sha256.toLowerCase() !== reference.expected_sha256.toLowerCase()
    ) {
      throw new Error(`material object hash mismatch: ${reference.object_key}`);
    }
  }
}

async function verifyRelationalReferences(target: Pool): Promise<void> {
  const checks: Array<[string, string]> = [
    [
      'stage folder',
      `SELECT count(*)::text AS n FROM document_stages s
        WHERE s.folder_id IS NOT NULL AND s.folder_id<>'' AND NOT EXISTS(
          SELECT 1 FROM document_folders f WHERE f.owner_id=s.owner_id AND f.id=s.folder_id
        )`,
    ],
    [
      'stage metadata owner',
      `SELECT count(*)::text AS n FROM stage_meta m
        WHERE NOT EXISTS(SELECT 1 FROM document_stages s WHERE s.id=m.stage_id AND s.owner_id=m.owner_id)`,
    ],
    [
      'stage revision',
      `SELECT count(*)::text AS n FROM document_stage_revision r
        WHERE NOT EXISTS(SELECT 1 FROM document_stages s WHERE s.id=r.stage_id)`,
    ],
    [
      'scene revision',
      `SELECT count(*)::text AS n FROM document_scene_revision r
        WHERE NOT EXISTS(SELECT 1 FROM document_scenes s WHERE s.stage_id=r.stage_id AND s.id=r.scene_id)`,
    ],
    [
      'runtime record',
      `SELECT count(*)::text AS n FROM runtime_records r
        WHERE NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=r.session_id)`,
    ],
    [
      'asset blob',
      `SELECT count(*)::text AS n FROM asset_entries e
        WHERE NOT EXISTS(SELECT 1 FROM asset_blobs b WHERE b.content_hash=e.content_hash)`,
    ],
    [
      'generation ownership',
      `SELECT count(*)::text AS n FROM generation_ownership o
        WHERE NOT EXISTS(SELECT 1 FROM document_stages s WHERE s.id=o.stage_id AND s.owner_id=o.owner_id)`,
    ],
    [
      'generation job stage',
      `SELECT count(*)::text AS n FROM generation_jobs j
        WHERE NOT EXISTS(SELECT 1 FROM document_stages s WHERE s.id=j.stage_id AND s.owner_id=j.owner_id)`,
    ],
    [
      'generation attempt',
      `SELECT count(*)::text AS n FROM generation_attempts a
        WHERE NOT EXISTS(SELECT 1 FROM generation_steps s WHERE s.id=a.step_id)`,
    ],
    [
      'generation child',
      `SELECT (
        (SELECT count(*) FROM generation_scenes c WHERE NOT EXISTS(SELECT 1 FROM generation_jobs j WHERE j.id=c.job_id))+
        (SELECT count(*) FROM generation_steps c WHERE NOT EXISTS(SELECT 1 FROM generation_jobs j WHERE j.id=c.job_id))+
        (SELECT count(*) FROM generation_job_assets c WHERE NOT EXISTS(SELECT 1 FROM generation_jobs j WHERE j.id=c.job_id))+
        (SELECT count(*) FROM generation_events c WHERE NOT EXISTS(SELECT 1 FROM generation_jobs j WHERE j.id=c.job_id))+
        (SELECT count(*) FROM generation_commands c WHERE NOT EXISTS(SELECT 1 FROM generation_jobs j WHERE j.id=c.job_id))
      )::text AS n`,
    ],
    [
      'agent session child',
      `SELECT (
        (SELECT count(*) FROM agent_session_events c WHERE NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=c.session_id))+
        (SELECT count(*) FROM agent_session_entries c WHERE NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=c.session_id))+
        (SELECT count(*) FROM agent_session_urls c WHERE NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=c.session_id))+
        (SELECT count(*) FROM agent_session_materials c WHERE NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=c.session_id))
      )::text AS n`,
    ],
    [
      'Pro model revision',
      `SELECT count(*)::text AS n FROM pro_model_connection_revisions r
        WHERE NOT EXISTS(SELECT 1 FROM pro_model_connections c WHERE c.id=r.connection_id)`,
    ],
  ];
  for (const [label, sql] of checks) {
    const result = await target.query<{ n: string }>(sql);
    if (result.rows[0]?.n !== '0') throw new Error(`reference verification failed: ${label}`);
  }
}

async function main() {
  assertMigrationArgs(process.argv.slice(2));
  loadPrivateEnv(join(ROOT, '.env.local'));
  loadHostedOperatorEnv();
  adminUserId = required('MIGRATION_ADMIN_USER_ID', process.env.MIGRATION_ADMIN_USER_ID);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(adminUserId)) {
    throw new Error('MIGRATION_ADMIN_USER_ID must be a UUID');
  }
  adminOwnerId = `user:${adminUserId}`;
  const sourceUrl = required('SOURCE_DATABASE_URL', process.env.SOURCE_DATABASE_URL);
  const targetUrl = required('HOSTED_DB_ADMIN_URL', hostedAdminDatabaseUrl());
  const objectConcurrency = migrationObjectConcurrency();
  const source = new Pool({ connectionString: sourceUrl, max: 2 });
  // The hosted session pooler currently advertises pool_size=15. Keep the
  // one-off operator below that ceiling so Web/worker/control probes retain
  // headroom while S3 transfers can still overlap independently.
  const target = hostedPgPool(targetUrl, Math.min(objectConcurrency, 4));
  let activeRunId: string | undefined;
  try {
    const sourceState = await sourceFingerprint(source);
    const targetCounts = await counts(target);
    const preflight = {
      sourceFingerprint: sourceState.fingerprint,
      sourceCounts: sourceState.counts,
      targetCounts,
      adminOwnerMapped: true,
      projectRef: HOSTED_PROJECT_REF,
      apply: APPLY,
    };
    console.info(JSON.stringify(preflight));
    if (!APPLY) return;
    if (process.env.CONFIRM_STORAGE_MIGRATION !== 'YES') {
      throw new Error('Refusing migration: set CONFIRM_STORAGE_MIGRATION=YES and pass --apply');
    }
    const activeAdmin = await target.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_accounts WHERE user_id=$1 AND role='admin' AND status='active'",
      [adminUserId],
    );
    if (activeAdmin.rows[0]?.n !== '1')
      throw new Error('confirmed migration administrator is not active');

    const runId =
      process.env.MIGRATION_RUN_ID?.trim() ||
      deterministicRunId(sourceState.fingerprint, HOSTED_PROJECT_REF, adminOwnerId);
    activeRunId = runId;
    const run = await target.query(
      `INSERT INTO storage_migration_runs
         (run_id,source_fingerprint,target_project_ref,admin_owner_id,status,manifest)
       VALUES($1,$2,$3,$4,'copying',$5::jsonb)
       ON CONFLICT(run_id) DO UPDATE SET status='copying',updated_at=clock_timestamp(),manifest=EXCLUDED.manifest
       WHERE storage_migration_runs.source_fingerprint=EXCLUDED.source_fingerprint
         AND storage_migration_runs.target_project_ref=EXCLUDED.target_project_ref
         AND storage_migration_runs.admin_owner_id=EXCLUDED.admin_owner_id
       RETURNING run_id`,
      [runId, sourceState.fingerprint, HOSTED_PROJECT_REF, adminOwnerId, JSON.stringify(preflight)],
    );
    if (!run.rows.length) throw new Error('migration run id belongs to a different manifest');

    const client = s3Client();
    const buckets = {
      assets: process.env.ASSET_S3_BUCKET?.trim() || 'zhiyu-assets',
      materials: process.env.MATERIAL_S3_BUCKET?.trim() || 'zhiyu-materials',
      classrooms: process.env.CLASSROOM_S3_BUCKET?.trim() || 'zhiyu-classrooms',
    };
    for (const bucket of Object.values(buckets)) await ensurePrivateBucket(client, bucket);

    const blobRows = await source.query<{ content_hash: string; byte_size: string }>(
      'SELECT content_hash,byte_size::text FROM asset_blobs WHERE bytes IS NOT NULL ORDER BY content_hash',
    );
    const verifiedAssetRows = await target.query<VerifiedObjectLedgerRow>(
      `SELECT source_key,target_bucket,target_key,byte_size::text,sha256,status
         FROM storage_migration_objects
        WHERE run_id=$1 AND source_kind='asset-blob' AND status='verified'`,
      [runId],
    );
    const verifiedAssets = new Map(verifiedAssetRows.rows.map((row) => [row.source_key, row]));
    await forEachConcurrent(blobRows.rows, objectConcurrency, async (row) => {
      const expected = row.content_hash.replace(/^sha256-/, '');
      const byteSize = Number(row.byte_size);
      if (
        canReuseVerifiedObject(verifiedAssets.get(row.content_hash), {
          sourceKey: row.content_hash,
          bucket: buckets.assets,
          key: row.content_hash,
          byteSize,
          sha256: expected,
        })
      ) {
        return;
      }
      const sourceBlob = await source.query<{ bytes: Buffer }>(
        'SELECT bytes FROM asset_blobs WHERE content_hash=$1 AND bytes IS NOT NULL',
        [row.content_hash],
      );
      const bytes = sourceBlob.rows[0]?.bytes;
      if (!bytes) throw new Error(`source asset bytes missing: ${row.content_hash}`);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected || bytes.byteLength !== byteSize) {
        throw new Error(`source asset hash/length mismatch: ${row.content_hash}`);
      }
      await copyObject(
        client,
        target,
        runId,
        'asset-blob',
        row.content_hash,
        buckets.assets,
        row.content_hash,
        bytes,
      );
    });

    const dataRoot = required('SOURCE_DATA_ROOT', process.env.SOURCE_DATA_ROOT);
    if (!existsSync(dataRoot)) throw new Error('SOURCE_DATA_ROOT does not exist');
    await migrateFilesystemObjects(client, target, runId, dataRoot, buckets, adminOwnerId);
    await verifyMaterialObjectReferences(source, target, runId, buckets.materials);

    // Remove only orphan revision rows left by hosted proof traffic. No course
    // row exists for these keys, so no user data is discarded.
    await target.query(
      `DELETE FROM document_scene_revision r WHERE NOT EXISTS(
         SELECT 1 FROM document_stages s WHERE s.id=r.stage_id)
       ;DELETE FROM document_stage_revision r WHERE NOT EXISTS(
         SELECT 1 FROM document_stages s WHERE s.id=r.stage_id)`,
    );
    const context = migrationContext();
    const copiedCounts: Record<string, number> = {};
    for (const table of TABLES) {
      try {
        const copied = await copyTable(source, target, table, context);
        copiedCounts[table] = copied.written;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`migration table ${table} failed: ${message}`);
      }
    }
    await target.query(
      `UPDATE storage_migration_runs
          SET manifest=manifest || jsonb_build_object('conflictResolutions',$2::jsonb),
              updated_at=clock_timestamp()
        WHERE run_id=$1`,
      [runId, JSON.stringify(context.resolutions)],
    );

    await target.query(
      `UPDATE storage_migration_runs SET status='verifying',updated_at=clock_timestamp()
       WHERE run_id=$1`,
      [runId],
    );
    const targetAfter = await counts(target);
    for (const table of TABLES) {
      if (targetAfter[table]! < copiedCounts[table]!) {
        throw new Error(`row-count verification failed for ${table}`);
      }
    }
    const ownership = await target.query<{ anon: string; mapped: string; tombstones: string }>(
      `SELECT
         count(*) FILTER(WHERE owner_id LIKE 'anon:%')::text AS anon,
         count(*) FILTER(WHERE owner_id=$1)::text AS mapped,
         (SELECT count(*)::text FROM stage_meta WHERE deleted_at IS NOT NULL) AS tombstones
       FROM document_stages`,
      [adminOwnerId],
    );
    if (ownership.rows[0]?.anon !== '0')
      throw new Error('anonymous courses remain after migration');
    const sourceTombstones = await source.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM stage_meta WHERE deleted_at IS NOT NULL',
    );
    if (Number(ownership.rows[0]?.tombstones ?? 0) < Number(sourceTombstones.rows[0]?.n ?? 0)) {
      throw new Error('tombstone verification failed');
    }
    for (const [table, columns] of Object.entries(OWNER_COLUMNS)) {
      for (const column of columns) {
        const anonymous = await target.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${quote(table)} WHERE ${quote(column)} LIKE 'anon:%'`,
        );
        if (anonymous.rows[0]?.n !== '0') {
          throw new Error(`anonymous owner remains in ${table}.${column}`);
        }
      }
    }
    const runtimeLearnerMismatch = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM runtime_sessions
       WHERE learner_key IS DISTINCT FROM data->>'learnerKey'`,
    );
    if (runtimeLearnerMismatch.rows[0]?.n !== '0') {
      throw new Error('Runtime session learner column and JSON verification failed');
    }
    await verifyRelationalReferences(target);
    const objectFailures = await target.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM storage_migration_objects WHERE run_id=$1 AND status<>'verified'",
      [runId],
    );
    if (objectFailures.rows[0]?.n !== '0')
      throw new Error('object verification ledger has failures');
    await target.query(
      `UPDATE storage_migration_runs SET status='complete',completed_at=clock_timestamp(),
         updated_at=clock_timestamp() WHERE run_id=$1`,
      [runId],
    );
    console.info(
      JSON.stringify({
        ok: true,
        runId,
        stages: targetAfter.document_stages,
        mappedOwnerStages: Number(ownership.rows[0]?.mapped ?? 0),
        tombstones: Number(ownership.rows[0]?.tombstones ?? 0),
        assetObjects: blobRows.rows.length,
      }),
    );
  } catch (error) {
    if (activeRunId) {
      await target
        .query(
          `UPDATE storage_migration_runs
              SET status='failed',
                  manifest=manifest || '{"lastFailure":"migration failed; inspect private operator logs"}'::jsonb,
                  updated_at=clock_timestamp()
            WHERE run_id=$1 AND status<>'complete'`,
          [activeRunId],
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

const isMigrationCli = /^migrate-supabase-storage\.(?:mts|mjs|cjs|js)$/i.test(
  basename(process.argv[1] ?? ''),
);
if (isMigrationCli) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      message
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
        .replace(/password[=:]\s*\S+/gi, 'password=***')
        .replace(/secret[=:]\s*\S+/gi, 'secret=***'),
    );
    process.exitCode = 1;
  });
}
