/**
 * Same Chromium profile on the independent hosted stack: A → sign-out → B.
 * Password grant via the hosted app container (host Auth DNS is flaky).
 * Does not create stages. Never prints secrets.
 *
 *   pnpm exec tsx scripts/prove-same-browser-switch.ts
 */
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';
const ORIGIN = process.env.HOSTED_TEST_ORIGIN?.trim() || 'http://localhost:3001';
const HOSTED_UI = 'openmaic-hosted-ui';

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

function dockerPasswordGrant(email: string, password: string, apiKey: string): string {
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
  if (parsed.status !== 200 || !parsed.body) {
    throw new Error(`password-grant-failed:${parsed.status}`);
  }
  const session = JSON.parse(parsed.body) as object;
  return sessionCookie(session);
}

function cookiesFromHeader(header: string) {
  return header.split('; ').map((part) => {
    const eq = part.indexOf('=');
    return {
      name: part.slice(0, eq),
      value: part.slice(eq + 1),
      url: ORIGIN,
    };
  });
}

async function meAndStages(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
    let ownerPrefix = '';
    try {
      const json = (await meRes.json()) as { ownerId?: string };
      ownerPrefix = String(json.ownerId ?? '').slice(0, 13);
    } catch {
      /* ignore */
    }
    const stagesRes = await fetch('/api/stages', { credentials: 'same-origin' });
    let count = -1;
    try {
      const json = (await stagesRes.json()) as { stages?: unknown[] };
      count = Array.isArray(json.stages) ? json.stages.length : -1;
    } catch {
      /* ignore */
    }
    return { me: meRes.status, ownerPrefix, stages: stagesRes.status, count };
  });
}

async function applySession(
  context: import('@playwright/test').BrowserContext,
  page: import('@playwright/test').Page,
  cookieHeader: string,
) {
  await context.clearCookies();
  await context.addCookies(cookiesFromHeader(cookieHeader));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
}

async function signOutUi(page: import('@playwright/test').Page) {
  await page.getByLabel(/账号菜单|Account menu/i).click({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: /退出登录|Sign out/i }).click();
  await page.waitForTimeout(1500);
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  } catch {
    /* dual-mode may reload or stay */
  }
  for (let i = 0; i < 10; i += 1) {
    const state = await meAndStages(page);
    if (state.me === 401) return;
    await page.waitForTimeout(500);
  }
  throw new Error('sign-out-did-not-clear-session');
}

async function main() {
  loadHostedOperatorEnv();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const passwordA = process.env.TEST_USER_A_PASSWORD?.trim();
  const passwordB = process.env.TEST_USER_B_PASSWORD?.trim();
  if (!apiKey || !passwordA || !passwordB) {
    console.info(JSON.stringify({ ok: false, proof: 'same-browser-switch', blocked: true }));
    process.exitCode = 1;
    return;
  }

  const cookieA = dockerPasswordGrant(EMAIL_A, passwordA, apiKey);
  const cookieB = dockerPasswordGrant(EMAIL_B, passwordB, apiKey);

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const unsignedHome = await meAndStages(page);

    await applySession(context, page, cookieA);
    await page.getByLabel(/账号菜单|Account menu/i).waitFor({ timeout: 20_000 });
    const asA = await meAndStages(page);
    await signOutUi(page);
    await context.clearCookies();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const afterA = await meAndStages(page);

    await applySession(context, page, cookieB);
    await page.getByLabel(/账号菜单|Account menu/i).waitFor({ timeout: 20_000 });
    const asB = await meAndStages(page);
    await signOutUi(page);
    await context.clearCookies();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const afterB = await meAndStages(page);

    const leftoverHash = page.url().includes('access_token');
    const ok =
      unsignedHome.me === 401 &&
      unsignedHome.stages === 401 &&
      asA.me === 200 &&
      asA.ownerPrefix === 'user:09ee0532' &&
      asA.stages === 200 &&
      asA.count === 0 &&
      afterA.me === 401 &&
      afterA.stages === 401 &&
      asB.me === 200 &&
      asB.ownerPrefix === 'user:fdef1b67' &&
      asB.stages === 200 &&
      asB.count === 0 &&
      afterB.me === 401 &&
      afterB.stages === 401 &&
      !leftoverHash;

    console.info(
      JSON.stringify({
        ok,
        proof: 'same-browser-switch',
        origin: ORIGIN,
        createdStages: false,
        leftoverHash,
        unsigned: { me: unsignedHome.me, stages: unsignedHome.stages, count: unsignedHome.count },
        asA: { me: asA.me, ownerPrefix: asA.ownerPrefix, count: asA.count },
        afterSignOutA: { me: afterA.me, count: afterA.count },
        asB: { me: asB.me, ownerPrefix: asB.ownerPrefix, count: asB.count },
        afterSignOutB: { me: afterB.me, count: afterB.count },
      }),
    );
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'same-browser-switch',
        error: message.slice(0, 240),
      }),
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
