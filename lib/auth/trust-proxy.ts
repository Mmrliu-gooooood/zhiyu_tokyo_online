/**
 * Whether the operator declared that a trusted reverse proxy overwrites
 * `x-forwarded-for` / `x-real-ip`. Accepts `1` or `true` (trimmed,
 * case-insensitive); anything else — including unset, `0`, `false`, `yes` —
 * keeps forwarding headers untrusted.
 */
export function trustProxyHeaders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.TRUST_PROXY_HEADERS?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
