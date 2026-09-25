/**
 * Dual-mode classroom stack: signed-in A vs B vs unsigned on jobs, chat
 * sessions, usage, and classroom media. Uses gitignored passwords. Never
 * prints secrets. Does not touch hosted DATABASE_URL or FORCE RLS.
 *
 *   pnpm accounts:prove-classroom-app
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const APP_ORIGIN = 'http://127.0.0.1:3000';
const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';
const POSTGRES = 'openmaic-main-postgres-1';
const APP = 'zhiyu';

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, '[publishable]')
    .replace(/password[=:]\s*\S+/gi, 'password=***')
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***@');
}

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
}

function psql(sql: string): string {
  return docker(['exec', '-i', POSTGRES, 'psql', '-U', 'openmaic', '-d', 'openmaic', '-t', '-A'], sql);
}

function sessionCookie(session: object): string {
  const json = JSON.stringify(session);
  const encoded = `base64-${Buffer.from(json, 'utf8').toString('base64url')}`;
  const name = `sb-${PROJECT_REF}-auth-token`;
  const chunk = 3180;
  if (encoded.length <= chunk) return `${name}=${encoded}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < encoded.length; i += chunk, n += 1) {
    parts.push(`${name}.${n}=${encoded.slice(i, i + chunk)}`);
  }
  return parts.join('; ');
}

async function passwordGrant(
  email: string,
  password: string,
  apiKey: string,
): Promise<{ status: number; cookie?: string; ownerPrefix?: string }> {
  const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status };
  let session: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user?: { id?: string };
  };
  try {
    session = JSON.parse(text) as typeof session;
  } catch {
    return { status: response.status };
  }
  if (!session.access_token || !session.refresh_token || !session.user?.id) {
    return { status: response.status };
  }
  const ownerPrefix = `user:${session.user.id.slice(0, 8)}`;
  return { status: response.status, cookie: sessionCookie(session), ownerPrefix };
}

async function appFetch(
  path: string,
  cookie?: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${APP_ORIGIN}${path}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      origin: APP_ORIGIN,
    },
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = { raw: text.slice(0, 80) };
  }
  return { status: response.status, json };
}

function jsonHasJob(body: unknown, jobId: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const jobs = (body as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return false;
  return jobs.some(
    (job) =>
      job &&
      typeof job === 'object' &&
      ((job as { jobId?: string }).jobId === jobId || (job as { id?: string }).id === jobId),
  );
}

function jsonHasSession(body: unknown, sessionId: string): boolean {
  if (!Array.isArray(body)) return false;
  return body.some(
    (row) => row && typeof row === 'object' && (row as { id?: string }).id === sessionId,
  );
}

function usageRequests(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const totals = (body as { totals?: { requests?: unknown } }).totals;
  return typeof totals?.requests === 'number' ? totals.requests : null;
}

function classroomJson(id: string, ownerId: string): string {
  return JSON.stringify({
    id,
    ownerId,
    stage: { id, name: 'iso-media' },
    scenes: [],
    createdAt: '2026-09-20T00:00:00.000Z',
  });
}

async function main() {
  loadHostedOperatorEnv();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const passwordA = process.env.TEST_USER_A_PASSWORD?.trim();
  const passwordB = process.env.TEST_USER_B_PASSWORD?.trim();
  if (!apiKey || !passwordA || !passwordB) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-app-isolation',
        reason: 'missing-gitignored-passwords-or-key',
        blocked: true,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const grantA = await passwordGrant(EMAIL_A, passwordA, apiKey);
  const grantB = await passwordGrant(EMAIL_B, passwordB, apiKey);
  if (!grantA.cookie || !grantB.cookie) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-app-isolation',
        reason: 'password-grant-failed',
        grantA: grantA.status,
        grantB: grantB.status,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const meA = await appFetch('/api/auth/me', grantA.cookie);
  const meB = await appFetch('/api/auth/me', grantB.cookie);
  const meUnsigned = await appFetch('/api/auth/me');
  const usageBeforeUnsigned = await appFetch('/api/usage');
  const meAOwner =
    meA.json && typeof meA.json === 'object'
      ? String((meA.json as { ownerId?: string }).ownerId ?? '')
      : '';
  const meBOwner =
    meB.json && typeof meB.json === 'object'
      ? String((meB.json as { ownerId?: string }).ownerId ?? '')
      : '';
  if (meA.status !== 200 || meB.status !== 200 || !meAOwner.startsWith('user:09ee0532') || !meBOwner.startsWith('user:fdef1b67')) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-app-isolation',
        reason: 'session-cookie-not-accepted',
        meA: meA.status,
        meB: meB.status,
        unsignedMe: meUnsigned.status,
        aPrefix: meAOwner.slice(0, 13),
        bPrefix: meBOwner.slice(0, 13),
      }),
    );
    process.exitCode = 1;
    return;
  }

  const jobId = randomUUID();
  const sessionId = `iso-chat-${randomBytes(4).toString('hex')}`;
  const stageId = `stage-iso-job-${randomBytes(4).toString('hex')}`;
  const classroomId = `iso-media-${randomBytes(4).toString('hex')}`;
  const usageId = `iso-usage-${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  const month = new Date().toISOString().slice(0, 7);
  const usageLine = JSON.stringify({
    id: usageId,
    createdAt: now,
    kind: 'llm',
    source: 'isolation-proof',
    providerId: 'none',
    modelId: 'none',
    modelString: 'none:none',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    ownerId: OWNER_A,
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      psql(
        `DELETE FROM generation_jobs WHERE id='${jobId}'; DELETE FROM agent_sessions WHERE id='${sessionId}'; DELETE FROM document_stages WHERE id='${stageId}';`,
      );
    } catch {
      /* still try files */
    }
    try {
      docker([
        'exec',
        '-u',
        '0',
        APP,
        'node',
        '-e',
        `const fs=require('fs');const p='/app/data/usage/${month}.jsonl';if(fs.existsSync(p)){const keep=fs.readFileSync(p,'utf8').split(/\\n/).filter(l=>l&&!l.includes(${JSON.stringify(usageId)}));fs.writeFileSync(p,keep.join('\\n')+(keep.length?'\\n':''));} const c=${JSON.stringify('/app/data/classrooms/' + classroomId)}; try{fs.rmSync(c,{recursive:true,force:true});}catch{} try{fs.unlinkSync(c+'.json');}catch{}`,
      ]);
    } catch {
      /* report leftover below */
    }
  };

  try {
    psql(`
INSERT INTO document_stages(id,name,created_at,updated_at,owner_id,data)
VALUES('${stageId}','iso-job',${now},${now},'${OWNER_A}','{}'::jsonb);
INSERT INTO generation_jobs(
  id,stage_id,owner_id,idempotency_key,request_hash,status,phase,run_no,state_version,
  pipeline_version,input_schema_version,config_version,priority,input_snapshot,plan_revision,
  review_policy,review_hold,total_scenes,ready_scenes,warning_count,active_elapsed_ms,lease_epoch
) VALUES (
  '${jobId}','${stageId}','${OWNER_A}','iso-${jobId}','iso-hash','cancelled','finalizing',1,1,
  'iso',1,'iso',0,'{}'::jsonb,0,'manual',false,0,0,0,0,0
);
INSERT INTO agent_sessions(id,owner_id,prompt,stage_id,status)
VALUES('${sessionId}','${OWNER_A}','iso-chat','${stageId}','succeeded');
`);
    docker([
      'exec',
      '-u',
      '0',
      APP,
      'node',
      '-e',
      `const fs=require('fs');const path=require('path');
const usageDir='/app/data/usage'; fs.mkdirSync(usageDir,{recursive:true});
fs.appendFileSync(path.join(usageDir,${JSON.stringify(month + '.jsonl')}), ${JSON.stringify(usageLine + '\n')});
const classDir=${JSON.stringify('/app/data/classrooms/' + classroomId + '/media')};
fs.mkdirSync(classDir,{recursive:true});
fs.writeFileSync(path.join(classDir,'slide.png'), Buffer.from([137,80,78,71]));
fs.writeFileSync(${JSON.stringify('/app/data/classrooms/' + classroomId + '.json')}, ${JSON.stringify(classroomJson(classroomId, OWNER_A))});
const chownr=(p)=>{fs.chownSync(p,1001,65533); if(fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) chownr(path.join(p,n));};
chownr('/app/data/classrooms');
`,
    ]);

    const [jobsA, jobsB, jobsU, jobGetB, chatsA, chatsB, chatsU, usageA, usageB, usageU, classA, classB, classU, mediaA, mediaB, mediaU, learnGet] =
      await Promise.all([
        appFetch('/api/generate-classroom', grantA.cookie),
        appFetch('/api/generate-classroom', grantB.cookie),
        appFetch('/api/generate-classroom'),
        appFetch(`/api/generate-classroom/${jobId}`, grantB.cookie),
        appFetch('/api/agent/sessions', grantA.cookie),
        appFetch('/api/agent/sessions', grantB.cookie),
        appFetch('/api/agent/sessions'),
        appFetch('/api/usage', grantA.cookie),
        appFetch('/api/usage', grantB.cookie),
        appFetch('/api/usage'),
        appFetch(`/api/classroom?id=${classroomId}`, grantA.cookie),
        appFetch(`/api/classroom?id=${classroomId}`, grantB.cookie),
        appFetch(`/api/classroom?id=${classroomId}`),
        appFetch(`/api/classroom-media/${classroomId}/media/slide.png`, grantA.cookie),
        appFetch(`/api/classroom-media/${classroomId}/media/slide.png`, grantB.cookie),
        appFetch(`/api/classroom-media/${classroomId}/media/slide.png`),
        fetch(`${APP_ORIGIN}/api/learning/teach-back`, { method: 'GET' }).then((r) => r.status),
      ]);

    const aJobsHas = jsonHasJob(jobsA.json, jobId);
    const bJobsHas = jsonHasJob(jobsB.json, jobId);
    const uJobsHas = jsonHasJob(jobsU.json, jobId);
    const aChatsHas = jsonHasSession(chatsA.json, sessionId);
    const bChatsHas = jsonHasSession(chatsB.json, sessionId);
    const uChatsHas = jsonHasSession(chatsU.json, sessionId);
    const aUsage = usageRequests(usageA.json);
    const bUsage = usageRequests(usageB.json);
    const uUsage = usageRequests(usageU.json);

    cleanup();
    const leftoverJobs = Number(psql(`SELECT count(*) FROM generation_jobs WHERE id='${jobId}';`).trim() || '1');
    const leftoverSessions = Number(
      psql(`SELECT count(*) FROM agent_sessions WHERE id='${sessionId}';`).trim() || '1',
    );
    const leftoverStages = Number(
      psql(`SELECT count(*) FROM document_stages WHERE id='${stageId}';`).trim() || '1',
    );

    const ok =
      meUnsigned.status === 401 &&
      aJobsHas &&
      !bJobsHas &&
      !uJobsHas &&
      (jobGetB.status === 404 || jobGetB.status === 401) &&
      aChatsHas &&
      !bChatsHas &&
      !uChatsHas &&
      aUsage === 1 &&
      bUsage === 0 &&
      uUsage === usageRequests(usageBeforeUnsigned.json) &&
      classA.status === 200 &&
      classB.status === 404 &&
      classU.status === 404 &&
      mediaA.status === 200 &&
      mediaB.status === 404 &&
      mediaU.status === 404 &&
      leftoverJobs === 0 &&
      leftoverSessions === 0 &&
      leftoverStages === 0;

    console.info(
      JSON.stringify({
        ok,
        proof: 'classroom-app-isolation',
        authModeUnset: true,
        me: { unsigned: meUnsigned.status, a: meA.status, b: meB.status },
        jobs: {
          aHas: aJobsHas,
          bHas: bJobsHas,
          unsignedHas: uJobsHas,
          bGet: jobGetB.status,
          aList: jobsA.status,
          bList: jobsB.status,
        },
        chats: {
          aHas: aChatsHas,
          bHas: bChatsHas,
          unsignedHas: uChatsHas,
          aList: chatsA.status,
          bList: chatsB.status,
        },
        usage: {
          a: aUsage,
          b: bUsage,
          unsigned: uUsage,
          unsignedBefore: usageRequests(usageBeforeUnsigned.json),
          aStatus: usageA.status,
          bStatus: usageB.status,
        },
        classroom: { a: classA.status, b: classB.status, unsigned: classU.status },
        media: { a: mediaA.status, b: mediaB.status, unsigned: mediaU.status },
        learningGet: learnGet,
        leftover: { jobs: leftoverJobs, sessions: leftoverSessions, stages: leftoverStages },
      }),
    );
    if (!ok) process.exitCode = 1;
  } catch (error) {
    cleanup();
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-app-isolation',
        reason: 'unexpected',
        error: redact(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();
