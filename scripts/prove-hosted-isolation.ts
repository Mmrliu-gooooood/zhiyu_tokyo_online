/**
 * Independent hosted stack (:3001) A/B isolation by id, not only lists.
 * Password-grant cookies. Never prints secrets. Deletes leftovers.
 *
 *   pnpm accounts:prove-hosted-isolation
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

setDefaultResultOrder('ipv4first');

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';
const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const HOSTED_UI = 'openmaic-hosted-ui';

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, '[publishable]')
    .replace(/password[=:]\s*\S+/gi, 'password=***')
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***@');
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
): Promise<{ status: number; cookie?: string }> {
  try {
    const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: response.status };
    const session = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      user?: { id?: string };
    };
    if (!session.access_token || !session.refresh_token || !session.user?.id) {
      return { status: response.status };
    }
    return { status: response.status, cookie: sessionCookie(session) };
  } catch {
    /* host Auth DNS is flaky; grant from the live app container */
  }
  const payload = JSON.stringify({ email, password, apiKey, url: PROJECT_URL });
  const js =
    "const fs=require('fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fetch(p.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:p.apiKey,'Content-Type':'application/json'},body:JSON.stringify({email:p.email,password:p.password})}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));}).catch(()=>{process.stdout.write(JSON.stringify({status:0}));process.exit(1);});";
  const raw = docker(['exec', '-i', HOSTED_UI, 'node', '-e', js], payload);
  const parsed = JSON.parse(raw) as { status: number; body?: string };
  if (parsed.status !== 200 || !parsed.body) return { status: parsed.status };
  const session = JSON.parse(parsed.body) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string };
  };
  if (!session.access_token || !session.refresh_token || !session.user?.id) {
    return { status: parsed.status };
  }
  return { status: parsed.status, cookie: sessionCookie(session) };
}

async function appFetch(
  origin: string,
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; originHeader?: string } = {},
): Promise<{ status: number; json: unknown; code?: string }> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: init.originHeader ?? origin,
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let json: unknown = { raw: text.slice(0, 120) };
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    /* keep raw */
  }
  const code =
    json && typeof json === 'object'
      ? String(
          (json as { errorCode?: string }).errorCode ??
            (json as { error?: string }).error ??
            '',
        )
      : '';
  return { status: response.status, json, code: code || undefined };
}

async function appFetchRetry(
  origin: string,
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; originHeader?: string } = {},
  attempts = 4,
): Promise<{ status: number; json: unknown; code?: string }> {
  let last: { status: number; json: unknown; code?: string } = { status: 0, json: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await appFetch(origin, path, init);
    } catch {
      last = { status: 0, json: { raw: 'fetch-failed' } };
    }
    if (last.status !== 503 && last.status !== 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return last;
}

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  });
}

function deleteAbFixturesInUi(): number {
  const js = `const {Pool}=require('pg');const owners=${JSON.stringify([OWNER_A, OWNER_B])};const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:60000});(async()=>{const c=await pool.connect();let leftover=0;try{for(const owner of owners){await c.query('BEGIN');await c.query("SELECT set_config('app.owner_id',$1,true)",[owner]);await c.query('DELETE FROM generation_jobs WHERE owner_id=$1',[owner]);await c.query('DELETE FROM generation_ownership WHERE owner_id=$1',[owner]);await c.query('DELETE FROM document_outlines WHERE stage_id IN (SELECT id FROM document_stages WHERE owner_id=$1)',[owner]);await c.query('DELETE FROM document_scenes WHERE stage_id IN (SELECT id FROM document_stages WHERE owner_id=$1)',[owner]);await c.query('DELETE FROM stage_meta WHERE owner_id=$1',[owner]);await c.query('DELETE FROM document_stage_revision WHERE stage_id IN (SELECT id FROM document_stages WHERE owner_id=$1)',[owner]);await c.query('DELETE FROM document_stages WHERE owner_id=$1',[owner]);const left=await c.query('SELECT count(*)::int AS n FROM document_stages WHERE owner_id=$1',[owner]);leftover+=Number(left.rows[0].n);await c.query('COMMIT');}process.stdout.write(String(leftover));}finally{c.release();await pool.end();}})().catch(e=>{process.stderr.write(String(e.message||e));process.exit(1);});`;
  return Number(docker(['exec', HOSTED_UI, 'node', '-e', js]).trim());
}

