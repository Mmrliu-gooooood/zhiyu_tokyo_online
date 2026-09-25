import { randomUUID } from 'node:crypto';

import { Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNTS_MIGRATION_11 } from '@/lib/server/accounts/sql-accounts';
import { ACCOUNTS_RLS_SQL_V19 } from '@/lib/server/accounts/sql-provider-quota';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import {
  ACCOUNTS_RLS_SQL_V11,
  ACCOUNTS_RLS_SQL_V12,
  ACCOUNTS_RLS_SQL_V13,
} from '@/lib/server/accounts/sql-rls';

const connectionString = process.env.TEST_HOSTED_CAPACITY_DATABASE_URL?.trim();
const enabled = Boolean(connectionString);

function assertDisposableDatabase(url: string): void {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (
    parsed.hostname !== '127.0.0.1' ||
    !database.endsWith('_rls_proof') ||
    parsed.port !== '55432'
  ) {
    throw new Error(
      'TEST_HOSTED_CAPACITY_DATABASE_URL must target a disposable *_rls_proof database on port 55432',
    );
  }
}

function asLogin(url: string, user: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = '';
  return parsed.toString();
}

const BASELINE_SQL = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS app_internal CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA app_internal;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_web') THEN CREATE ROLE app_web NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_worker') THEN CREATE ROLE app_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capacity_proof_web') THEN
    CREATE ROLE capacity_proof_web LOGIN;
  END IF;
END
$roles$;
GRANT app_web TO capacity_proof_web;
GRANT USAGE ON SCHEMA public, app_internal TO app_web, app_worker;

CREATE OR REPLACE FUNCTION app_internal.current_owner_id()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.owner_id', true), '') $$;
REVOKE ALL ON FUNCTION app_internal.current_owner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_internal.current_owner_id() TO app_web, app_worker;

