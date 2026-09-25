'use client';

import { canUseHostedAuthUi, isHostedAuthEnabled } from '@/lib/auth/mode';

export interface AccountSnapshot {
  userId: string;
  ownerId: string;
  learnerKey: string;
  sessionId: string;
  email: string;
  role: 'user' | 'admin';
  displayName: string | null;
  status: 'active' | 'disabled' | 'deleting';
}

let readyUserId: string | undefined;
let readyAccount: AccountSnapshot | undefined;
let inflight: Promise<AccountSnapshot> | undefined;

export function peekAccountUserId(): string | undefined {
  return readyAccount?.userId ?? readyUserId;
}

export function peekAccountSnapshot(): AccountSnapshot | undefined {
  return readyAccount;
}

export function setAccountUserId(userId: string): void {
  readyUserId = userId;
}

export function clearAccountEnvironment(): void {
  readyUserId = undefined;
  readyAccount = undefined;
  inflight = undefined;
}

export function accountKvNamespace(): string {
  if (readyUserId) return `zhiyu:openmaic:${readyUserId}`;
  if (isHostedAuthEnabled()) {
    throw new Error('Account namespace is not ready');
  }
  return 'maic';
}

export function requireAccountEnvironment(): Promise<AccountSnapshot> {
  if (!canUseHostedAuthUi()) {
    return Promise.reject(new Error('Hosted auth is not enabled'));
  }
  inflight ??= fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('unauthenticated');
      }
      const body = (await response.json()) as AccountSnapshot;
      if (!body?.userId || !body.ownerId || !body.sessionId) {
        throw new Error('unauthenticated');
      }
      readyUserId = body.userId;
      readyAccount = body;
      return body;
    })
    .catch((error) => {
      inflight = undefined;
      throw error;
    });
  return inflight;
}