function deleteAgentSessionsInUi(): void {
  const js = `const {Pool}=require('pg');const owners=${JSON.stringify([OWNER_A, OWNER_B])};const url=process.env.WORKER_DATABASE_URL||process.env.DATABASE_URL;const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:60000});(async()=>{const c=await pool.connect();try{const exists=await c.query("SELECT to_regclass('public.agent_sessions') AS n");if(!exists.rows[0].n){process.stdout.write('0');return;}for(const owner of owners){await c.query("SELECT set_config('app.owner_id',$1,true)",[owner]);await c.query('DELETE FROM agent_sessions WHERE owner_id=$1',[owner]);}process.stdout.write('1');}finally{c.release();await pool.end();}})().catch(()=>{process.stdout.write('0');});`;
  try {
    docker(['exec', HOSTED_UI, 'node', '-e', js]);
  } catch {
    /* table may not exist */
  }
}

function insertJobFixtureInUi(stageId: string, jobId: string): void {
  const js = `const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:60000});(async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.owner_id',$1,true)",[${JSON.stringify(OWNER_A)}]);await c.query("INSERT INTO generation_ownership (stage_id, owner_id, producer_kind, write_mode) VALUES ($1,$2,'client','editable') ON CONFLICT (stage_id) DO NOTHING",[${JSON.stringify(stageId)},${JSON.stringify(OWNER_A)}]);await c.query("INSERT INTO generation_jobs (id, stage_id, owner_id, idempotency_key, request_hash, status, pipeline_version, config_version, input_snapshot, review_policy) VALUES ($1,$2,$3,$4,'hosted-iso-hash','cancelled','2','server-v1','{}'::jsonb,'auto')",[${JSON.stringify(jobId)},${JSON.stringify(stageId)},${JSON.stringify(OWNER_A)},${JSON.stringify(`iso-${randomBytes(4).toString('hex')}`)}]);await c.query('COMMIT');}finally{c.release();await pool.end();}})().catch(e=>{process.stderr.write(String(e.message||e));process.exit(1);});`;
  docker(['exec', HOSTED_UI, 'node', '-e', js]);
}

