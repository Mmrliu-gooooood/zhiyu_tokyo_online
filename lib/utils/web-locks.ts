/**
 * Return the Web Locks manager only for web-platform navigators.
 *
 * Node 24 exposes a process-global `navigator.locks`, but runtime persistence
 * uses lock names to coordinate browser storage realms. Treating Node's lock
 * manager as that browser boundary couples otherwise isolated server/test
 * stores and can deadlock concurrency fallbacks that intentionally run
 * without Web Locks.
 */
export function webLockManager(): LockManager | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  if (userAgent.startsWith('Node.js/')) return undefined;
  return navigator.locks;
}
