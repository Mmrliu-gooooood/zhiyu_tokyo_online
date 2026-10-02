/**
 * v20: usage rows record who paid for a model call and how it ended (model
 * gateway plan 3.9). Additive and nullable: rows written before v20, and
 * non-LLM rows, leave them empty. The estimated cost is pi's catalog
 * estimate, not a bill.
 */
export const ACCOUNTS_MIGRATION_20 = `
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS funding_kind text
  CHECK (funding_kind IS NULL OR funding_kind IN ('platform', 'operator', 'byok', 'subscription', 'local'));
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS platform_default_id text;
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS platform_revision text;
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS credential_kind text
  CHECK (credential_kind IS NULL OR credential_kind IN ('inline-key', 'operator', 'platform', 'vault', 'none'));
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS api text;
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS status text
  CHECK (status IS NULL OR status IN ('ok', 'error', 'aborted'));
ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(18, 8)
  CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);
`;
