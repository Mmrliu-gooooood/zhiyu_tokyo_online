/**
 * Compatibility entry point for disposable lifecycle accounts.
 *
 * It intentionally has no default email. The former implementation defaulted
 * to the long-lived administrator and attempted to pass a user UUID to
 * `auth.admin.signOut()` as though it were a JWT. Both behaviours were unsafe.
 * Physical deletion is now handled by the resumable account-deletion workflow.
 */
const emailArg = process.argv.find((value) => value.startsWith('--email='));
const email = emailArg?.slice('--email='.length).trim() ?? '';

if (!email) {
  throw new Error('A disposable lifecycle account is required: --email=<exact email>');
}

if (!email.includes('+delete-') && process.env.ALLOW_NON_DISPOSABLE_DELETE !== 'YES') {
  throw new Error(
    'Refusing non-disposable test-admin deletion. Use a +delete- account or the generic accounts:delete operator workflow.',
  );
}

void import('./delete-account');
