/**
 * v21: credential vault and subscription sign-in sessions (model gateway plan
 * 3.10, P6-1).
 *
 * - model_credentials: one sealed provider credential per row (AES-256-GCM,
 *   see lib/model-gateway/credentials/vault.ts). At most one non-revoked row per
 *   owner and provider. Revoking removes the crypto material, not only the
 *   status, so a revoked credential cannot be decrypted again.
 * - model_auth_sessions: one sign-in attempt. The challenge is non-secret
 *   (auth URL, device code, instructions); a pasted redirect or code is kept
 *   sealed only until the executor consumes it. At most one open session per
 *   owner and provider.
 * - model_auth_settings: the deployment's stable sign-in device id, shared by
 *   every replica (single row).
 *
 * Both web and generation worker read credentials owner-bound: their policies
 * require app.owner_id, so even the worker never sees another owner's row.
 * Sign-in sessions and the device id are web-only (the login executor runs in
 * the web process). Account deletion runs as the migration administrator.
 */
export const ACCOUNTS_MIGRATION_21 = `
CREATE TABLE IF NOT EXISTS public.model_credentials (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 100),
  pi_provider_id text NOT NULL CHECK (length(pi_provider_id) BETWEEN 1 AND 100),
  auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'api_key')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'revoked')),
  account_label text CHECK (account_label IS NULL OR length(account_label) <= 200),
  ciphertext text,
  key_version integer NOT NULL CHECK (key_version > 0),
  secret_version integer NOT NULL CHECK (secret_version > 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT model_credentials_revoked_without_secret CHECK (
    (status = 'revoked') = (ciphertext IS NULL)
    AND (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS model_credentials_owner ON public.model_credentials(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS model_credentials_one_live
  ON public.model_credentials(owner_id, provider_id) WHERE status <> 'revoked';

CREATE TABLE IF NOT EXISTS public.model_auth_sessions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'awaiting_user', 'complete', 'failed', 'cancelled', 'expired', 'interrupted')
  ),
  challenge jsonb CHECK (challenge IS NULL OR jsonb_typeof(challenge) = 'object'),
  input_ciphertext text,
  executor_id text,
  lease_until timestamptz,
  credential_id uuid REFERENCES public.model_credentials(id) ON DELETE SET NULL,
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_auth_sessions_input_only_while_open CHECK (
    input_ciphertext IS NULL OR status IN ('pending', 'awaiting_user')
  )
);
CREATE INDEX IF NOT EXISTS model_auth_sessions_owner ON public.model_auth_sessions(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS model_auth_sessions_one_open
  ON public.model_auth_sessions(owner_id, provider_id) WHERE status IN ('pending', 'awaiting_user');

CREATE TABLE IF NOT EXISTS public.model_auth_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  device_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $model_credentials_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['model_credentials', 'model_auth_sessions', 'model_auth_settings']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$model_credentials_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.model_credentials TO app_web, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.model_auth_sessions TO app_web;
GRANT SELECT, INSERT ON TABLE public.model_auth_settings TO app_web;

DROP POLICY IF EXISTS model_credentials_web_all ON public.model_credentials;
CREATE POLICY model_credentials_web_all ON public.model_credentials
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS model_credentials_worker_owner ON public.model_credentials;
CREATE POLICY model_credentials_worker_owner ON public.model_credentials
  FOR ALL TO app_worker
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS model_auth_sessions_web_all ON public.model_auth_sessions;
CREATE POLICY model_auth_sessions_web_all ON public.model_auth_sessions
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS model_auth_settings_web_read ON public.model_auth_settings;
CREATE POLICY model_auth_settings_web_read ON public.model_auth_settings
  FOR SELECT TO app_web USING (true);
DROP POLICY IF EXISTS model_auth_settings_web_insert ON public.model_auth_settings;
CREATE POLICY model_auth_settings_web_insert ON public.model_auth_settings
  FOR INSERT TO app_web WITH CHECK (id = 1);
`;
