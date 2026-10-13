import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

export type AccountDeletionStatus = 'pending' | 'running' | 'retry' | 'blocked' | 'complete';

export interface AccountDeletionJob {
  userId: string;
  ownerId: string;
  status: AccountDeletionStatus;
  phase: string;
  attemptCount: number;
  lastError?: string;
}

export interface DeletionObject {
  bucketId: string;
  objectKey: string;
  contentHash?: string;
  status: 'pending' | 'retained_shared' | 'deleted' | 'retry';
}

export interface AccountDeletionObjectStore {
  delete(bucketId: string, objectKey: string): Promise<void>;
}

export interface AccountDeletionAuthAdmin {
  /** Disable sign-in while physical cleanup is running. */
  block(userId: string): Promise<void>;
  /** Delete the Auth user. Missing users must be treated as success. */
  delete(userId: string): Promise<void>;
}

export interface AccountDeletionRequestOptions {
  /** Exact operator-supplied email used only to derive a one-way recovery key. */
  recoveryEmail?: string;
}

const RECOVERY_EMAIL_MANIFEST_KEY = 'operator_email_sha256';

function recoveryEmailDigest(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('ACCOUNT_DELETION_RECOVERY_EMAIL_REQUIRED');
  return createHash('sha256')
    .update(`openmaic:account-deletion-email:v1\0${normalized}`, 'utf8')
    .digest('hex');
}

function recoveryDigestFromRow(row: Record<string, unknown>): string | undefined {
  const manifest = row.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  const digest = (manifest as Record<string, unknown>)[RECOVERY_EMAIL_MANIFEST_KEY];
  return typeof digest === 'string' ? digest : undefined;
}

async function bindRecoveryEmail(
  client: PoolClient,
  userId: string,
  digest: string,
): Promise<void> {
  await client.query(
    `UPDATE account_deletion_jobs
        SET manifest=jsonb_set(
          COALESCE(manifest,'{}'::jsonb),
          '{${RECOVERY_EMAIL_MANIFEST_KEY}}',
          to_jsonb($2::text),
          true
        ),
        updated_at=clock_timestamp()
      WHERE user_id=$1`,
    [userId, digest],
  );
}

/**
 * Resolve only an unfinished job previously bound to this exact email.
 * Missing and ambiguous identities fail closed instead of guessing a user id.
 */
export async function findResumableAccountDeletionByEmail(
  pool: Pool,
  email: string,
): Promise<AccountDeletionJob | null> {
  const digest = recoveryEmailDigest(email);
  const result = await pool.query(
    `SELECT * FROM account_deletion_jobs
      WHERE status<>'complete'
        AND manifest->>'${RECOVERY_EMAIL_MANIFEST_KEY}'=$1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 2`,
    [digest],
  );
  if (result.rows.length > 1) throw new Error('ACCOUNT_DELETION_RECOVERY_AMBIGUOUS');
  return result.rows.length ? jobFromRow(result.rows[0] as Record<string, unknown>) : null;
}

function mergeDeletionObject(objects: Map<string, DeletionObject>, object: DeletionObject): void {
  const key = `${object.bucketId}\0${object.objectKey}`;
  const previous = objects.get(key);
  if (!previous) {
    objects.set(key, object);
    return;
  }
  // A physical object is retained only when every reference to it is known to
  // be shared.  Any owner-private pointer wins over retained_shared.
  objects.set(key, {
    ...previous,
    ...object,
    contentHash: previous.contentHash ?? object.contentHash,
    status:
      previous.status === 'pending' || object.status === 'pending' ? 'pending' : previous.status,
  });
}

function jobFromRow(row: Record<string, unknown>): AccountDeletionJob {
  return {
    userId: String(row.user_id),
    ownerId: String(row.owner_id),
    status: String(row.status) as AccountDeletionStatus,
    phase: String(row.phase),
    attemptCount: Number(row.attempt_count ?? 0),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  };
}

async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockDeletion(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('openmaic:account-delete:' || $1))", [
    userId,
  ]);
}

/**
 * Immediately blocks an account and fences every known long-running writer.
 * This is idempotent; retries return the same deletion job.
 */
