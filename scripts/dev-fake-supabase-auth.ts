/**
 * Development-only stand-in for the Supabase endpoints a hosted-mode Zhiyu
 * talks to, so signed-in browser acceptance (two accounts, isolation, several
 * devices) can run against a disposable local Postgres instead of the real
 * project. Never point a deployed app at it.
 *
 *   FAKE_SUPABASE_USERS_FILE=.scratch/<run>/users.json \
 *   FAKE_SUPABASE_DB_URL=postgres://admin@127.0.0.1:<port>/<db> \
 *   node_modules/.bin/tsx scripts/dev-fake-supabase-auth.ts      # FAKE_SUPABASE_PORT=54321
 *
 * Users come from a gitignored JSON file: [{ "id": uuid, "email", "password" }].
 * Covered: password sign-in, refresh, getUser (HS256 access tokens carry no
 * `kid`, so supabase-js verifies them through GET /auth/v1/user), sign-out,
 * and the `app_accounts` self-select the app makes through the Data API.
 * Each sign-in inserts its session into the database's `auth.sessions`
 * (app_internal.session_is_active checks it); sign-out deletes it.
 *
 * Binds 127.0.0.1 only and refuses database URLs that are not local.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Pool } from 'pg';

interface FakeUser {
  id: string;
  email: string;
  password: string;
}

const port = Number(process.env.FAKE_SUPABASE_PORT ?? 54321);
const usersFile = process.env.FAKE_SUPABASE_USERS_FILE;
const databaseUrl = process.env.FAKE_SUPABASE_DB_URL;
if (!usersFile || !databaseUrl) {
  throw new Error('FAKE_SUPABASE_USERS_FILE and FAKE_SUPABASE_DB_URL are required');
}
const dbHost = new URL(databaseUrl).hostname;
if (dbHost !== '127.0.0.1' && dbHost !== 'localhost') {
  throw new Error('FAKE_SUPABASE_DB_URL must be a local database');
}

const users: FakeUser[] = JSON.parse(readFileSync(usersFile, 'utf8'));
const secret = randomBytes(32);
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
/** refresh token → { userId, sessionId } */
const refreshTokens = new Map<string, { userId: string; sessionId: string }>();
const ACCESS_TTL_S = 3600;

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

function sign(user: FakeUser, sessionId: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      session_id: sessionId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: now + ACCESS_TTL_S,
    }),
  );
  const signature = b64(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return { token: `${header}.${payload}.${signature}`, expiresAt: now + ACCESS_TTL_S };
}

function verify(token: string): { sub: string; session_id: string } | null {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function userJson(user: FakeUser) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
}

async function session(user: FakeUser, sessionId: string) {
  const { token, expiresAt } = sign(user, sessionId);
  const refreshToken = randomBytes(24).toString('base64url');
  refreshTokens.set(refreshToken, { userId: user.id, sessionId });
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: ACCESS_TTL_S,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user: userJson(user),
  };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown) {
  const origin = req.headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers':
            'authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept, accept-profile, content-profile, prefer',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        }
      : {}),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'OPTIONS') return send(req, res, 204);

    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      const body = await readJson(req);
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = users.find(
          (candidate) => candidate.email === body.email && candidate.password === body.password,
        );
        if (!user) {
          return send(req, res, 400, {
            error: 'invalid_grant',
            error_description: 'Invalid login credentials',
            code: 'invalid_credentials',
          });
        }
        const sessionId = randomUUID();
        await pool.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [
          sessionId,
          user.id,
        ]);
        console.info(`[fake-supabase] sign-in ${user.email}`);
        return send(req, res, 200, await session(user, sessionId));
      }
      if (grant === 'refresh_token') {
        const entry = refreshTokens.get(String(body.refresh_token ?? ''));
        const user = entry && users.find((candidate) => candidate.id === entry.userId);
        if (!entry || !user) {
          return send(req, res, 400, { error: 'invalid_grant', code: 'refresh_token_not_found' });
        }
        refreshTokens.delete(String(body.refresh_token));
        return send(req, res, 200, await session(user, entry.sessionId));
      }
      return send(req, res, 400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const claims = bearer(req) && verify(bearer(req)!);
      const user = claims && users.find((candidate) => candidate.id === claims.sub);
      if (!user) return send(req, res, 401, { code: 'bad_jwt', message: 'invalid JWT' });
      return send(req, res, 200, userJson(user));
    }

    if (url.pathname === '/auth/v1/logout' && req.method === 'POST') {
      const claims = bearer(req) && verify(bearer(req)!);
      if (claims) await pool.query('DELETE FROM auth.sessions WHERE id = $1', [claims.session_id]);
      return send(req, res, 204);
    }

    if (url.pathname === '/rest/v1/app_accounts' && req.method === 'GET') {
      const claims = bearer(req) && verify(bearer(req)!);
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      if (!claims || claims.sub !== userId) return send(req, res, 200, []);
      const result = await pool.query('SELECT role, status FROM app_accounts WHERE user_id = $1', [
        userId,
      ]);
      const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
      return send(req, res, 200, single ? (result.rows[0] ?? null) : result.rows);
    }

    if (url.pathname === '/auth/v1/settings') {
      return send(req, res, 200, { external: { email: true }, disable_signup: true });
    }

    console.info(`[fake-supabase] unhandled ${req.method} ${url.pathname}`);
    return send(req, res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[fake-supabase] request failed', error instanceof Error ? error.message : error);
    return send(req, res, 500, { error: 'fake_supabase_failed' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.info(`[fake-supabase] listening on http://127.0.0.1:${port} (${users.length} users)`);
});