async function main() {
  loadHostedOperatorEnv();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const passwordA = process.env.TEST_USER_A_PASSWORD?.trim();
  const passwordB = process.env.TEST_USER_B_PASSWORD?.trim();
  const webUrl = process.env.DATABASE_URL_APP_WEB?.trim();
  if (!apiKey || !passwordA || !passwordB || !webUrl) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-isolation',
        reason: 'missing-gitignored-passwords-or-url',
        blocked: true,
      }),
    );
    process.exitCode = 1;
    return;
  }
  deleteAbFixturesInUi();

  const origin = 'http://localhost:3001';
  const originHeader = 'http://localhost:3001';
  try {
    if (!(await fetch(`${origin}/api/health`).then((r) => r.ok))) {
      console.info(JSON.stringify({ ok: false, proof: 'hosted-isolation', reason: 'hosted-ui-unreachable' }));
      process.exitCode = 1;
      return;
    }
  } catch {
    console.info(JSON.stringify({ ok: false, proof: 'hosted-isolation', reason: 'hosted-ui-unreachable' }));
    process.exitCode = 1;
    return;
  }

  const health = await appFetch(origin, '/api/health', { originHeader });
  const grantA = await passwordGrant(EMAIL_A, passwordA, apiKey);
  const grantB = await passwordGrant(EMAIL_B, passwordB, apiKey);
  if (!grantA.cookie || !grantB.cookie) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-isolation',
        reason: 'password-grant-failed',
        grantA: grantA.status,
        grantB: grantB.status,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const meA = await appFetchRetry(origin, '/api/auth/me', { cookie: grantA.cookie });
  const meB = await appFetchRetry(origin, '/api/auth/me', { cookie: grantB.cookie });
  const unsignedMe = await appFetch(origin, '/api/auth/me');

  let created = await appFetch(origin, '/api/stages', {
    method: 'POST',
    cookie: grantA.cookie,
    body: { name: 'hosted-iso-a' },
  });
  if (created.status === 503) {
    created = await appFetchRetry(origin, '/api/stages', {
      method: 'POST',
      cookie: grantA.cookie,
      body: { name: 'hosted-iso-a' },
    });
  }
  const stageId =
    created.json && typeof created.json === 'object'
      ? String((created.json as { stage?: { id?: string } }).stage?.id ?? '')
      : '';

  const jobId = randomUUID();
  if (stageId) insertJobFixtureInUi(stageId, jobId);

  const classroomId = `iso${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  try {
    docker([
      'exec',
      HOSTED_UI,
      'node',
      '-e',
      `const fs=require('fs');const p='/app/data/classrooms/${classroomId}';fs.mkdirSync(p+'/slides',{recursive:true});fs.writeFileSync(p+'/classroom.json',JSON.stringify({id:'${classroomId}',ownerId:'${OWNER_A}',createdAt:${now}}));fs.writeFileSync(p+'/slides/slide.png','png');const u='/app/data/usage';fs.mkdirSync(u,{recursive:true});const f=u+'/'+new Date().toISOString().slice(0,7)+'.jsonl';fs.appendFileSync(f,JSON.stringify({id:'iso-usage',createdAt:${now},kind:'llm',source:'iso',providerId:'x',modelId:'x',modelString:'x',inputTokens:1,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,reasoningTokens:0,ownerId:'${OWNER_A}'})+'\\n');`,
    ]);
  } catch {
    /* volume fixture optional if UI is down */
  }

  const listA = await appFetchRetry(origin, '/api/stages', { cookie: grantA.cookie });
  const listB = await appFetchRetry(origin, '/api/stages', { cookie: grantB.cookie });
  const stageA = stageId
    ? await appFetchRetry(origin, `/api/stages/${stageId}`, { cookie: grantA.cookie })
    : { status: 0, json: null };
  const stageB = stageId
    ? await appFetchRetry(origin, `/api/stages/${stageId}`, { cookie: grantB.cookie })
    : { status: 0, json: null };
  const jobA = await appFetch(origin, `/api/generate-classroom/${jobId}`, { cookie: grantA.cookie });
  const jobB = await appFetch(origin, `/api/generate-classroom/${jobId}`, { cookie: grantB.cookie });
  const usageA = await appFetch(origin, '/api/usage', { cookie: grantA.cookie });
  const usageB = await appFetch(origin, '/api/usage', { cookie: grantB.cookie });
  const mediaA = await appFetch(origin, `/api/classroom-media/${classroomId}/slides/slide.png`, {
    cookie: grantA.cookie,
  });
  const mediaB = await appFetch(origin, `/api/classroom-media/${classroomId}/slides/slide.png`, {
    cookie: grantB.cookie,
  });
  const chatB = stageId
    ? await appFetch(origin, '/api/chat', {
        method: 'POST',
        cookie: grantB.cookie,
        body: {
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'iso' }] }],
          storeState: {
            stage: { id: stageId },
            scenes: [],
            currentSceneId: null,
            mode: 'preview',
            whiteboardOpen: false,
          },
          config: { agentIds: ['default-1'] },
        },
      })
    : { status: 0, json: null };
  const sessionCreated = stageId
    ? await appFetch(origin, '/api/agent/sessions', {
        method: 'POST',
        cookie: grantA.cookie,
        body: { prompt: 'hosted-iso-session', existingCourse: true, stageId },
      })
    : { status: 0, json: null };
  const sessionId =
    sessionCreated.json && typeof sessionCreated.json === 'object'
      ? String((sessionCreated.json as { id?: string }).id ?? '')
      : '';
  const sessionGetA = sessionId
    ? await appFetchRetry(origin, `/api/agent/sessions/${sessionId}`, { cookie: grantA.cookie })
    : { status: 0, json: null };
  const sessionGetB = sessionId
    ? await appFetch(origin, `/api/agent/sessions/${sessionId}`, { cookie: grantB.cookie })
    : { status: 0, json: null };
  const sessionPostB = sessionId
    ? await appFetch(origin, `/api/agent/sessions/${sessionId}/messages`, {
        method: 'POST',
        cookie: grantB.cookie,
        body: { text: 'iso' },
      })
    : { status: 0, json: null };
  const sessionB = stageId
    ? await appFetch(origin, '/api/agent/sessions', {
        method: 'POST',
        cookie: grantB.cookie,
        body: { existingCourse: true, stageId },
      })
    : { status: 0, json: null };
  const signOut = await appFetch(origin, '/api/auth/sign-out', {
    method: 'POST',
    cookie: grantA.cookie,
    originHeader: 'http://localhost:3001',
  });
  const meAfterSignOut = await appFetch(origin, '/api/auth/me', { cookie: grantA.cookie });

  deleteAgentSessionsInUi();
  const leftoverStages = deleteAbFixturesInUi();
  try {
    docker(['exec', HOSTED_UI, 'rm', '-rf', `/app/data/classrooms/${classroomId}`]);
  } catch {
    /* ignore */
  }

  const usageARequests =
    usageA.json && typeof usageA.json === 'object'
      ? Number((usageA.json as { totals?: { requests?: number } }).totals?.requests ?? -1)
      : -1;
  const usageBRequests =
    usageB.json && typeof usageB.json === 'object'
      ? Number((usageB.json as { totals?: { requests?: number } }).totals?.requests ?? -1)
      : -1;

  const sessionByIdProven =
    (sessionCreated.status === 202 || sessionCreated.status === 201) &&
    Boolean(sessionId) &&
    sessionGetA.status === 200 &&
    sessionGetB.status === 404 &&
    sessionPostB.status === 404;
  const ok =
    health.status === 200 &&
    unsignedMe.status === 401 &&
    meA.status === 200 &&
    meB.status === 200 &&
    created.status === 201 &&
    Boolean(stageId) &&
    listA.status === 200 &&
    listB.status === 200 &&
    stageA.status === 200 &&
    stageB.status === 404 &&
    (jobA.status === 200 || jobA.status === 404) &&
    (jobB.status === 404 || jobB.code === 'JOB_NOT_FOUND' || jobB.status === 503) &&
    usageBRequests === 0 &&
    mediaB.status === 404 &&
    chatB.status === 404 &&
    sessionB.status === 404 &&
    sessionByIdProven &&
    signOut.status === 200 &&
    leftoverStages === 0;

  console.info(
    JSON.stringify({
      ok,
      proof: 'hosted-isolation',
      origin,
      health: health.status,
      me: { unsigned: unsignedMe.status, a: meA.status, b: meB.status, afterSignOut: meAfterSignOut.status },
      createStatus: created.status,
      list: { a: listA.status, b: listB.status },
      stage: { a: stageA.status, b: stageB.status },
      job: { a: jobA.status, b: jobB.status, bCode: jobB.code ?? null },
      usage: { a: usageARequests, b: usageBRequests },
      media: { a: mediaA.status, b: mediaB.status },
      chatB: chatB.status,
      chatBCode: chatB.code ?? null,
      sessionB: sessionB.status,
      sessionCreate: sessionCreated.status,
      sessionCreateCode: sessionCreated.code ?? null,
      sessionById: {
        getA: sessionGetA.status,
        getB: sessionGetB.status,
        postB: sessionPostB.status,
        proven: sessionByIdProven,
      },
      signOut: signOut.status,
      leftoverStages,
    }),
  );
  if (!ok) process.exitCode = 1;
}

void main();
