/**
 * Apply gitignored LOGIN-role passwords to hosted Postgres.
 * Reads/writes `.env.hosted.local` only. Prints success/fail, never secrets.
 *
 *   pnpm accounts:apply-hosted-logins
 *
 * Does not call MCP. Needs a privileged URL in the gitignored env
 * (`HOSTED_DB_ADMIN_URL` or `GENERATION_MIGRATION_DATABASE_URL`) because
 * ALTER ROLE with a password must not go through tool transcripts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HOSTED_PROJECT_REF,
  HOSTED_SESSION_POOLER_HOST,
  HOSTED_WEB_ROLE,
  HOSTED_WORKER_ROLE,
  hostedAppWebDatabaseUrl,
  hostedPgPool,
  hostedRoleFromUsername,
  hostedWorkerDatabaseUrl,
  isHostedDbHost,
  loadHostedOperatorEnv,
  withHostedSsl,
} from './lib/hosted-operator-env';

const WEB_ROLE = HOSTED_WEB_ROLE;
const WORKER_ROLE = HOSTED_WORKER_ROLE;
const ROOT = resolve(__dirname, '..');
const LOCAL = resolve(ROOT, '.env.hosted.local');

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : 'error';
  return message
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .replace(/postgres:\/\/[^@\s]+@/gi, 'postgres://***@')
    .replace(/password[=:]\s*\S+/gi, 'password=***');
}

function parseRolePassword(url: string | undefined, expectedRole: string): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url);
    if (!isHostedDbHost(parsed.hostname)) return undefined;
    if (hostedRoleFromUsername(parsed.username) !== expectedRole) return undefined;
    const password = decodeURIComponent(parsed.password);
    return password || undefined;
  } catch {
    return undefined;
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error('invalid role name');
  }
  return name;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function adminUrl(): string | undefined {
  const direct =
    process.env.HOSTED_DB_ADMIN_URL?.trim() ||
    process.env.GENERATION_MIGRATION_DATABASE_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim();
  return direct || undefined;
}

function upsertEnv(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, line);
  return `${contents.trimEnd()}\n${line}\n`;
}

function poolerLoginUrl(role: string, password: string): string {
  return withHostedSsl(
    `postgresql://${role}.${HOSTED_PROJECT_REF}:${encodeURIComponent(password)}@${HOSTED_SESSION_POOLER_HOST}:5432/postgres`,
  );
}

function rewriteLoginUrls(webPassword: string, workerPassword: string): void {
  if (!existsSync(LOCAL)) return;
  let env = readFileSync(LOCAL, 'utf8');
  const webUrl = poolerLoginUrl(WEB_ROLE, webPassword);
  const workerUrl = poolerLoginUrl(WORKER_ROLE, workerPassword);
  env = upsertEnv(env, 'DATABASE_URL_APP_WEB', webUrl);
  env = upsertEnv(env, 'DATABASE_LISTEN_URL_APP_WEB', webUrl);
  env = upsertEnv(env, 'WORKER_DATABASE_URL', workerUrl);
  env = upsertEnv(env, 'DATABASE_LISTEN_URL', workerUrl);
  writeFileSync(LOCAL, env, { encoding: 'utf8', mode: 0o600 });
}

async function canConnect(connectionString: string, expectedUser: string): Promise<boolean> {
  const pool = hostedPgPool(connectionString);
  try {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    return result.rows[0]?.current_user === expectedUser;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  loadHostedOperatorEnv();
  const webUrl = hostedAppWebDatabaseUrl();
  const workerUrl = hostedWorkerDatabaseUrl();
  const webPassword = parseRolePassword(webUrl, WEB_ROLE);
  const workerPassword = parseRolePassword(workerUrl, WORKER_ROLE);
  const privileged = adminUrl();

  if (!webPassword || !workerPassword) {
    console.info(
      JSON.stringify({
        ok: false,
        reason: 'missing-login-urls',
        next: 'Run pnpm accounts:create-hosted-logins, then re-run this script.',
      }),
    );
    process.exitCode = 1;
    return;
  }

  if (!privileged) {
    console.info(
      JSON.stringify({
        ok: false,
        reason: 'missing-admin-db-url',
        webRole: WEB_ROLE,
        workerRole: WORKER_ROLE,
        next: 'Put HOSTED_DB_ADMIN_URL in gitignored .env.hosted.local, then re-run. Do not paste the URL into chat.',
      }),
    );
    process.exitCode = 1;
    return;
  }

  const pool = hostedPgPool(privileged);
  try {
    const who = await pool.query<{ current_user: string }>('SELECT current_user');
    const adminUser = who.rows[0]?.current_user;
    if (adminUser !== 'postgres') {
      console.info(
        JSON.stringify({ ok: false, reason: 'admin-not-postgres', currentUser: adminUser }),
      );
      process.exitCode = 1;
      return;
    }
    await pool.query(`ALTER ROLE ${quoteIdent(WEB_ROLE)} PASSWORD ${quoteLiteral(webPassword)}`);
    await pool.query(
      `ALTER ROLE ${quoteIdent(WORKER_ROLE)} PASSWORD ${quoteLiteral(workerPassword)}`,
    );
  } catch (error) {
    console.info(
      JSON.stringify({
        ok: false,
        reason: 'alter-role-failed',
        error: redact(error),
      }),
    );
    process.exitCode = 1;
    return;
  } finally {
    await pool.end().catch(() => undefined);
  }

  rewriteLoginUrls(webPassword, workerPassword);
  delete process.env.DATABASE_URL_APP_WEB;
  delete process.env.DATABASE_LISTEN_URL_APP_WEB;
  delete process.env.WORKER_DATABASE_URL;
  delete process.env.DATABASE_LISTEN_URL;
  loadHostedOperatorEnv();
  const rewrittenWeb = hostedAppWebDatabaseUrl();
  const rewrittenWorker = hostedWorkerDatabaseUrl();
  const webConnect = rewrittenWeb ? await canConnect(rewrittenWeb, WEB_ROLE) : false;
  const workerConnect = rewrittenWorker ? await canConnect(rewrittenWorker, WORKER_ROLE) : false;
  const ok = webConnect && workerConnect;
  console.info(
    JSON.stringify({
      ok,
      applied: true,
      rewrittenToSessionPooler: true,
      webConnect,
      workerConnect,
      webRole: WEB_ROLE,
      workerRole: WORKER_ROLE,
    }),
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.info(JSON.stringify({ ok: false, reason: 'unexpected', error: redact(error) }));
  process.exitCode = 1;
});
