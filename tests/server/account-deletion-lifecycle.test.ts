import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteAccountObjects,
  deleteAccountRelations,
  findResumableAccountDeletionByEmail,
  finalizeAccountDeletion,
  prepareAccountDeletionManifest,
  requestAccountDeletion,
} from '@/lib/server/accounts/deletion';

interface TestDatabase {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
}

class TestPool {
  constructor(readonly db: TestDatabase) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = `user:${USER_ID}`;
const SECOND_USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER = 'user:22222222-2222-4222-8222-222222222222';

const postgresUrl = process.env.TEST_ACCOUNT_DELETION_DATABASE_URL;
const backends = postgresUrl ? ['pglite', 'postgres'] : ['pglite'];

describe.each(backends)('account deletion lifecycle (%s)', (backend) => {
  let db: TestDatabase;
  let pool: TestPool;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    if (backend === 'postgres') {
      const target = new URL(postgresUrl!);
      if (
        target.hostname !== '127.0.0.1' ||
        target.port !== '55432' ||
        !target.pathname.endsWith('_rls_proof')
      ) {
        throw new Error('Account deletion proof requires a disposable local *_rls_proof database');
      }
      const schema = `deletion_test_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pg = new Pool({
        connectionString: postgresUrl,
        max: 1,
        options: `-c search_path=${schema}`,
      });
      db = { query: pg.query.bind(pg), exec: (sql) => pg.query(sql) };
      cleanup = async () => {
        await pg.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      };
    } else {
      const embedded = new PGlite();
      db = embedded;
      cleanup = () => embedded.close();
    }
    pool = new TestPool(db);
    await db.exec(`
      CREATE TABLE account_deletion_jobs(user_id uuid primary key, owner_id text, status text, phase text,
        manifest jsonb default '{}', attempt_count int default 0, last_error text, updated_at timestamptz,
        completed_at timestamptz);
      CREATE TABLE account_deletion_objects(user_id uuid, bucket_id text, object_key text, content_hash text,
        status text, attempt_count int default 0, last_error text, updated_at timestamptz,
        primary key(user_id,bucket_id,object_key));
      CREATE TABLE deleted_account_tombstones(user_id uuid primary key,owner_id text unique,reason text);
      CREATE TABLE admin_audit_events(actor_user_id uuid,target_internal_id text,action text,result text);
      CREATE TABLE app_accounts(user_id uuid primary key, owner_id text unique,status text default 'active',
        session_valid_after timestamptz default to_timestamp(0),updated_at timestamptz default now());
      CREATE TABLE app_profiles(user_id uuid primary key);
      CREATE TABLE asset_blobs(content_hash text primary key);
      CREATE TABLE asset_entries(id text primary key, principal text, content_hash text);
      CREATE TABLE owner_material(id text primary key, owner_id text, oss_key text);
      CREATE TABLE classroom_snapshots(owner_id text, storage_ref text);
      CREATE TABLE render_job_owners(owner_id text, output_ref text);
      CREATE TABLE classroom_media_objects(owner_id text);
      CREATE TABLE classroom_generation_jobs(owner_id text);
      CREATE TABLE usage_events(owner_id text);
      CREATE TABLE account_kv(owner_id text);
      CREATE TABLE document_folders(owner_id text);
      CREATE TABLE document_stages(id text primary key, owner_id text);
      CREATE TABLE document_scene_revision(stage_id text);
      CREATE TABLE document_stage_revision(stage_id text);
      CREATE TABLE runtime_sessions(id text primary key,stage_id text,learner_key text);
      CREATE TABLE runtime_records(id text primary key,session_id text);
      CREATE TABLE generation_jobs(id uuid primary key,owner_id text,status text default 'queued',
        cancel_requested_at timestamptz,lease_epoch bigint default 0,worker_id text,
        lease_expires_at timestamptz,heartbeat_at timestamptz,finished_at timestamptz,
        state_version bigint default 0,updated_at timestamptz default now());
      CREATE TABLE generation_provider_slots(quota_group text,slot_no int,holder_attempt_id uuid,
        lease_epoch bigint default 0,expires_at timestamptz,primary key(quota_group,slot_no));
      CREATE TABLE generation_steps(id uuid primary key,job_id uuid);
      CREATE TABLE generation_attempts(id uuid primary key,step_id uuid);
      CREATE TABLE generation_commands(job_id uuid);
      CREATE TABLE generation_events(job_id uuid);
      CREATE TABLE generation_job_assets(job_id uuid);
      CREATE TABLE generation_scenes(job_id uuid);
      CREATE TABLE generation_ownership(owner_id text,ownership_epoch bigint default 1,updated_at timestamptz default now());
      CREATE TABLE agent_sessions(id text primary key,owner_id text,cancel_requested_at bigint,
        attempt int default 0,lease_worker_id text,lease_worker_pid int,lease_heartbeat_at bigint,
        updated_at timestamptz default now(),deleted_at timestamptz);
      CREATE TABLE agent_session_materials(id text primary key,session_id text references agent_sessions(id) on delete cascade,
        text_asset_id text,raw_asset_id text,extraction_attempts int default 0,
        extraction_lease_worker_id text,extraction_lease_worker_pid int,extraction_lease_heartbeat_at bigint);
      CREATE TABLE agent_owner_session_events(owner_id text);
      CREATE TABLE agent_owner_session_event_counters(owner_id text);
      CREATE TABLE agent_user_skill(owner_id text);
      CREATE TABLE pro_model_connections(id uuid primary key,owner_id text);
      CREATE TABLE pro_model_connection_revisions(connection_id uuid);
      CREATE TABLE model_credentials(id uuid primary key,owner_id text);
      CREATE TABLE model_auth_sessions(id uuid primary key,owner_id text,
        credential_id uuid references model_credentials(id));
      CREATE TABLE study_spaces(id text primary key,owner_id text,unique(owner_id,id));
      CREATE TABLE study_space_courses(owner_id text,space_id text,
        stage_id text references document_stages(id),
        foreign key(owner_id,space_id) references study_spaces(owner_id,id));
      CREATE TABLE study_progress(owner_id text,stage_id text references document_stages(id));
      CREATE TABLE study_materials(id text primary key,owner_id text,unique(owner_id,id));
      CREATE TABLE study_material_versions(id text primary key,owner_id text,material_id text,
        unique(owner_id,id),foreign key(owner_id,material_id) references study_materials(owner_id,id));
      CREATE TABLE study_material_artifacts(id text primary key,owner_id text,version_id text,
        object_keys jsonb,foreign key(owner_id,version_id) references study_material_versions(owner_id,id));
      CREATE TABLE study_space_materials(owner_id text,space_id text,material_id text,
        foreign key(owner_id,space_id) references study_spaces(owner_id,id),
        foreign key(owner_id,material_id) references study_materials(owner_id,id));
      CREATE TABLE study_session_material_refs(owner_id text,session_id text,version_id text,
        foreign key(owner_id,version_id) references study_material_versions(owner_id,id));
      CREATE TABLE study_knowledge_indexes(id text primary key,owner_id text,version_id text,
        unique(owner_id,id),foreign key(owner_id,version_id) references study_material_versions(owner_id,id));
      CREATE TABLE study_knowledge_chunks(owner_id text,index_id text,id text,
        foreign key(owner_id,index_id) references study_knowledge_indexes(owner_id,id));
      CREATE TABLE study_qa_answers(id text primary key,owner_id text,space_id text,unique(owner_id,id),
        foreign key(owner_id,space_id) references study_spaces(owner_id,id));
      CREATE TABLE study_qa_citations(owner_id text,answer_id text,version_id text,
        foreign key(owner_id,answer_id) references study_qa_answers(owner_id,id),
        foreign key(owner_id,version_id) references study_material_versions(owner_id,id));
      CREATE TABLE study_classmates(id text primary key,owner_id text,unique(owner_id,id));
      CREATE TABLE study_classmate_revisions(owner_id text,classmate_id text,revision int,
        foreign key(owner_id,classmate_id) references study_classmates(owner_id,id));
      CREATE TABLE study_classmate_materials(owner_id text,classmate_id text,material_id text,
        foreign key(owner_id,classmate_id) references study_classmates(owner_id,id),
        foreign key(owner_id,material_id) references study_materials(owner_id,id));
      CREATE TABLE study_classmate_avatars(id text primary key,owner_id text);
      CREATE TABLE study_companion_chats(session_id text primary key,owner_id text,classmate_id text,
        foreign key(owner_id,classmate_id) references study_classmates(owner_id,id));
      CREATE TABLE learning_tasks(id uuid primary key,owner_id text);
      CREATE TABLE learning_task_attempts(id uuid primary key,task_id uuid references learning_tasks(id),owner_id text,
        staged_object_keys jsonb not null default '[]');
      CREATE TABLE media_config_snapshots(owner_id text);
      CREATE TABLE generation_model_snapshots(owner_id text);
      CREATE TABLE generation_search_snapshots(owner_id text);
      INSERT INTO account_deletion_jobs(user_id,owner_id,status,phase,updated_at)
        VALUES('${USER_ID}','${OWNER}','pending','requested',now());
      INSERT INTO app_accounts(user_id,owner_id) VALUES('${USER_ID}','${OWNER}');
      INSERT INTO asset_blobs VALUES('hash-was-shared'),('hash-became-shared');
      INSERT INTO asset_entries VALUES
        ('a-1','${OWNER}','hash-was-shared'),
        ('b-1','${OTHER}','hash-was-shared'),
        ('a-2','${OWNER}','hash-became-shared');
      INSERT INTO owner_material VALUES('m-1','${OWNER}','materials/same-object');
      INSERT INTO agent_sessions VALUES('session-1','${OWNER}');
      INSERT INTO agent_session_materials VALUES
        ('sm-1','session-1','materials/text-object','materials/same-object');
      INSERT INTO classroom_snapshots VALUES('${OWNER}','s3://private-classrooms/snapshots/course.json');
      INSERT INTO model_credentials VALUES
        ('00000000-0000-4000-8000-0000000000c1','${OWNER}'),
        ('00000000-0000-4000-8000-0000000000c2','${OTHER}');
      INSERT INTO model_auth_sessions VALUES
        ('00000000-0000-4000-8000-0000000000a1','${OWNER}','00000000-0000-4000-8000-0000000000c1'),
        ('00000000-0000-4000-8000-0000000000a2','${OTHER}','00000000-0000-4000-8000-0000000000c2');
      INSERT INTO document_stages VALUES('stage-owner','${OWNER}'),('stage-other','${OTHER}');
      INSERT INTO study_spaces VALUES('space-owner','${OWNER}'),('space-other','${OTHER}');
      INSERT INTO study_space_courses VALUES
        ('${OWNER}','space-owner','stage-owner'),('${OTHER}','space-other','stage-other');
      INSERT INTO study_progress VALUES('${OWNER}','stage-owner'),('${OTHER}','stage-other');
      INSERT INTO study_materials VALUES('mat-owner','${OWNER}'),('mat-other','${OTHER}');
      INSERT INTO study_material_versions VALUES
        ('ver-owner','${OWNER}','mat-owner'),('ver-other','${OTHER}','mat-other');
      INSERT INTO study_material_artifacts VALUES
        ('art-owner','${OWNER}','ver-owner','["study/owner/artifacts/art-owner/text.md"]'),
        ('art-other','${OTHER}','ver-other','["study/other/artifacts/art-other/text.md"]');
      INSERT INTO study_space_materials VALUES
        ('${OWNER}','space-owner','mat-owner'),('${OTHER}','space-other','mat-other');
      INSERT INTO study_session_material_refs VALUES
        ('${OWNER}','session-1','ver-owner'),('${OTHER}','session-x','ver-other');
      INSERT INTO study_knowledge_indexes VALUES
        ('idx-owner','${OWNER}','ver-owner'),('idx-other','${OTHER}','ver-other');
      INSERT INTO study_knowledge_chunks VALUES
        ('${OWNER}','idx-owner','c-1'),('${OTHER}','idx-other','c-1');
      INSERT INTO study_qa_answers VALUES
        ('ans-owner','${OWNER}','space-owner'),('ans-other','${OTHER}','space-other');
      INSERT INTO study_qa_citations VALUES
        ('${OWNER}','ans-owner','ver-owner'),('${OTHER}','ans-other','ver-other');
      INSERT INTO study_classmates VALUES('cm-owner','${OWNER}'),('cm-other','${OTHER}');
      INSERT INTO study_classmate_revisions VALUES
        ('${OWNER}','cm-owner',1),('${OTHER}','cm-other',1);
      INSERT INTO study_classmate_materials VALUES
        ('${OWNER}','cm-owner','mat-owner'),('${OTHER}','cm-other','mat-other');
      INSERT INTO study_classmate_avatars VALUES('av-owner','${OWNER}'),('av-other','${OTHER}');
      INSERT INTO study_companion_chats VALUES
        ('chat-owner','${OWNER}','cm-owner'),('chat-other','${OTHER}','cm-other');
      INSERT INTO learning_tasks VALUES
        ('30000000-0000-4000-8000-000000000001','${OWNER}'),
        ('30000000-0000-4000-8000-000000000002','${OTHER}');
      INSERT INTO learning_task_attempts VALUES
        ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','${OWNER}',
         '["study/owner/artifacts/art-crashed/artifact.json"]'),
        ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','${OTHER}',
         '["study/other/artifacts/art-crashed/artifact.json"]');
    `);
  });

  it('marks access deleting and stores the Pro cancellation fence as epoch milliseconds', async () => {
    await db.exec(`
      INSERT INTO generation_jobs(id,owner_id,status,worker_id,lease_expires_at) VALUES
        ('10000000-0000-4000-8000-000000000001','${OWNER}','queued',NULL,NULL),
        ('10000000-0000-4000-8000-000000000002','${OWNER}','retry_wait',NULL,NULL),
        ('10000000-0000-4000-8000-000000000003','${OWNER}','running','worker-1',now()+interval '1 hour'),
        ('10000000-0000-4000-8000-000000000004','${OWNER}','succeeded',NULL,NULL);
      INSERT INTO generation_provider_slots(quota_group,slot_no,holder_attempt_id,expires_at) VALUES
        ('heavy-task:sync-owner:${OWNER}',0,'20000000-0000-4000-8000-000000000001',now()+interval '1 hour'),
        ('provider:unrelated',0,'20000000-0000-4000-8000-000000000002',now()+interval '1 hour');
    `);
    await requestAccountDeletion(pool as never, USER_ID);
    const account = await db.query<{ status: string }>(
      'SELECT status FROM app_accounts WHERE user_id=$1',
      [USER_ID],
    );
    const session = await db.query<{ cancel_requested_at: string; attempt: number }>(
      'SELECT cancel_requested_at::text,attempt FROM agent_sessions WHERE id=$1',
      ['session-1'],
    );
    expect(account.rows[0]?.status).toBe('deleting');
    expect(Number(session.rows[0]?.cancel_requested_at)).toBeGreaterThan(1_000_000_000_000);
    expect(session.rows[0]?.attempt).toBe(1);
    const jobs = await db.query<{ status: string; worker_id: string | null }>(
      'SELECT status,worker_id FROM generation_jobs ORDER BY id',
    );
    expect(jobs.rows).toEqual([
      { status: 'cancelled', worker_id: null },
      { status: 'cancelled', worker_id: null },
      { status: 'cancelled', worker_id: null },
      { status: 'succeeded', worker_id: null },
    ]);
    expect(
      (
        await db.query(
          `SELECT 1 FROM generation_provider_slots
            WHERE quota_group='heavy-task:sync-owner:${OWNER}'`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT 1 FROM generation_provider_slots WHERE quota_group='provider:unrelated'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('recovers an unfinished deletion by its normalized email after Auth identity is gone', async () => {
    await requestAccountDeletion(pool as never, USER_ID, {
      recoveryEmail: 'Recovery.User@Example.test',
    });
    await db.query('DELETE FROM app_accounts WHERE user_id=$1', [USER_ID]);

    const recovered = await findResumableAccountDeletionByEmail(
      pool as never,
      '  recovery.user@example.test  ',
    );

    expect(recovered).toEqual(
      expect.objectContaining({
        userId: USER_ID,
        ownerId: OWNER,
        status: 'pending',
      }),
    );
  });

  it('does not expose or silently replace the recovery identity on a retry', async () => {
    await requestAccountDeletion(pool as never, USER_ID, {
      recoveryEmail: 'first@example.test',
    });

    await expect(
      requestAccountDeletion(pool as never, USER_ID, {
        recoveryEmail: 'different@example.test',
      }),
    ).rejects.toThrow('ACCOUNT_DELETION_RECOVERY_IDENTITY_MISMATCH');

    const stored = await db.query<{ manifest: string }>(
      'SELECT manifest::text AS manifest FROM account_deletion_jobs WHERE user_id=$1',
      [USER_ID],
    );
    expect(stored.rows[0]?.manifest).not.toContain('first@example.test');
    expect(stored.rows[0]?.manifest).not.toContain('different@example.test');
  });

  it('fails closed when more than one unfinished job has the same recovery identity', async () => {
    await requestAccountDeletion(pool as never, USER_ID, {
      recoveryEmail: 'duplicate@example.test',
    });
    await db.query('INSERT INTO app_accounts(user_id,owner_id) VALUES($1,$2)', [
      SECOND_USER_ID,
      `user:${SECOND_USER_ID}`,
    ]);
    await requestAccountDeletion(pool as never, SECOND_USER_ID, {
      recoveryEmail: 'duplicate@example.test',
    });
    expect(
      (
        await db.query(
          "SELECT user_id FROM account_deletion_jobs WHERE manifest->>'operator_email_sha256' IS NOT NULL",
        )
      ).rows,
    ).toHaveLength(2);

    await expect(
      findResumableAccountDeletionByEmail(pool as never, 'duplicate@example.test'),
    ).rejects.toThrow('ACCOUNT_DELETION_RECOVERY_AMBIGUOUS');
  });

  it('captures session bytes once and rechecks shared hashes after owner rows are removed', async () => {
    const manifest = await prepareAccountDeletionManifest(pool as never, USER_ID, {
      assets: 'assets',
      materials: 'materials',
      classrooms: 'classrooms',
    });
    expect(manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKey: 'hash-was-shared', status: 'retained_shared' }),
        expect.objectContaining({ objectKey: 'hash-became-shared', status: 'pending' }),
        expect.objectContaining({ objectKey: 'materials/text-object', status: 'pending' }),
        expect.objectContaining({ objectKey: 'materials/same-object', status: 'pending' }),
        expect.objectContaining({
          bucketId: 'materials',
          objectKey: 'study/owner/artifacts/art-owner/text.md',
          status: 'pending',
        }),
        // Staged by a parse attempt that died before committing it.
        expect.objectContaining({
          bucketId: 'materials',
          objectKey: 'study/owner/artifacts/art-crashed/artifact.json',
          status: 'pending',
        }),
        expect.objectContaining({
          bucketId: 'private-classrooms',
          objectKey: 'snapshots/course.json',
          status: 'pending',
        }),
      ]),
    );
    expect(manifest.filter((object) => object.objectKey === 'materials/same-object')).toHaveLength(
      1,
    );

    // Both directions of the race occur after manifest creation.
    await db.query("DELETE FROM asset_entries WHERE id='b-1'");
    await db.query('INSERT INTO asset_entries VALUES($1,$2,$3)', [
      'b-2',
      OTHER,
      'hash-became-shared',
    ]);
    await deleteAccountRelations(pool as never, USER_ID);

    const statuses = await db.query<{ object_key: string; status: string }>(
      `SELECT object_key,status FROM account_deletion_objects
        WHERE content_hash IS NOT NULL ORDER BY object_key`,
    );
    expect(statuses.rows).toEqual([
      { object_key: 'hash-became-shared', status: 'retained_shared' },
      { object_key: 'hash-was-shared', status: 'pending' },
    ]);
    expect(
      (await db.query("SELECT 1 FROM asset_blobs WHERE content_hash='hash-was-shared'")).rows,
    ).toEqual([]);
    expect(
      (await db.query("SELECT 1 FROM asset_blobs WHERE content_hash='hash-became-shared'")).rows,
    ).toHaveLength(1);
    // Credentials and sign-in sessions go with the account; other owners keep theirs.
    expect((await db.query('SELECT owner_id FROM model_credentials')).rows).toEqual([
      { owner_id: OTHER },
    ]);
    expect((await db.query('SELECT owner_id FROM model_auth_sessions')).rows).toEqual([
      { owner_id: OTHER },
    ]);
    // Study spaces, course links and progress go too, before the courses they reference.
    expect(manifest.map((object) => object.objectKey)).not.toContain(
      'study/other/artifacts/art-other/text.md',
    );
    expect(manifest.map((object) => object.objectKey)).not.toContain(
      'study/other/artifacts/art-crashed/artifact.json',
    );
    for (const table of [
      'study_spaces',
      'study_space_courses',
      'study_progress',
      'study_materials',
      'study_material_versions',
      'study_material_artifacts',
      'study_space_materials',
      'study_session_material_refs',
      'learning_tasks',
      'learning_task_attempts',
      'study_knowledge_indexes',
      'study_knowledge_chunks',
      'study_qa_answers',
      'study_qa_citations',
      'study_classmates',
      'study_classmate_revisions',
      'study_classmate_materials',
      'study_classmate_avatars',
      'study_companion_chats',
    ]) {
      expect((await db.query(`SELECT owner_id FROM ${table}`)).rows).toEqual([{ owner_id: OTHER }]);
    }
  });

  it('persists an object failure and resumes without touching retained shared objects', async () => {
    await prepareAccountDeletionManifest(pool as never, USER_ID, {
      assets: 'assets',
      materials: 'materials',
      classrooms: 'classrooms',
    });
    let fail = true;
    const deleted: string[] = [];
    const store = {
      async delete(_bucket: string, key: string) {
        if (fail) {
          fail = false;
          throw new Error('injected storage outage');
        }
        deleted.push(key);
      },
    };
    await expect(deleteAccountObjects(pool as never, USER_ID, store)).rejects.toThrow(
      'injected storage outage',
    );
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM account_deletion_objects WHERE status='retry'",
        )
      ).rows,
    ).toHaveLength(1);
    await deleteAccountObjects(pool as never, USER_ID, store);
    expect(deleted).not.toContain('hash-was-shared');
    expect(
      (
        await db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM account_deletion_objects WHERE status IN ('pending','retry')",
        )
      ).rows[0]?.n,
    ).toBe('0');
  });

  it('refuses Auth/account finalization before relation cleanup reaches the durable phase', async () => {
    await prepareAccountDeletionManifest(pool as never, USER_ID, {
      assets: 'assets',
      materials: 'materials',
      classrooms: 'classrooms',
    });
    await expect(
      finalizeAccountDeletion(pool as never, USER_ID, {
        async block() {},
        async delete() {},
      }),
    ).rejects.toThrow('ACCOUNT_DELETION_RELATIONS_UNSETTLED');
    expect(
      (await db.query('SELECT 1 FROM app_accounts WHERE user_id=$1', [USER_ID])).rows,
    ).toHaveLength(1);
  });

  it('resumes Auth failure after account removal and preserves tombstones and shared bytes', async () => {
    await requestAccountDeletion(pool as never, USER_ID, { recoveryEmail: 'retry@example.test' });
    await prepareAccountDeletionManifest(pool as never, USER_ID, {
      assets: 'assets',
      materials: 'materials',
      classrooms: 'classrooms',
    });
    await deleteAccountRelations(pool as never, USER_ID);
    const removed: string[] = [];
    await deleteAccountObjects(pool as never, USER_ID, {
      async delete(_bucket, key) {
        removed.push(key);
      },
    });
    let attempts = 0;
    const auth = {
      async block() {},
      async delete() {
        attempts += 1;
        if (attempts === 1) throw new Error('injected Auth outage');
      },
    };
    await expect(finalizeAccountDeletion(pool as never, USER_ID, auth)).rejects.toThrow(
      'injected Auth outage',
    );
    expect(
      (await db.query('SELECT 1 FROM app_accounts WHERE user_id=$1', [USER_ID])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query('SELECT status,phase FROM account_deletion_jobs WHERE user_id=$1', [USER_ID]))
        .rows,
    ).toEqual([{ status: 'retry', phase: 'auth_delete' }]);
    expect(
      await findResumableAccountDeletionByEmail(pool as never, 'retry@example.test'),
    ).toMatchObject({ userId: USER_ID, phase: 'auth_delete' });
    await finalizeAccountDeletion(pool as never, USER_ID, auth);
    expect(attempts).toBe(2);
    expect(
      (await db.query('SELECT status,phase FROM account_deletion_jobs WHERE user_id=$1', [USER_ID]))
        .rows,
    ).toEqual([{ status: 'complete', phase: 'complete' }]);
    expect(
      (await db.query('SELECT 1 FROM deleted_account_tombstones WHERE user_id=$1', [USER_ID])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT 1 FROM asset_blobs WHERE content_hash='hash-was-shared'")).rows,
    ).toHaveLength(1);
    expect(removed).not.toContain('hash-was-shared');
  });
});
