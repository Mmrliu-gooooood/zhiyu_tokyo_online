/**
 * Generate LOGIN-role passwords into gitignored files only.
 * Never prints the password. Never runs on startup. Does not call hosted SQL
 * (MCP/tooling would put the password in a transcript).
 *
 *   pnpm accounts:create-hosted-logins
 *
 * Writes pooled + LISTEN URLs for the app_web and app_worker roles (not live
 * `DATABASE_URL`). Then run the gitignored SQL in the Supabase SQL editor,
 * or `pnpm accounts:apply-hosted-logins` if a privileged DB URL is in
 * gitignored `.env.hosted.local` (never via MCP).
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const EXAMPLE = resolve(ROOT, '.env.hosted.example');
const LOCAL = resolve(ROOT, '.env.hosted.local');
const SQL_OUT = resolve(ROOT, '.scratch', 'hosted-set-login-passwords.sql');
const PROJECT_REF = 'lvbtgwlsebzbtcvjwktq';
const WEB_ROLE = 'zhiyu_app_web';
const WORKER_ROLE = 'zhiyu_app_worker';
const DIRECT_HOST = `db.${PROJECT_REF}.supabase.co`;

function randomPassword(): string {
  return randomBytes(24).toString('base64url');
}

function upsertEnv(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, line);
  return `${contents.trimEnd()}\n${line}\n`;
}

function main() {
  if (!existsSync(EXAMPLE)) {
    throw new Error('.env.hosted.example is missing');
  }
  if (!existsSync(LOCAL)) {
    copyFileSync(EXAMPLE, LOCAL);
  }

  const webPassword = randomPassword();
  const workerPassword = randomPassword();
  const encode = (password: string) => encodeURIComponent(password);
  const webUrl = `postgresql://${WEB_ROLE}:${encode(webPassword)}@${DIRECT_HOST}:5432/postgres?sslmode=verify-full`;
  const workerUrl = `postgresql://${WORKER_ROLE}:${encode(workerPassword)}@${DIRECT_HOST}:5432/postgres?sslmode=verify-full`;

  let env = readFileSync(LOCAL, 'utf8');
  env = upsertEnv(env, 'DATABASE_URL_APP_WEB', webUrl);
  env = upsertEnv(env, 'DATABASE_LISTEN_URL_APP_WEB', webUrl);
  env = upsertEnv(env, 'WORKER_DATABASE_URL', workerUrl);
  env = upsertEnv(env, 'DATABASE_LISTEN_URL', workerUrl);
  writeFileSync(LOCAL, env, { encoding: 'utf8', mode: 0o600 });

  mkdirSync(resolve(ROOT, '.scratch'), { recursive: true });
  writeFileSync(
    SQL_OUT,
    `-- Gitignored. Run in the zhiyu SQL editor. Do not commit.
-- Roles inherit app_web / app_worker. Set passwords here, not via MCP.
-- Direct host is the MCP database.host for project ${PROJECT_REF}.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WEB_ROLE}') THEN
    CREATE ROLE ${WEB_ROLE} LOGIN INHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
    CREATE ROLE ${WORKER_ROLE} LOGIN INHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

GRANT app_web TO ${WEB_ROLE};
GRANT app_worker TO ${WORKER_ROLE};

ALTER ROLE ${WEB_ROLE} PASSWORD '${webPassword.replace(/'/g, "''")}';
ALTER ROLE ${WORKER_ROLE} PASSWORD '${workerPassword.replace(/'/g, "''")}';
`,
    { encoding: 'utf8', mode: 0o600 },
  );

  console.info(
    JSON.stringify(
      {
        wroteEnv: '.env.hosted.local',
        wroteSql: '.scratch/hosted-set-login-passwords.sql',
        webRole: WEB_ROLE,
        workerRole: WORKER_ROLE,
        webUrlKey: 'DATABASE_URL_APP_WEB',
        webListenUrlKey: 'DATABASE_LISTEN_URL_APP_WEB',
        workerUrlKey: 'WORKER_DATABASE_URL',
        workerListenUrlKey: 'DATABASE_LISTEN_URL',
        host: DIRECT_HOST,
        applied: false,
        next: 'Run the gitignored SQL in the zhiyu SQL editor, or put HOSTED_DB_ADMIN_URL in .env.hosted.local and pnpm accounts:apply-hosted-logins. Passwords are not printed here. Do not set live DATABASE_URL.',
      },
      null,
      2,
    ),
  );
}

main();
