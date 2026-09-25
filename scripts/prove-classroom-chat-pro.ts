/**
 * Dual-mode classroom stack: signed-in B cannot POST chat/agent against A's
 * stage or the unsigned library, and cannot use A's modelRef. Uses gitignored
 * passwords. Never prints secrets. Does not mint/replace anonymous owners on
 * the live library. Does not touch hosted DATABASE_URL or FORCE RLS.
 *
 *   pnpm accounts:prove-classroom-chat-pro
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const APP_ORIGIN = 'http://127.0.0.1:3000';
const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const EMAIL_A = 'lzg0724aaa@163.com';
const EMAIL_B = 'zhigngliu0724@gmail.com';
const POSTGRES = 'openmaic-main-postgres-1';

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
  return {
    status: response.status,
    cookie: sessionCookie(session),
    ownerPrefix: `user:${session.user.id.slice(0, 8)}`,
  };
}

async function appFetch(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${APP_ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: APP_ORIGIN,
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
  return { status: response.status, text, json };
}

function chatBody(stageId: string) {
  return {
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'iso' }] }],
    storeState: {
      stage: { id: stageId },
      scenes: [],
      currentSceneId: null,
      mode: 'preview',
      whiteboardOpen: false,
    },
    config: { agentIds: ['default-1'] },
  };
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
        proof: 'classroom-chat-pro',
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
        proof: 'classroom-chat-pro',
        reason: 'password-grant-failed',
        grantA: grantA.status,
        grantB: grantB.status,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const meA = await appFetch('/api/auth/me', { cookie: grantA.cookie });
  const meB = await appFetch('/api/auth/me', { cookie: grantB.cookie });
  const meUnsigned = await appFetch('/api/auth/me');
  const meAOwner =
    meA.json && typeof meA.json === 'object'
      ? String((meA.json as { ownerId?: string }).ownerId ?? '')
      : '';
  const meBOwner =
    meB.json && typeof meB.json === 'object'
      ? String((meB.json as { ownerId?: string }).ownerId ?? '')
      : '';
  if (
    meA.status !== 200 ||
    meB.status !== 200 ||
    !meAOwner.startsWith('user:09ee0532') ||
    !meBOwner.startsWith('user:fdef1b67')
  ) {
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-chat-pro',
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

  const stagesBefore = await appFetch('/api/stages');
  const unsignedCountBefore =
    stagesBefore.json &&
    typeof stagesBefore.json === 'object' &&
    Array.isArray((stagesBefore.json as { stages?: unknown }).stages)
      ? (stagesBefore.json as { stages: unknown[] }).stages.length
      : Array.isArray(stagesBefore.json)
        ? stagesBefore.json.length
        : Number(psql(`SELECT count(*) FROM stage_meta WHERE deleted_at IS NULL AND owner_id LIKE 'anon:%';`).trim());

  const sharedStageId = psql(
    `SELECT stage_id FROM stage_meta WHERE deleted_at IS NULL AND owner_id LIKE 'anon:%' ORDER BY stage_id LIMIT 1;`,
  ).trim();
  const stageTable = psql(`SELECT to_regclass('pro_model_connections')::text;`).trim();
  const snapshotTable = psql(`SELECT to_regclass('generation_model_snapshots')::text;`).trim();

  const stageId = `stage-iso-chat-${randomBytes(4).toString('hex')}`;
  const connectionId = randomUUID();
  const now = Date.now();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      psql(`
DELETE FROM agent_sessions WHERE stage_id='${stageId}' OR prompt='${stageId}';
DELETE FROM pro_model_connection_revisions WHERE connection_id='${connectionId}';
DELETE FROM pro_model_connections WHERE id='${connectionId}';
DELETE FROM stage_meta WHERE stage_id='${stageId}';
DELETE FROM document_stages WHERE id='${stageId}';
`);
    } catch {
      /* report leftover below */
    }
  };

  try {
    psql(`
INSERT INTO document_stages(id,name,created_at,updated_at,owner_id,data)
VALUES('${stageId}','iso-chat',${now},${now},'${OWNER_A}','{}'::jsonb);
INSERT INTO stage_meta(stage_id,owner_id,is_public,generation_complete)
VALUES('${stageId}','${OWNER_A}',false,false)
ON CONFLICT (stage_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, deleted_at=NULL;
`);
    if (stageTable === 'pro_model_connections') {
      psql(`
INSERT INTO pro_model_connections(id,owner_id,revision,revoked)
VALUES('${connectionId}','${OWNER_A}',1,false);
INSERT INTO pro_model_connection_revisions(connection_id,revision,ciphertext)
VALUES('${connectionId}',1,'v1.isolation-fixture');
`);
    }

    const chatA = await appFetch('/api/chat', {
      method: 'POST',
      cookie: grantB.cookie,
      body: chatBody(stageId),
    });
    const chatShared = sharedStageId
      ? await appFetch('/api/chat', {
          method: 'POST',
          cookie: grantB.cookie,
          body: chatBody(sharedStageId),
        })
      : { status: 0, text: '', json: null };
    const sessionA = await appFetch('/api/agent/sessions', {
      method: 'POST',
      cookie: grantB.cookie,
      body: { existingCourse: true, stageId },
    });
    const sessionShared = sharedStageId
      ? await appFetch('/api/agent/sessions', {
          method: 'POST',
          cookie: grantB.cookie,
          body: { existingCourse: true, stageId: sharedStageId },
        })
      : { status: 0, text: '', json: null };
    const teachGet = await fetch(`${APP_ORIGIN}/api/learning/teach-back`, { method: 'GET' }).then(
      (r) => r.status,
    );

    let modelConn = { status: 0, json: null as unknown };
    let runtime = { status: 0, json: null as unknown };
    if (stageTable === 'pro_model_connections') {
      modelConn = await appFetch('/api/agent/model-connections', {
        method: 'POST',
        cookie: grantB.cookie,
        body: {
          ref: { id: connectionId, revision: 1 },
          modelString: 'openai:gpt-4o',
          apiKey: 'isolation-proof',
        },
      });
      runtime = await appFetch('/api/agent/runtime', {
        method: 'POST',
        cookie: grantB.cookie,
        body: { modelRef: { id: connectionId, revision: 1 } },
      });
    }

    cleanup();
    const leftoverStages = Number(
      psql(`SELECT count(*) FROM document_stages WHERE id='${stageId}';`).trim() || '1',
    );
    const leftoverMeta = Number(
      psql(`SELECT count(*) FROM stage_meta WHERE stage_id='${stageId}';`).trim() || '1',
    );
    const leftoverSessions = Number(
      psql(`SELECT count(*) FROM agent_sessions WHERE stage_id='${stageId}';`).trim() || '1',
    );
    const leftoverConnections =
      stageTable === 'pro_model_connections'
        ? Number(psql(`SELECT count(*) FROM pro_model_connections WHERE id='${connectionId}';`).trim() || '1')
        : 0;
    const userStages = Number(psql(`SELECT count(*) FROM document_stages WHERE owner_id LIKE 'user:%';`).trim());
    const stagesAfter = await appFetch('/api/stages');
    const unsignedCountAfter =
      stagesAfter.json &&
      typeof stagesAfter.json === 'object' &&
      Array.isArray((stagesAfter.json as { stages?: unknown }).stages)
        ? (stagesAfter.json as { stages: unknown[] }).stages.length
        : Array.isArray(stagesAfter.json)
          ? stagesAfter.json.length
          : -1;

    const connectionError =
      modelConn.json && typeof modelConn.json === 'object'
        ? String((modelConn.json as { error?: string }).error ?? '')
        : '';
    const runtimeError =
      runtime.json && typeof runtime.json === 'object'
        ? String((runtime.json as { error?: string }).error ?? '')
        : '';
    const modelRefOk =
      stageTable !== 'pro_model_connections' ||
      ((modelConn.status === 409 || modelConn.status === 404) &&
        (runtime.status === 409 || runtime.status === 404));

    const ok =
      meUnsigned.status === 401 &&
      chatA.status === 404 &&
      chatShared.status === 404 &&
      (sessionA.status === 404 || sessionA.status === 401) &&
      (sessionShared.status === 404 || sessionShared.status === 401) &&
      teachGet === 405 &&
      leftoverStages === 0 &&
      leftoverMeta === 0 &&
      leftoverSessions === 0 &&
      leftoverConnections === 0 &&
      userStages === 0 &&
      modelRefOk &&
      unsignedCountAfter === unsignedCountBefore;

    console.info(
      JSON.stringify({
        ok,
        proof: 'classroom-chat-pro',
        authModeUnset: true,
        me: { unsigned: meUnsigned.status, a: meA.status, b: meB.status },
        chat: { bOnA: chatA.status, bOnShared: chatShared.status, sharedStagePresent: Boolean(sharedStageId) },
        agent: { bOnA: sessionA.status, bOnShared: sessionShared.status },
        modelRef: {
          table: stageTable,
          snapshots: snapshotTable,
          bConnection: modelConn.status,
          bConnectionError: connectionError || undefined,
          bRuntime: runtime.status,
          bRuntimeError: runtimeError || undefined,
        },
        learningGet: teachGet,
        unsignedLibrary: { before: unsignedCountBefore, after: unsignedCountAfter },
        leftover: {
          stages: leftoverStages,
          meta: leftoverMeta,
          sessions: leftoverSessions,
          connections: leftoverConnections,
          userStages,
        },
      }),
    );
    if (!ok) process.exitCode = 1;
  } catch (error) {
    cleanup();
    console.info(
      JSON.stringify({
        ok: false,
        proof: 'classroom-chat-pro',
        reason: 'unexpected',
        error: redact(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();