CREATE TABLE app_accounts (
  user_id uuid UNIQUE,
  owner_id text PRIMARY KEY,
  role text NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE app_profiles (user_id uuid PRIMARY KEY, display_name text);
CREATE TABLE asset_entries (id text PRIMARY KEY);
CREATE TABLE usage_events (id bigserial PRIMARY KEY, owner_id text NOT NULL);
CREATE TABLE render_job_owners (job_id text PRIMARY KEY, owner_id text NOT NULL);

CREATE TABLE generation_schema_migrations (version integer PRIMARY KEY);
CREATE TABLE generation_worker_heartbeats (
  worker_id text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL,
  draining boolean NOT NULL DEFAULT false,
  pipeline_versions jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  review_policy text NOT NULL DEFAULT 'auto',
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE generation_provider_slots (
  quota_group text NOT NULL,
  slot_no integer NOT NULL,
  holder_attempt_id uuid,
  lease_epoch bigint NOT NULL DEFAULT 0,
  expires_at timestamptz,
  quarantine_until timestamptz,
  cooldown_until timestamptz,
  PRIMARY KEY (quota_group, slot_no)
);
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL,
  lease_worker_id text,
  lease_heartbeat_at bigint,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE agent_session_materials (
  session_id uuid PRIMARY KEY REFERENCES agent_sessions(id),
  extraction_status text NOT NULL,
  extraction_lease_worker_id text,
  extraction_lease_heartbeat_at bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE agent_session_events (
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  seq bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (session_id, seq)
);

ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON generation_jobs TO app_web, app_worker;
CREATE POLICY generation_jobs_web_select ON generation_jobs
  FOR SELECT TO app_web USING (owner_id=app_internal.current_owner_id());
CREATE POLICY generation_jobs_worker_all ON generation_jobs
  FOR ALL TO app_worker USING (true) WITH CHECK (true);
`;

describe.skipIf(!enabled)('hosted capacity SECURITY DEFINER seam under real PostgreSQL RLS', () => {
  let admin: Pool;
  let web: Pool;
  const ownerA = 'user:11111111-1111-4111-8111-111111111111';
  const ownerB = 'user:22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    assertDisposableDatabase(connectionString!);
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(BASELINE_SQL);
    await admin.query(ACCOUNTS_MIGRATION_11);
    await admin.query(ACCOUNTS_RLS_SQL_V11);
    await admin.query(ACCOUNTS_RLS_SQL_V12);
    await admin.query(ACCOUNTS_RLS_SQL_V13);
    await admin.query(ACCOUNTS_RLS_SQL_V19);
    web = new Pool({ connectionString: asLogin(connectionString!, 'capacity_proof_web'), max: 1 });

    await admin.query(
      `INSERT INTO app_accounts(user_id,owner_id) VALUES
       ('11111111-1111-4111-8111-111111111111',$1),
       ('22222222-2222-4222-8222-222222222222',$2)`,
      [ownerA, ownerB],
    );
    await admin.query('INSERT INTO generation_schema_migrations(version) VALUES (4)');
    await admin.query(
      `INSERT INTO generation_worker_heartbeats(worker_id,heartbeat_at,draining,pipeline_versions)
       VALUES ('proof-worker',clock_timestamp(),false,'[2]'::jsonb)`,
    );
    const owners = [
      ownerA,
      ownerA,
      ...Array.from({ length: 14 }, (_, index) => `user:other-${index}`),
    ];
    for (const ownerId of owners) {
      await admin.query(
        `INSERT INTO generation_jobs(id,owner_id,status,lease_expires_at)
         VALUES ($1,$2,'running',clock_timestamp()+interval '10 minutes')`,
        [randomUUID(), ownerId],
      );
    }
  }, 30_000);

  afterAll(async () => {
    await web?.end();
    await admin?.end();
  });

  async function asOwner<T extends Record<string, unknown>>(
    ownerId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const client = await web.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_id',$1,true)", [ownerId]);
      const result = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('reports readiness without granting Web direct access to worker tables', async () => {
    const result = await asOwner<{ schema_version: number; worker_live: boolean }>(
      ownerA,
      'SELECT * FROM app_internal.generation_readiness()',
    );
    expect(result.rows).toEqual([{ schema_version: 4, worker_live: true }]);
    await expect(
      asOwner(ownerA, 'SELECT * FROM generation_worker_heartbeats'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('returns global 16 and owner 2 while ordinary RLS exposes only the owner rows', async () => {
    const visible = await asOwner<{ owner_id: string }>(
      ownerA,
      'SELECT owner_id FROM generation_jobs ORDER BY id',
    );
    expect(visible.rows).toHaveLength(2);
    expect(visible.rows.every((row) => row.owner_id === ownerA)).toBe(true);

    const capacity = await asOwner<{
      total_count: string;
      owner_count: string;
      inherited: boolean;
    }>(
      ownerA,
      `SELECT total_count,owner_count,inherited
         FROM app_internal.heavy_task_capacity(
           'admission',$1,'independent:proof',extract(epoch FROM clock_timestamp())::bigint*1000,
           0,0,0,NULL,2,16,false
         )`,
      [ownerA],
    );
    expect(capacity.rows[0]).toMatchObject({
      total_count: '16',
      owner_count: '2',
      inherited: false,
    });
  });

  it('rejects owner spoofing and keeps global source tables private', async () => {
    await expect(
      asOwner(
        ownerA,
        `SELECT * FROM app_internal.heavy_task_capacity(
          'admission',$1,'independent:spoof',0,0,0,0,NULL,2,16,false
        )`,
        [ownerB],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asOwner(ownerA, 'SELECT * FROM generation_provider_slots')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('executes the queue, attention, fairness and attention-reservation branches', async () => {
    for (const operation of ['queue', 'attention'] as const) {
      const result = await asOwner<{ total_count: string; owner_count: string }>(
        ownerB,
        `SELECT total_count,owner_count FROM app_internal.heavy_task_capacity(
          $1,$2,'independent:branch-proof',0,0,0,0,NULL,2,16,false
        )`,
        [operation, ownerB],
      );
      expect(result.rows[0]).toEqual({ total_count: '0', owner_count: '0' });
    }

    const fair = await asOwner<{ candidate_present: boolean; oldest_root: string }>(
      ownerB,
      `SELECT candidate_present,oldest_root FROM app_internal.heavy_task_capacity(
        'fair',$1,'independent:branch-proof',0,0,0,0,1,2,16,false
      )`,
      [ownerB],
    );
    expect(fair.rows[0]).toEqual({
      candidate_present: true,
      oldest_root: 'independent:branch-proof',
    });

    const job = await admin.query<{ id: string }>(
      'SELECT id::text FROM generation_jobs WHERE owner_id=$1 LIMIT 1',
      [ownerA],
    );
    const reservation = await asOwner<{ reserved: boolean }>(
      ownerA,
      'SELECT app_internal.reserve_heavy_task_attention($1,16) AS reserved',
      [job.rows[0]!.id],
    );
    expect(reservation.rows[0]?.reserved).toBe(true);
  });

  it('fences synchronous capacity at two slots and permits only its owner to renew/release', async () => {
    const holders = [randomUUID(), randomUUID(), randomUUID()];
    const first = await asOwner<{ slot_no: number; lease_epoch: string }>(
      ownerA,
      'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
      [ownerA, holders[0]],
    );
    const second = await asOwner<{ slot_no: number; lease_epoch: string }>(
      ownerA,
      'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
      [ownerA, holders[1]],
    );
    const third = await asOwner<{ slot_no: number; lease_epoch: string }>(
      ownerA,
      'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
      [ownerA, holders[2]],
    );
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(third.rows).toHaveLength(0);

    const lease = first.rows[0]!;
    const quota = `heavy-task:sync-owner:${ownerA}`;
    const alive = await asOwner<{ alive: boolean }>(
      ownerA,
      'SELECT app_internal.heartbeat_heavy_task_sync_lease($1,$2,$3,$4,60000) AS alive',
      [quota, lease.slot_no, holders[0], lease.lease_epoch],
    );
    expect(alive.rows[0]?.alive).toBe(true);
    await expect(
      asOwner(ownerB, 'SELECT app_internal.release_heavy_task_sync_lease($1,$2,$3,$4)', [
        quota,
        lease.slot_no,
        holders[0],
        lease.lease_epoch,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    const released = await asOwner<{ released: boolean }>(
      ownerA,
      'SELECT app_internal.release_heavy_task_sync_lease($1,$2,$3,$4) AS released',
      [quota, lease.slot_no, holders[0], lease.lease_epoch],
    );
    expect(released.rows[0]?.released).toBe(true);
  });

  it('shares one foreground stage root, enforces 2/16, prevents spoofing, and releases', async () => {
    await admin.query('DELETE FROM generation_provider_slots');
    await admin.query('DELETE FROM generation_jobs');
    const holders = [randomUUID(), randomUUID(), randomUUID()];
    const acquire = (sessionOwner: string, requestedOwner: string, holder: string) =>
      asOwner<{ allowed: boolean; reason: string | null }>(
        sessionOwner,
        `SELECT * FROM app_internal.acquire_foreground_generation_root(
          $1,$2,100000,0,0,2,16,3600000
        )`,
        [requestedOwner, holder],
      );

    expect((await acquire(ownerA, ownerA, holders[0])).rows[0]).toEqual({
      allowed: true,
      reason: null,
    });
    expect((await acquire(ownerA, ownerA, holders[0])).rows[0]).toEqual({
      allowed: true,
      reason: null,
    });
    expect((await acquire(ownerA, ownerA, holders[1])).rows[0]?.allowed).toBe(true);
    expect((await acquire(ownerA, ownerA, holders[2])).rows[0]).toEqual({
      allowed: false,
      reason: 'personal_limit',
    });
    const roots = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM generation_provider_slots
        WHERE quota_group=$1 AND holder_attempt_id IS NOT NULL`,
      [`heavy-task:sync-owner:${ownerA}`],
    );
    expect(roots.rows[0]?.count).toBe('2');

    await expect(acquire(ownerA, ownerB, randomUUID())).rejects.toMatchObject({ code: '42501' });

    for (let index = 0; index < 14; index += 1) {
      await admin.query(
        `INSERT INTO generation_provider_slots(
           quota_group,slot_no,holder_attempt_id,lease_epoch,expires_at
         ) VALUES($1,0,$2,1,clock_timestamp()+interval '1 hour')`,
        [`heavy-task:sync-owner:user:site-${index}`, randomUUID()],
      );
    }
    expect((await acquire(ownerB, ownerB, randomUUID())).rows[0]).toEqual({
      allowed: false,
      reason: 'site_limit',
    });

    const released = await asOwner<{ released: boolean }>(
      ownerA,
      'SELECT app_internal.release_heavy_task_foreground_lease($1,$2) AS released',
      [ownerA, holders[0]],
    );
    expect(released.rows[0]?.released).toBe(true);
    await admin.query(
      "DELETE FROM generation_provider_slots WHERE quota_group LIKE 'heavy-task:sync-owner:user:site-%'",
    );
    expect((await acquire(ownerA, ownerA, holders[2])).rows[0]?.allowed).toBe(true);
  });

  it('rejects deleted-owner acquire/renew while leaving active owners unchanged', async () => {
    await admin.query('DELETE FROM generation_provider_slots');
    await admin.query('DELETE FROM generation_jobs');
    await admin.query("UPDATE app_accounts SET status='active'");
    await admin.query('DELETE FROM deleted_account_tombstones');

    const oldHolder = randomUUID();
    const oldLease = await asOwner<{ slot_no: number; lease_epoch: string }>(
      ownerB,
      'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
      [ownerB, oldHolder],
    );
    expect(oldLease.rows).toHaveLength(1);

    await admin.query("UPDATE app_accounts SET status='deleting' WHERE owner_id=$1", [ownerB]);
    await admin.query(
      `INSERT INTO deleted_account_tombstones(user_id,owner_id,reason)
       SELECT user_id,owner_id,'proof' FROM app_accounts WHERE owner_id=$1`,
      [ownerB],
    );
    await admin.query(
      "DELETE FROM generation_provider_slots WHERE quota_group='heavy-task:sync-owner:' || $1",
      [ownerB],
    );

    const lease = oldLease.rows[0]!;
    const heartbeat = await asOwner<{ alive: boolean }>(
      ownerB,
      'SELECT app_internal.heartbeat_heavy_task_sync_lease($1,$2,$3,$4,60000) AS alive',
      [`heavy-task:sync-owner:${ownerB}`, lease.slot_no, oldHolder, lease.lease_epoch],
    );
    expect(heartbeat.rows[0]?.alive).toBe(false);
    expect(
      (
        await asOwner(
          ownerB,
          'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
          [ownerB, randomUUID()],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await asOwner<{ allowed: boolean; reason: string | null }>(
          ownerB,
          'SELECT * FROM app_internal.acquire_foreground_generation_root($1,$2,100000,0,0,2,16,3600000)',
          [ownerB, randomUUID()],
        )
      ).rows[0],
    ).toEqual({ allowed: false, reason: 'account_inactive' });

    expect(
      (
        await asOwner(
          ownerA,
          'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,2,60000)',
          [ownerA, randomUUID()],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('deduplicates eight owners mixed Pro, material and background roots with shared foreground capacity', async () => {
    await admin.query(
      'TRUNCATE generation_jobs,generation_provider_slots,agent_sessions,agent_session_materials,agent_session_events',
    );
    await admin.query("UPDATE app_accounts SET status='active'");
    await admin.query('DELETE FROM deleted_account_tombstones');
    const owners = [ownerA, ...Array.from({ length: 7 }, (_, i) => `user:mixed-${i}`)];
    const sessions: string[] = [];
    const background: string[] = [];
    for (const owner of owners) {
      const session = randomUUID();
      const job = randomUUID();
      sessions.push(session);
      background.push(job);
      await admin.query(
        `INSERT INTO agent_sessions(id,owner_id,status,lease_worker_id,lease_heartbeat_at)
         VALUES($1,$2,'running','pro-worker',extract(epoch FROM clock_timestamp())::bigint*1000)`,
        [session, owner],
      );
      await admin.query(
        `INSERT INTO agent_session_materials(session_id,extraction_status,extraction_lease_worker_id,extraction_lease_heartbeat_at)
         VALUES($1,'running','parser',extract(epoch FROM clock_timestamp())::bigint*1000)`,
        [session],
      );
      await admin.query(
        `INSERT INTO generation_jobs(id,owner_id,status,lease_expires_at,input_snapshot) VALUES
         ($1,$2,'running',clock_timestamp()+interval '1 hour','{}'),
         ($3,$2,'running',clock_timestamp()+interval '1 hour',$4::jsonb),
         ($5,$2,'running',clock_timestamp()+interval '1 hour',$4::jsonb)`,
        [
          job,
          owner,
          randomUUID(),
          JSON.stringify({ source: { kind: 'pro', sessionId: session } }),
          randomUUID(),
        ],
      );
    }
    const capacity = (owner: string, root: string) =>
      asOwner<{
        total_count: string;
        owner_count: string;
        inherited: boolean;
      }>(
        owner,
        `SELECT total_count,owner_count,inherited FROM app_internal.heavy_task_capacity(
      'admission',$1,$2,0,0,0,0,NULL,2,16,false)`,
        [owner, root],
      );
    for (const [i, owner] of owners.entries()) {
      expect((await capacity(owner, `agent:${sessions[i]}`)).rows[0]).toEqual({
        total_count: '16',
        owner_count: '2',
        inherited: true,
      });
    }
    const holder = randomUUID();
    const acquire = () =>
      asOwner(
        ownerB,
        'SELECT * FROM app_internal.acquire_foreground_generation_root($1,$2,100000,0,0,2,16,3600000)',
        [ownerB, holder],
      );
    expect((await acquire()).rows[0]).toEqual({ allowed: false, reason: 'site_limit' });
    await admin.query(
      "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [background[0]],
    );
    expect((await acquire()).rows[0]).toEqual({ allowed: true, reason: null });
    expect((await acquire()).rows[0]).toEqual({ allowed: true, reason: null });
    expect((await capacity(ownerB, `independent:${holder}`)).rows[0]).toEqual({
      total_count: '16',
      owner_count: '1',
      inherited: true,
    });
    await asOwner(ownerB, 'SELECT app_internal.release_heavy_task_foreground_lease($1,$2)', [
      ownerB,
      holder,
    ]);
    expect((await capacity(ownerA, `agent:${sessions[0]}`)).rows[0]).toEqual({
      total_count: '15',
      owner_count: '1',
      inherited: true,
    });
  });

  it('lets another owner pass an older queue when the oldest owner already uses two roots', async () => {
    await admin.query(
      'TRUNCATE generation_jobs,generation_provider_slots,agent_sessions,agent_session_materials,agent_session_events',
    );
    for (let i = 0; i < 2; i += 1) {
      await admin.query(
        `INSERT INTO generation_jobs(id,owner_id,status,lease_expires_at)
        VALUES($1,$2,'running',clock_timestamp()+interval '1 hour')`,
        [randomUUID(), ownerA],
      );
    }
    const blocked = randomUUID();
    const eligible = randomUUID();
    await admin.query(
      `INSERT INTO generation_jobs(id,owner_id,status,created_at) VALUES
      ($1,$2,'queued',clock_timestamp()-interval '1 hour'),
      ($3,$4,'queued',clock_timestamp()-interval '1 minute')`,
      [blocked, ownerA, eligible, ownerB],
    );
    expect(
      (
        await asOwner(
          ownerB,
          `SELECT candidate_present,oldest_root FROM app_internal.heavy_task_capacity(
      'fair',$1,$2,0,0,0,0,NULL,2,16,false)`,
          [ownerB, `generation:${eligible}`],
        )
      ).rows[0],
    ).toEqual({ candidate_present: true, oldest_root: `generation:${eligible}` });
  });

  it('fences expired synchronous holders after slot reuse', async () => {
    await admin.query('DELETE FROM generation_provider_slots');
    const oldHolder = randomUUID();
    const newHolder = randomUUID();
    const acquire = (holder: string) =>
      asOwner<{ slot_no: number; lease_epoch: string }>(
        ownerA,
        'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,1,60000)',
        [ownerA, holder],
      );
    const oldLease = (await acquire(oldHolder)).rows[0]!;
    await admin.query(
      "UPDATE generation_provider_slots SET expires_at=clock_timestamp()-interval '1 second'",
    );
    const newLease = (await acquire(newHolder)).rows[0]!;
    expect(newLease.slot_no).toBe(oldLease.slot_no);
    expect(Number(newLease.lease_epoch)).toBeGreaterThan(Number(oldLease.lease_epoch));
    for (const fn of ['heartbeat_heavy_task_sync_lease', 'release_heavy_task_sync_lease']) {
      const ttl = fn.startsWith('heartbeat') ? ',60000' : '';
      expect(
        (
          await asOwner(ownerA, `SELECT app_internal.${fn}($1,$2,$3,$4${ttl}) AS valid`, [
            `heavy-task:sync-owner:${ownerA}`,
            oldLease.slot_no,
            oldHolder,
            oldLease.lease_epoch,
          ])
        ).rows[0],
      ).toEqual({ valid: false });
    }
    expect(
      (
        await asOwner(
          ownerA,
          'SELECT app_internal.heartbeat_heavy_task_sync_lease($1,$2,$3,$4,60000) AS valid',
          [`heavy-task:sync-owner:${ownerA}`, newLease.slot_no, newHolder, newLease.lease_epoch],
        )
      ).rows[0],
    ).toEqual({ valid: true });
  });

  it('allows owner-scoped provider calls without exposing leases or accepting foreign holders', async () => {
    await admin.query('DELETE FROM generation_provider_slots');
    const group = 'llm:deployment';
    const a = new PostgresGenerationLimiter(web, {}, { ownerId: ownerA });
    const b = new PostgresGenerationLimiter(web, {}, { ownerId: ownerB });
    const slot = (await a.acquire(group, 1))!;
    expect(slot).toMatchObject({ group, slot: 0, epoch: 1 });
    expect(await b.acquire(group, 1)).toBeNull();
    expect(await a.heartbeat(slot, 300000)).toBe(true);
    expect(await b.heartbeat(slot, 300000)).toBe(false);
    await b.release(slot);
    expect(await a.heartbeat(slot, 300000)).toBe(true);
    expect(
      (
        await asOwner(
          ownerB,
          'SELECT app_internal.cooldown_provider_quota($1,$2,$3,$4,10000) AS changed',
          [group, slot.slot, slot.holder, slot.epoch],
        )
      ).rows[0],
    ).toEqual({ changed: false });
    expect(await a.heartbeat({ ...slot, epoch: slot.epoch + 1 }, 300000)).toBe(false);
    await expect(web.query('SELECT * FROM generation_provider_slots')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      web.query('SELECT * FROM app_internal.acquire_provider_quota($1,1,$2,300000)', [
        group,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(a.acquire('heavy-task:attention-reservation', 1)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(a.acquire(group, 1, randomUUID(), 600001)).rejects.toMatchObject({
      code: '22023',
    });
    const grants = await admin.query(`SELECT
      has_function_privilege('anon','app_internal.acquire_provider_quota(text,integer,uuid,integer)','EXECUTE') AS anon,
      has_function_privilege('authenticated','app_internal.acquire_provider_quota(text,integer,uuid,integer)','EXECUTE') AS authenticated`);
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: false });

    // Unknown provider completion remains quarantined despite a released holder.
    await a.release(slot, true);
    expect(await b.acquire(group, 1)).toBeNull();
    await admin.query(
      "UPDATE generation_provider_slots SET quarantine_until=clock_timestamp()-interval '1 second' WHERE quota_group=$1",
      [group],
    );
    const next = (await b.acquire(group, 1))!;
    expect(next.epoch).toBeGreaterThan(slot.epoch);
    expect(await a.heartbeat(slot, 300000)).toBe(false);
    await a.release(slot);
    expect(await b.heartbeat(next, 300000)).toBe(true);
    // A confirmed 429 establishes a shared cooldown before normal release.
    await b.cooldown(group, 10000, next);
    await b.release(next);
    expect(await a.acquire(group, 1)).toBeNull();
    await admin.query(
      'UPDATE generation_provider_slots SET cooldown_until=NULL WHERE quota_group=$1',
      [group],
    );
    const recovered = (await a.acquire(group, 1))!;
    expect(recovered).not.toBeNull();
    await a.release(recovered);
    await admin.query("UPDATE app_accounts SET status='disabled' WHERE owner_id=$1", [ownerB]);
    await expect(b.acquire(group, 1)).rejects.toMatchObject({ code: '42501' });
    await admin.query("UPDATE app_accounts SET status='active' WHERE owner_id=$1", [ownerB]);
  });

  it('reserves more than twenty attention roots and does not revoke reservations on shrink', async () => {
    await admin.query(
      'TRUNCATE generation_jobs,generation_provider_slots,agent_sessions,agent_session_materials,agent_session_events',
    );
    const jobs = Array.from({ length: 25 }, () => randomUUID());
    for (const job of jobs) {
      await admin.query(
        `INSERT INTO generation_jobs(id,owner_id,status,review_policy)
        VALUES($1,$2,'queued','manual')`,
        [job, ownerA],
      );
    }
    for (const job of jobs.slice(0, 24)) {
      const result = await asOwner(
        ownerA,
        'SELECT app_internal.reserve_heavy_task_attention($1,24) AS reserved',
        [job],
      );
      expect(result.rows[0]).toEqual({ reserved: true });
    }
    expect(
      (
        await asOwner(
          ownerA,
          'SELECT app_internal.reserve_heavy_task_attention($1,24) AS reserved',
          [jobs[24]],
        )
      ).rows[0],
    ).toEqual({ reserved: false });
    expect(
      (
        await asOwner(
          ownerA,
          'SELECT app_internal.reserve_heavy_task_attention($1,16) AS reserved',
          [jobs[24]],
        )
      ).rows[0],
    ).toEqual({ reserved: false });
    expect(
      (
        await admin.query(`SELECT count(*)::int AS count FROM generation_provider_slots
      WHERE quota_group='heavy-task:attention-reservation' AND holder_attempt_id IS NOT NULL`)
      ).rows[0],
    ).toEqual({ count: 24 });
    await admin.query("UPDATE generation_jobs SET status='cancelled' WHERE id=$1", [jobs[0]]);
    expect(
      (
        await asOwner(
          ownerA,
          'SELECT app_internal.reserve_heavy_task_attention($1,16) AS reserved',
          [jobs[24]],
        )
      ).rows[0],
    ).toEqual({ reserved: true });
  });
});