export async function requestAccountDeletion(
  pool: Pool,
  userId: string,
  options: AccountDeletionRequestOptions = {},
): Promise<AccountDeletionJob> {
  return transaction(pool, async (client) => {
    await lockDeletion(client, userId);
    const account = await client.query<{ owner_id: string; status: string }>(
      'SELECT owner_id, status FROM app_accounts WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const existingJob = await client.query(
      'SELECT * FROM account_deletion_jobs WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const recoveryDigest = options.recoveryEmail
      ? recoveryEmailDigest(options.recoveryEmail)
      : undefined;
    const existingRow = existingJob.rows[0] as Record<string, unknown> | undefined;
    const existingRecoveryDigest = existingRow ? recoveryDigestFromRow(existingRow) : undefined;
    if (recoveryDigest && existingRecoveryDigest && recoveryDigest !== existingRecoveryDigest) {
      throw new Error('ACCOUNT_DELETION_RECOVERY_IDENTITY_MISMATCH');
    }
    if (!account.rows.length) {
      if (existingRow) {
        if (recoveryDigest && !existingRecoveryDigest) {
          await bindRecoveryEmail(client, userId, recoveryDigest);
        }
        return jobFromRow(existingRow);
      }
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    const ownerId = account.rows[0]!.owner_id;

    // Serialize with both durable job claims and synchronous/foreground root
    // admission. Once this transaction commits, no old root can renew and no
    // queued job can cross the deletion boundary.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('generation:owner:' || $1))", [
      ownerId,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('heavy-task:admission:v1'))");

    await client.query(
      `INSERT INTO deleted_account_tombstones(user_id, owner_id, reason)
       VALUES($1,$2,'account_deletion_requested')
       ON CONFLICT(user_id) DO UPDATE SET owner_id=EXCLUDED.owner_id`,
      [userId, ownerId],
    );
    await client.query(
      `INSERT INTO account_deletion_jobs(user_id, owner_id, status, phase)
       VALUES($1,$2,'pending','requested')
       ON CONFLICT(user_id) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,
         status=CASE WHEN account_deletion_jobs.status='complete' THEN 'complete' ELSE 'pending' END,
         updated_at=clock_timestamp(),
         last_error=NULL`,
      [userId, ownerId],
    );
    if (recoveryDigest && !existingRecoveryDigest) {
      await bindRecoveryEmail(client, userId, recoveryDigest);
    }
    await client.query(
      `UPDATE app_accounts
          SET status='deleting', session_valid_after=clock_timestamp(), updated_at=clock_timestamp()
        WHERE user_id=$1`,
      [userId],
    );

    // Fence ordinary workers. A worker holding an old lease epoch can no longer
    // publish after this transaction commits.
    await client.query(
      `UPDATE generation_jobs
          SET status='cancelled',
              cancel_requested_at=COALESCE(cancel_requested_at, clock_timestamp()),
              lease_epoch=lease_epoch+1,
              worker_id=NULL,
              lease_expires_at=NULL,
              heartbeat_at=NULL,
              finished_at=COALESCE(finished_at, clock_timestamp()),
              state_version=state_version+1,
              updated_at=clock_timestamp()
        WHERE owner_id=$1
          AND status NOT IN ('succeeded','failed','cancelled')`,
      [ownerId],
    );
    await client.query(
      `UPDATE generation_ownership
          SET ownership_epoch=ownership_epoch+1, updated_at=clock_timestamp()
        WHERE owner_id=$1`,
      [ownerId],
    );

    // Fence Pro/parse work by invalidating the current attempt and lease.
    await client.query(
      `UPDATE agent_sessions
          SET cancel_requested_at=COALESCE(
                cancel_requested_at,
                floor(extract(epoch FROM clock_timestamp())*1000)::bigint
              ),
              attempt=attempt+1,
              lease_worker_id=NULL,
              lease_worker_pid=NULL,
              lease_heartbeat_at=NULL,
              updated_at=clock_timestamp()
        WHERE owner_id=$1 AND deleted_at IS NULL`,
      [ownerId],
    );
    await client.query(
      `UPDATE agent_session_materials m
          SET extraction_attempts=extraction_attempts+1,
              extraction_lease_worker_id=NULL,
              extraction_lease_worker_pid=NULL,
              extraction_lease_heartbeat_at=NULL
        WHERE EXISTS (
          SELECT 1 FROM agent_sessions s
           WHERE s.id=m.session_id AND s.owner_id=$1
        )`,
      [ownerId],
    );

    // Independent and foreground browser work share this owner-scoped slot
    // group. Deleting every row fences its current holder/epoch immediately;
    // accounts v13 also prevents inactive owners from reacquiring or renewing.
    await client.query(
      `DELETE FROM generation_provider_slots
        WHERE quota_group='heavy-task:sync-owner:' || $1`,
      [ownerId],
    );

    await client.query(
      `INSERT INTO admin_audit_events(actor_user_id,target_internal_id,action,result)
       VALUES(NULL,$1,'request_account_deletion','access_revoked')`,
      [userId],
    );
    const row = await client.query('SELECT * FROM account_deletion_jobs WHERE user_id=$1', [
      userId,
    ]);
    return jobFromRow(row.rows[0] as Record<string, unknown>);
  });
}

function storageReference(ref: string | null, fallbackBucket: string): [string, string] | null {
  if (!ref) return null;
  if (ref.startsWith('s3://')) {
    const separator = ref.indexOf('/', 5);
    if (separator <= 5 || separator === ref.length - 1) return null;
    return [ref.slice(5, separator), ref.slice(separator + 1)];
  }
  const separator = ref.indexOf(':');
  if (separator > 0 && !ref.startsWith('sha256-')) {
    return [ref.slice(0, separator), ref.slice(separator + 1)];
  }
  return [fallbackBucket, ref];
}

/** Snapshot every object pointer before relational rows are removed. */
export async function prepareAccountDeletionManifest(
  pool: Pool,
  userId: string,
  buckets: { assets: string; materials: string; classrooms: string },
): Promise<DeletionObject[]> {
  return transaction(pool, async (client) => {
    await lockDeletion(client, userId);
    const job = await client.query<{ owner_id: string }>(
      'SELECT owner_id FROM account_deletion_jobs WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    if (!job.rows.length) throw new Error('ACCOUNT_DELETION_NOT_REQUESTED');
    const ownerId = job.rows[0]!.owner_id;
    const objects = new Map<string, DeletionObject>();

    const assets = await client.query<{ content_hash: string; shared: boolean }>(
      `SELECT DISTINCT e.content_hash,
              EXISTS(SELECT 1 FROM asset_entries other
                      WHERE other.content_hash=e.content_hash AND other.principal<>$1) AS shared
         FROM asset_entries e WHERE e.principal=$1`,
      [ownerId],
    );
    for (const asset of assets.rows) {
      mergeDeletionObject(objects, {
        bucketId: buckets.assets,
        objectKey: asset.content_hash,
        contentHash: asset.content_hash,
        status: asset.shared ? 'retained_shared' : 'pending',
      });
    }

    const materials = await client.query<{ oss_key: string }>(
      "SELECT oss_key FROM owner_material WHERE owner_id=$1 AND oss_key<>''",
      [ownerId],
    );
    for (const material of materials.rows) {
      mergeDeletionObject(objects, {
        bucketId: buckets.materials,
        objectKey: material.oss_key,
        status: 'pending',
      });
    }

    // Session materials use the same private byte store but are not represented
    // by owner_material.  Snapshot their raw/text pointers before agent_sessions
    // is removed (the material rows cascade with it).
    const sessionMaterials = await client.query<{
      text_asset_id: string | null;
      raw_asset_id: string | null;
    }>(
      `SELECT m.text_asset_id, m.raw_asset_id
         FROM agent_session_materials m
         JOIN agent_sessions s ON s.id=m.session_id
        WHERE s.owner_id=$1`,
      [ownerId],
    );
    for (const material of sessionMaterials.rows) {
      for (const objectKey of [material.text_asset_id, material.raw_asset_id]) {
        if (!objectKey) continue;
        mergeDeletionObject(objects, {
          bucketId: buckets.materials,
          objectKey,
          status: 'pending',
        });
      }
    }

    // Study parse artifacts (JSON, text, images) live in the material byte
    // store under study/{owner}/; their uploads are already owner_material rows.
    const studyArtifacts = await client.query<{ object_keys: unknown }>(
      `SELECT object_keys FROM study_material_artifacts WHERE owner_id=$1`,
      [ownerId],
    );
    // Plus objects a parse attempt staged but never committed (it died first).
    const stagedObjects = await client.query<{ object_keys: unknown }>(
      `SELECT staged_object_keys AS object_keys FROM learning_task_attempts
        WHERE owner_id=$1 AND staged_object_keys <> '[]'::jsonb`,
      [ownerId],
    );
    for (const artifact of [...studyArtifacts.rows, ...stagedObjects.rows]) {
      for (const objectKey of Array.isArray(artifact.object_keys) ? artifact.object_keys : []) {
        if (typeof objectKey !== 'string' || !objectKey) continue;
        mergeDeletionObject(objects, {
          bucketId: buckets.materials,
          objectKey,
          status: 'pending',
        });
      }
    }

    const snapshots = await client.query<{ storage_ref: string | null }>(
      'SELECT storage_ref FROM classroom_snapshots WHERE owner_id=$1',
      [ownerId],
    );
    for (const row of snapshots.rows) {
      const parsed = storageReference(row.storage_ref, buckets.classrooms);
      if (parsed)
        mergeDeletionObject(objects, {
          bucketId: parsed[0],
          objectKey: parsed[1],
          status: 'pending',
        });
    }

    const renders = await client.query<{ output_ref: string | null }>(
      'SELECT output_ref FROM render_job_owners WHERE owner_id=$1',
      [ownerId],
    );
    for (const row of renders.rows) {
      const parsed = storageReference(row.output_ref, buckets.classrooms);
      if (parsed)
        mergeDeletionObject(objects, {
          bucketId: parsed[0],
          objectKey: parsed[1],
          status: 'pending',
        });
    }

    const manifestObjects = [...objects.values()];
    for (const object of manifestObjects) {
      await client.query(
        `INSERT INTO account_deletion_objects
           (user_id,bucket_id,object_key,content_hash,status)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(user_id,bucket_id,object_key) DO UPDATE SET
           content_hash=COALESCE(EXCLUDED.content_hash,account_deletion_objects.content_hash),
           status=CASE
             WHEN account_deletion_objects.status='deleted' THEN 'deleted'
             ELSE EXCLUDED.status
           END,
           updated_at=clock_timestamp()`,
        [userId, object.bucketId, object.objectKey, object.contentHash ?? null, object.status],
      );
    }
    await client.query(
      `UPDATE account_deletion_jobs SET
         status='running', phase='manifest_ready',
         manifest=COALESCE(manifest,'{}'::jsonb) || jsonb_build_object('objectCount',$2::int),
         attempt_count=attempt_count+1, updated_at=clock_timestamp(), last_error=NULL
       WHERE user_id=$1`,
      [userId, manifestObjects.length],
    );
    return manifestObjects;
  });
}

/** Delete owned rows in FK-safe order, retaining the job/tombstone for retries. */
export async function deleteAccountRelations(pool: Pool, userId: string): Promise<void> {
  try {
    await transaction(pool, async (client) => {
      await lockDeletion(client, userId);
      const job = await client.query<{ owner_id: string }>(
        'SELECT owner_id FROM account_deletion_jobs WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      if (!job.rows.length) throw new Error('ACCOUNT_DELETION_NOT_REQUESTED');
      const ownerId = job.rows[0]!.owner_id;

      await client.query(
        `DELETE FROM generation_attempts a USING generation_steps s, generation_jobs j
        WHERE a.step_id=s.id AND s.job_id=j.id AND j.owner_id=$1`,
        [ownerId],
      );
      for (const table of [
        'generation_commands',
        'generation_events',
        'generation_job_assets',
        'generation_scenes',
        'generation_steps',
      ]) {
        await client.query(
          `DELETE FROM ${table} child USING generation_jobs j
          WHERE child.job_id=j.id AND j.owner_id=$1`,
          [ownerId],
        );
      }
      await client.query('DELETE FROM generation_jobs WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM generation_ownership WHERE owner_id=$1', [ownerId]);

      await client.query('DELETE FROM agent_owner_session_events WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM agent_owner_session_event_counters WHERE owner_id=$1', [
        ownerId,
      ]);
      await client.query('DELETE FROM agent_sessions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM agent_user_skill WHERE owner_id=$1', [ownerId]);
      await client.query(
        `DELETE FROM pro_model_connection_revisions r USING pro_model_connections c
        WHERE r.connection_id=c.id AND c.owner_id=$1`,
        [ownerId],
      );
      await client.query('DELETE FROM pro_model_connections WHERE owner_id=$1', [ownerId]);
      // Sign-in sessions reference credentials, so they go first.
      await client.query('DELETE FROM model_auth_sessions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM model_credentials WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM media_config_snapshots WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM generation_model_snapshots WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM generation_search_snapshots WHERE owner_id=$1', [ownerId]);

      await client.query(
        `DELETE FROM runtime_records r USING runtime_sessions s
        WHERE r.session_id=s.id AND (
          s.learner_key=$1 OR EXISTS(
            SELECT 1 FROM document_stages d WHERE d.id=s.stage_id AND d.owner_id=$1
          )
        )`,
        [ownerId],
      );
      await client.query(
        `DELETE FROM runtime_sessions s WHERE s.learner_key=$1 OR EXISTS(
         SELECT 1 FROM document_stages d WHERE d.id=s.stage_id AND d.owner_id=$1
       )`,
        [ownerId],
      );

      await client.query('DELETE FROM classroom_media_objects WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM classroom_generation_jobs WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM classroom_snapshots WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM render_job_owners WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM usage_events WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM account_kv WHERE owner_id=$1', [ownerId]);
      // Retrieval (v24): chunks only exist where the extensions were
      // available; indexes and saved answers with their citations always do.
      const knowledgeChunks = await client.query<{ present: boolean }>(
        "SELECT to_regclass('study_knowledge_chunks') IS NOT NULL AS present",
      );
      if (knowledgeChunks.rows[0]?.present) {
        await client.query('DELETE FROM study_knowledge_chunks WHERE owner_id=$1', [ownerId]);
      }
      await client.query('DELETE FROM study_knowledge_indexes WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_qa_citations WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_qa_answers WHERE owner_id=$1', [ownerId]);
      // Exercise extraction (v29): candidates under their extraction, which
      // references a space and a parsed material version.
      await client.query('DELETE FROM study_question_candidates WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_question_extractions WHERE owner_id=$1', [ownerId]);
      // Open-item gradings (v30) under their attempts.
      await client.query('DELETE FROM study_exam_gradings WHERE owner_id=$1', [ownerId]);
      // Question bank and papers (v28): attempts and items under their
      // papers, versions under their questions, all under the owner's spaces.
      await client.query('DELETE FROM study_exam_attempts WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_exam_items WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_exam_papers WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_question_versions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_questions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_concepts WHERE owner_id=$1', [ownerId]);
      // Memory (v27): events reference courses and spaces; preferences, facts
      // and controls reference spaces; suppressions stand alone.
      await client.query('DELETE FROM study_learning_events WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_learner_preferences WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_memory_facts WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_memory_controls WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_memory_suppressions WHERE owner_id=$1', [ownerId]);
      // After-class chats (v26) name a space and a classmate; their agent
      // sessions are removed with the other agent tables.
      await client.query('DELETE FROM study_companion_chats WHERE owner_id=$1', [ownerId]);
      // Classmates (v25) link to materials, so they go first; revisions and
      // material links cascade from their template but are named explicitly.
      await client.query('DELETE FROM study_classmate_materials WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_classmate_revisions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_classmates WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_classmate_avatars WHERE owner_id=$1', [ownerId]);
      // Study materials (v23): session refs and space links first, then
      // artifacts and versions under their materials, then the task queue.
      await client.query('DELETE FROM study_session_material_refs WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_space_materials WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_material_artifacts WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_material_versions WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_materials WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM learning_task_attempts WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM learning_tasks WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM owner_material WHERE owner_id=$1', [ownerId]);
      // Study links and progress reference the owner's spaces and courses, so
      // they go before both.
      await client.query('DELETE FROM study_progress WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_space_courses WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM study_spaces WHERE owner_id=$1', [ownerId]);

      await client.query(
        `DELETE FROM document_scene_revision r USING document_stages d
        WHERE r.stage_id=d.id AND d.owner_id=$1`,
        [ownerId],
      );
      await client.query(
        `DELETE FROM document_stage_revision r USING document_stages d
        WHERE r.stage_id=d.id AND d.owner_id=$1`,
        [ownerId],
      );
      await client.query('DELETE FROM document_stages WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM document_folders WHERE owner_id=$1', [ownerId]);

      const hashes = await client.query<{ content_hash: string }>(
        'DELETE FROM asset_entries WHERE principal=$1 RETURNING content_hash',
        [ownerId],
      );
      if (hashes.rows.length) {
        await client.query(
          `DELETE FROM asset_blobs b
          WHERE b.content_hash=ANY($1::text[])
            AND NOT EXISTS(SELECT 1 FROM asset_entries e WHERE e.content_hash=b.content_hash)`,
          [hashes.rows.map((row) => row.content_hash)],
        );
        // Re-evaluate sharing at the same transaction boundary that removed the
        // owner's references.  This closes both races: a newly shared blob is
        // never deleted, and a formerly shared blob that is now unreferenced is
        // promoted to pending cleanup rather than leaked forever.
        await client.query(
          `UPDATE account_deletion_objects o
            SET status=CASE
              WHEN EXISTS(
                SELECT 1 FROM asset_entries e WHERE e.content_hash=o.content_hash
              ) THEN 'retained_shared'
              ELSE 'pending'
            END,
            updated_at=clock_timestamp()
          WHERE o.user_id=$1
            AND o.content_hash=ANY($2::text[])
            AND o.status<>'deleted'`,
          [userId, hashes.rows.map((row) => row.content_hash)],
        );
      }
      await client.query('DELETE FROM app_profiles WHERE user_id=$1', [userId]);

      await client.query(
        `UPDATE account_deletion_jobs SET phase='relations_deleted',updated_at=clock_timestamp()
        WHERE user_id=$1`,
        [userId],
      );
    });
  } catch (error) {
    await pool
      .query(
        `UPDATE account_deletion_jobs
            SET status='retry',phase='relation_cleanup',last_error='relation cleanup failed',
                updated_at=clock_timestamp()
          WHERE user_id=$1`,
        [userId],
      )
      .catch(() => undefined);
    throw error;
  }
}

export async function deleteAccountObjects(
  pool: Pool,
  userId: string,
  store: AccountDeletionObjectStore,
): Promise<void> {
  const pending = await pool.query<{
    bucket_id: string;
    object_key: string;
    status: DeletionObject['status'];
  }>(
    `SELECT bucket_id,object_key,status FROM account_deletion_objects
      WHERE user_id=$1 AND status IN ('pending','retry') ORDER BY bucket_id,object_key`,
    [userId],
  );
  for (const object of pending.rows) {
    try {
      await store.delete(object.bucket_id, object.object_key);
      await pool.query(
        `UPDATE account_deletion_objects SET status='deleted',last_error=NULL,
           attempt_count=attempt_count+1,updated_at=clock_timestamp()
         WHERE user_id=$1 AND bucket_id=$2 AND object_key=$3`,
        [userId, object.bucket_id, object.object_key],
      );
    } catch (error) {
      await pool.query(
        `UPDATE account_deletion_objects SET status='retry',last_error=$4,
           attempt_count=attempt_count+1,updated_at=clock_timestamp()
         WHERE user_id=$1 AND bucket_id=$2 AND object_key=$3`,
        [
          userId,
          object.bucket_id,
          object.object_key,
          error instanceof Error ? error.message : String(error),
        ],
      );
      await pool.query(
        `UPDATE account_deletion_jobs SET status='retry',phase='object_cleanup',
           last_error='one or more object deletions failed',updated_at=clock_timestamp()
         WHERE user_id=$1`,
        [userId],
      );
      throw error;
    }
  }
  await pool.query(
    `UPDATE account_deletion_jobs SET status='running',phase='objects_deleted',
       last_error=NULL,updated_at=clock_timestamp() WHERE user_id=$1`,
    [userId],
  );
}

/** Remove the account registry, then the Auth user, only after every object settled. */
export async function finalizeAccountDeletion(
  pool: Pool,
  userId: string,
  auth: AccountDeletionAuthAdmin,
): Promise<void> {
  const state = await pool.query<{ owner_id: string; phase: string; unsettled: string }>(
    `SELECT j.owner_id,j.phase,
       (SELECT count(*)::text FROM account_deletion_objects o
         WHERE o.user_id=j.user_id AND o.status IN ('pending','retry')) AS unsettled
     FROM account_deletion_jobs j WHERE j.user_id=$1`,
    [userId],
  );
  if (!state.rows.length) throw new Error('ACCOUNT_DELETION_NOT_REQUESTED');
  if (!['objects_deleted', 'auth_delete', 'complete'].includes(state.rows[0]!.phase)) {
    throw new Error('ACCOUNT_DELETION_RELATIONS_UNSETTLED');
  }
  if (state.rows[0]!.unsettled !== '0') throw new Error('ACCOUNT_DELETION_OBJECTS_UNSETTLED');

  await auth.block(userId);
  await transaction(pool, async (client) => {
    await lockDeletion(client, userId);
    await client.query('DELETE FROM app_profiles WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM app_accounts WHERE user_id=$1', [userId]);
    await client.query(
      `UPDATE account_deletion_jobs SET phase='auth_delete',updated_at=clock_timestamp()
       WHERE user_id=$1`,
      [userId],
    );
  });

  try {
    await auth.delete(userId);
  } catch (error) {
    await pool.query(
      `UPDATE account_deletion_jobs SET status='retry',phase='auth_delete',last_error=$2,
         updated_at=clock_timestamp() WHERE user_id=$1`,
      [userId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
  await pool.query(
    `UPDATE account_deletion_jobs SET status='complete',phase='complete',last_error=NULL,
       completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=$1`,
    [userId],
  );
}
