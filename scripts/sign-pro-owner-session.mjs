/**
 * Local operator-only recovery; never expose as an HTTP endpoint.
 * Supply GENERATION_SESSION_SECRET using the same deployment secret as the app.
 * node scripts/sign-pro-owner-session.mjs --owner anon:<verified-uuid> --output <private-file>
 * The operator must verify this browser's ownership against local backups / DB.
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const owner = args[args.indexOf('--owner') + 1];
const output = args[args.indexOf('--output') + 1];
const secret = process.env.GENERATION_SESSION_SECRET;
const id = owner?.replace(/^anon:/, '');
if (
  !args.includes('--owner') ||
  !args.includes('--output') ||
  !output ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')
) {
  throw new Error('Specify an operator-verified --owner anon:<uuid> and private --output file.');
}
if (!secret || Buffer.byteLength(secret) < 32)
  throw new Error('GENERATION_SESSION_SECRET is unavailable.');
const proof = createHmac('sha256', secret).update(`generation-owner:v1:${id}`).digest('base64url');
writeFileSync(output, `${id}.${proof}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
console.log('Signed owner cookie written to the specified private file. Keep it secret.');
