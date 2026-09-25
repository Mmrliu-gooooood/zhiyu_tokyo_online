/**
 * Live :3000 logout + sequential A→B session switch. No stages created.
 * Password-grant cookies only. Never prints secrets.
 *
 *   pnpm exec tsx scripts/prove-live-logout-switch.ts
 */
import { execFileSync } from 'node:child_process';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_REF = 'lvbtgwlsebzbtcvjwktq';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';

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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(20_000),
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
      return {
        status: response.status,
        cookie: sessionCookie(session),
        ownerPrefix: `user:${session.user.id.slice(0, 8)}`,
      };
    } catch {
      /* host DNS to Auth is flaky; grant from the live app container next */
    }
  }
  const payload = JSON.stringify({ email, password, apiKey, url: PROJECT_URL });
  const js =
    "const fs=require('fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fetch(p.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:p.apiKey,'Content-Type':'application/json'},body:JSON.stringify({email:p.email,password:p.password})}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));}).catch(e=>{process.stdout.write(JSON.stringify({status:0}));process.stderr.write(String(e));process.exit(1);});";
  const raw = execFileSync('docker', ['exec', '-i', 'zhiyu', 'node', '-e', js], {
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
}

async function appFetch(
  origin: string,
  path: string,
  init: { method?: string; cookie?: string; originHeader?: string } = {},
): Promise<{ status: number; ownerPrefix?: string }> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: init.originHeader ?? origin,
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });
  const text = await response.text();
  let ownerPrefix: string | undefined;
  try {
    const json = JSON.parse(text) as { ownerId?: string };
    if (json.ownerId) ownerPrefix = String(json.ownerId).slice(0, 13);
  } catch {
    /* ignore */
  }
  return { status: response.status, ownerPrefix };
}

async function main() {
  loadHostedOperatorEnv();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const passwordA = process.env.TEST_USER_A_PASSWORD?.trim();
  const passwordB = process.env.TEST_USER_B_PASSWORD?.trim();
  if (!apiKey || !passwordA || !passwordB) {
    console.info(JSON.stringify({ ok: false, proof: 'live-logout-switch', blocked: true }));
    process.exitCode = 1;
    return;
  }
  const origin = 'http://127.0.0.1:3000';
  const originHeader = 'http://localhost:3000';
  const unsignedMe = await appFetch(origin, '/api/auth/me');
  const unsignedStages = await appFetch(origin, '/api/stages');
  const grantA = await passwordGrant(EMAIL_A, passwordA, apiKey);
  const grantB = await passwordGrant(EMAIL_B, passwordB, apiKey);
  if (!grantA.cookie || !grantB.cookie) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'live-logout-switch',
        reason: 'password-grant-failed',
        grantA: grantA.status,
        grantB: grantB.status,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const meA = await appFetch(origin, '/api/auth/me', { cookie: grantA.cookie });
  const signOutA = await appFetch(origin, '/api/auth/sign-out', {
    method: 'POST',
    cookie: grantA.cookie,
    originHeader,
  });
  const meAfterSignOut = await appFetch(origin, '/api/auth/me', {
    cookie: grantA.cookie,
  });
  const meCleared = await appFetch(origin, '/api/auth/me');
  const meB = await appFetch(origin, '/api/auth/me', { cookie: grantB.cookie });
  const signOutB = await appFetch(origin, '/api/auth/sign-out', {
    method: 'POST',
    cookie: grantB.cookie,
    originHeader,
  });
  const meAfterB = await appFetch(origin, '/api/auth/me', { cookie: grantB.cookie });
  const unsignedAfter = await appFetch(origin, '/api/stages');
  const ok =
    unsignedMe.status === 401 &&
    unsignedStages.status === 200 &&
    meA.status === 200 &&
    meA.ownerPrefix === 'user:09ee0532' &&
    signOutA.status === 200 &&
    meCleared.status === 401 &&
    meB.status === 200 &&
    meB.ownerPrefix === 'user:fdef1b67' &&
    signOutB.status === 200 &&
    unsignedAfter.status === 200;
  console.info(
    JSON.stringify({
      ok,
      proof: 'live-logout-switch',
      origin,
      createdStages: false,
      unsignedMe: unsignedMe.status,
      unsignedStages: unsignedStages.status,
      unsignedAfter: unsignedAfter.status,
      meA: { status: meA.status, ownerPrefix: meA.ownerPrefix },
      signOutA: signOutA.status,
      afterSignOutACookieStillSent: meAfterSignOut.status,
      afterSignOutUnsigned: meCleared.status,
      meB: { status: meB.status, ownerPrefix: meB.ownerPrefix },
      signOutB: signOutB.status,
      afterSignOutBCookieStillSent: meAfterB.status,
    }),
  );
  if (!ok) process.exitCode = 1;
}

void main();
