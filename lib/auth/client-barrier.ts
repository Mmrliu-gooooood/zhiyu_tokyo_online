'use client';

let epoch = 0;
let frozen = false;

export function currentAuthEpoch(): number {
  return epoch;
}

export function isAuthSwitchFrozen(): boolean {
  return frozen;
}

export function beginAccountSwitch(): number {
  frozen = true;
  epoch += 1;
  return epoch;
}

export function assertLiveAuthEpoch(startedAt: number): void {
  if (frozen || startedAt !== epoch) {
    throw new Error('Stale auth epoch');
  }
}

export async function signOutAndReload(): Promise<void> {
  beginAccountSwitch();
  try {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Cookie clear still happens server-side when the request arrives;
    // continue to the login page even if the network call failed.
  }
  try {
    const channel = new BroadcastChannel('zhiyu-auth');
    channel.postMessage({ type: 'sign-out', epoch });
    channel.close();
  } catch {
    // BroadcastChannel is optional.
  }
  window.location.assign('/auth/login');
}
