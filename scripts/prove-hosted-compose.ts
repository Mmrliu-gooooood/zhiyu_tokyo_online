/**
 * Optional openmaic-hosted UI on :3001. Password grant + cookie only.
 * Never prints secrets. Does not touch live openmaic-main.
 *
 *   pnpm accounts:prove-hosted-compose
 */
import { loadHostedOperatorEnv } from './lib/hosted-operator-env';
import { execFileSync } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';
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
): Promise<{ status: number; cookie?: string; ownerPrefix?: string }> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = response.status;
      const text = await response.text();
      if (!response.ok) {
        if (attempt < 2 && response.status >= 500) continue;
        return { status: response.status };
      }
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
      return {
        status: response.status,
        cookie: sessionCookie(session),
        ownerPrefix: `user:${session.user.id.slice(0, 8)}`,
      };
    } catch {
      lastStatus = 0;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  try {
    const payload = JSON.stringify({ email, password, apiKey, url: PROJECT_URL });
    const js =
      "const fs=require('fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fetch(p.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:p.apiKey,'Content-Type':'application/json'},body:JSON.stringify({email:p.email,password:p.password})}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));}).catch(()=>{process.stdout.write(JSON.stringify({status:0}));process.exit(1);});";
    const raw = execFileSync('docker', ['exec', '-i', HOSTED_UI, 'node', '-e', js], {
      encoding: 'utf8',
      input: payload,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
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
    return {
      status: parsed.status,
      cookie: sessionCookie(session),
      ownerPrefix: `user:${session.user.id.slice(0, 8)}`,
    };
  } catch {
    return { status: lastStatus };
  }
}

function stageCount(json: unknown): number | null {
  if (json && typeof json === 'object' && Array.isArray((json as { stages?: unknown }).stages)) {
    return (json as { stages: unknown[] }).stages.length;
  }
  if (Array.isArray(json)) return json.length;
  return null;
}

function stageRows(json: unknown): { id: string; name: string }[] {
  if (!json || typeof json !== 'object') return [];
  const stages = (json as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return [];
  return stages
    .map((row) => {
      if (!row || typeof row !== 'object') return { id: '', name: '' };
      return {
        id: String((row as { id?: string }).id ?? ''),
        name: String((row as { name?: string }).name ?? ''),
      };
    })
    .filter((row) => row.id);
}

async function deleteOwnFixtures(
  origin: string,
  cookie: string,
): Promise<void> {
  const listed = await appFetch(origin, '/api/stages', { cookie });
  for (const row of stageRows(listed.json)) {
    await appFetch(origin, `/api/stages/${row.id}`, { method: 'DELETE', cookie });
  }
}

function ownerPrefixOf(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  return String((json as { ownerId?: string }).ownerId ?? '');
}

async function probeOrigin(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { headers: { origin } });
    return response.ok;
  } catch {
    return false;
  }
}

async function appFetch(
  origin: string,
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin,
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
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

async function main() {
  loadHostedOperatorEnv();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const passwordA = process.env.TEST_USER_A_PASSWORD?.trim();
  const passwordB = process.env.TEST_USER_B_PASSWORD?.trim();
  if (!apiKey || !passwordA || !passwordB) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-compose-ui',
        reason: 'missing-gitignored-passwords-or-key',
        blocked: true,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const preferred = 'http://localhost:3001';
  const fallback = 'http://localhost:3001';
  const origin = (await probeOrigin(preferred)) ? preferred : fallback;
  if (!(await probeOrigin(origin))) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-compose-ui',
        reason: 'hosted-ui-unreachable',
        origin,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const health = await appFetch(origin, '/api/health');
  const meUnsigned = await appFetch(origin, '/api/auth/me');
  const stagesUnsigned = await appFetch(origin, '/api/stages');
  const unsignedCount = stageCount(stagesUnsigned.json);

  const grantA = await passwordGrant(EMAIL_A, passwordA, apiKey);
  const grantB = await passwordGrant(EMAIL_B, passwordB, apiKey);
  if (!grantA.cookie || !grantB.cookie) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-compose-ui',
        origin,
        reason: 'password-grant-failed',
        grantA: grantA.status,
        grantB: grantB.status,
        health: health.status,
        unsignedMe: meUnsigned.status,
        unsignedStages: stagesUnsigned.status,
        unsignedCount,
      }),
    );
    process.exitCode = 1;
    return;
  }

  let meA = await appFetch(origin, '/api/auth/me', { cookie: grantA.cookie });
  if (meA.status !== 200) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    meA = await appFetch(origin, '/api/auth/me', { cookie: grantA.cookie });
  }
  let meB = await appFetch(origin, '/api/auth/me', { cookie: grantB.cookie });
  if (meB.status !== 200) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    meB = await appFetch(origin, '/api/auth/me', { cookie: grantB.cookie });
  }
  await deleteOwnFixtures(origin, grantA.cookie);
  await deleteOwnFixtures(origin, grantB.cookie);
  const stagesABefore = await appFetch(origin, '/api/stages', { cookie: grantA.cookie });
  const stagesBBefore = await appFetch(origin, '/api/stages', { cookie: grantB.cookie });

  let createdId: string | undefined;
  let createStatus = 0;
  let stagesAAfterCreate = stagesABefore;
  let stagesBAfterCreate = stagesBBefore;
  let aSeesB = false;
  let bHasOwn = false;
  let deleteStatus = 0;
  try {
    const created = await appFetch(origin, '/api/stages', {
      method: 'POST',
      cookie: grantB.cookie,
      body: { name: 'hosted-iso-b' },
    });
    createStatus = created.status;
    createdId =
      created.json && typeof created.json === 'object'
        ? String(
            (created.json as { stage?: { id?: string } }).stage?.id ??
              (created.json as { id?: string }).id ??
              '',
          ) || undefined
        : undefined;
    stagesAAfterCreate = await appFetch(origin, '/api/stages', { cookie: grantA.cookie });
    stagesBAfterCreate = await appFetch(origin, '/api/stages', { cookie: grantB.cookie });
    aSeesB = createdId ? stageRows(stagesAAfterCreate.json).some((row) => row.id === createdId) : false;
    bHasOwn = createdId ? stageRows(stagesBAfterCreate.json).some((row) => row.id === createdId) : false;
    if (createdId) {
      deleteStatus = (
        await appFetch(origin, `/api/stages/${createdId}`, {
          method: 'DELETE',
          cookie: grantB.cookie,
        })
      ).status;
    }
  } catch (error) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'hosted-compose-ui',
        origin,
        reason: 'unexpected',
        error: redact(error),
      }),
    );
    process.exitCode = 1;
    return;
  }

  const stagesBAfterDelete = createdId
    ? await appFetch(origin, '/api/stages', { cookie: grantB.cookie })
    : stagesBAfterCreate;
  const leftoverOwn = createdId
    ? stageRows(stagesBAfterDelete.json).some((row) => row.id === createdId)
    : false;

  const unsignedFailClosed =
    meUnsigned.status === 401 &&
    stagesUnsigned.status === 401 &&
    unsignedCount !== 51;
  const bLoginOk =
    meB.status === 200 && ownerPrefixOf(meB.json).startsWith('user:fdef1b67');
  const aLoginOk =
    meA.status === 200 && ownerPrefixOf(meA.json).startsWith('user:09ee0532');
  const bStagesEmpty = stageCount(stagesBBefore.json) === 0;
  const ok =
    health.status === 200 &&
    unsignedFailClosed &&
    bLoginOk &&
    aLoginOk &&
    bStagesEmpty &&
    createStatus === 201 &&
    Boolean(createdId) &&
    bHasOwn &&
    !aSeesB &&
    (deleteStatus === 200 || deleteStatus === 204) &&
    !leftoverOwn;

  console.info(
    JSON.stringify({
      ok,
      proof: 'hosted-compose-ui',
      origin,
      authMode: 'supabase',
      health: health.status,
      me: { unsigned: meUnsigned.status, a: meA.status, b: meB.status },
      stages: {
        unsigned: stagesUnsigned.status,
        unsignedCount,
        aBefore: stageCount(stagesABefore.json),
        bBefore: stageCount(stagesBBefore.json),
        aAfterCreate: stageCount(stagesAAfterCreate.json),
        bAfterCreate: stageCount(stagesBAfterCreate.json),
        aSeesB,
        bHasOwn,
        createStatus,
      aStatus: stagesABefore.status,
      bStatus: stagesBBefore.status,
        deleteStatus,
        leftoverOwn,
      },
    }),
  );
  if (!ok) process.exitCode = 1;
}

void main();
