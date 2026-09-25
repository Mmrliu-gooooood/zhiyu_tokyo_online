/**
 * Data API negative: anon and authenticated must not read hosted document_stages.
 * Never prints API keys, JWTs, or passwords.
 *
 *   pnpm accounts:prove-hosted-data-api
 */
import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_URL_FALLBACK = 'https://lzomhnjyymalupgvcato.supabase.co';
const USER_B_EMAIL = 'zhigngliu0724@gmail.com';

function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, '[publishable]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[secret]')
    .replace(/apikey['":\s]+[^"'\s]+/gi, 'apikey=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

type Probe = {
  actor: 'anon' | 'authenticated';
  httpStatus: number;
  rowCount: number | null;
  denied: boolean;
  sawFixture: boolean;
  code: string | null;
};

async function probeStages(opts: {
  base: string;
  apiKey: string;
  accessToken?: string;
  actor: Probe['actor'];
  fixtureId: string;
}): Promise<Probe> {
  const headers: Record<string, string> = {
    apikey: opts.apiKey,
    Accept: 'application/json',
  };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  const response = await fetch(`${opts.base}/rest/v1/document_stages?select=id`, {
    headers,
  });
  const text = await response.text();
  let rowCount: number | null = null;
  let code: string | null = null;
  let denied = false;
  let sawFixture = false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      rowCount = parsed.length;
      sawFixture = parsed.some(
        (row) => row && typeof row === 'object' && (row as { id?: string }).id === opts.fixtureId,
      );
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as { code?: string; message?: string; hint?: string };
      code = typeof obj.code === 'string' ? obj.code : null;
      const blob = `${obj.code ?? ''} ${obj.message ?? ''} ${obj.hint ?? ''}`;
      denied = /permission denied|42501|PGRST301|not authorized|JWT/i.test(blob);
    }
  } catch {
    denied = /permission denied|not authorized/i.test(text);
  }
  if (response.status === 401 || response.status === 403) denied = true;
  if (code === '42501' || code === 'PGRST301') denied = true;
  return {
    actor: opts.actor,
    httpStatus: response.status,
    rowCount,
    denied,
    sawFixture,
    code,
  };
}

async function main() {
  loadHostedOperatorEnv();
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? PROJECT_URL_FALLBACK).replace(/\/$/, '');
  if (!base.endsWith('lzomhnjyymalupgvcato.supabase.co')) {
    console.info(JSON.stringify({ ok: false, reason: 'refusing-non-hosted-api-url' }));
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!apiKey) {
    console.info(JSON.stringify({ ok: false, reason: 'missing-publishable-key' }));
    process.exitCode = 1;
    return;
  }
  const fixtureId = (process.env.HOSTED_DATA_API_FIXTURE_ID ?? '').trim();

  const anon = await probeStages({ base, apiKey, actor: 'anon', fixtureId });

  const password = process.env.TEST_USER_B_PASSWORD?.trim();
  let authenticated: Probe | null = null;
  let grantStatus: number | null = null;
  if (password) {
    const grantResponse = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: USER_B_EMAIL, password }),
    });
    grantStatus = grantResponse.status;
    const grantText = await grantResponse.text();
    let accessToken: string | undefined;
    try {
      const granted = JSON.parse(grantText) as { access_token?: string };
      accessToken = granted.access_token;
    } catch {
      accessToken = undefined;
    }
    if (accessToken) {
      authenticated = await probeStages({
        base,
        apiKey,
        accessToken,
        actor: 'authenticated',
        fixtureId,
      });
    }
  }

  const anonOk = anon.denied && !anon.sawFixture && (anon.rowCount === null || anon.rowCount === 0);
  const authOk =
    authenticated !== null &&
    authenticated.denied &&
    !authenticated.sawFixture &&
    (authenticated.rowCount === null || authenticated.rowCount === 0);
  const ok = anonOk && authOk;
  console.info(
    JSON.stringify({
      ok,
      proof: 'data-api-stages-negative',
      project: 'lzomhnjyymalupgvcato',
      fixtureIdSet: Boolean(fixtureId),
      anon: {
        httpStatus: anon.httpStatus,
        rowCount: anon.rowCount,
        denied: anon.denied,
        sawFixture: anon.sawFixture,
        code: anon.code,
      },
      authenticated: authenticated
        ? {
            httpStatus: authenticated.httpStatus,
            rowCount: authenticated.rowCount,
            denied: authenticated.denied,
            sawFixture: authenticated.sawFixture,
            code: authenticated.code,
            grantStatus,
          }
        : {
            skipped: true,
            grantStatus,
            reason: password ? 'grant-failed' : 'missing-TEST_USER_B_PASSWORD',
          },
    }),
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  const message = redact(error instanceof Error ? error.message : 'error');
  console.info(JSON.stringify({ ok: false, reason: 'unexpected', error: message }));
  process.exitCode = 1;
});
