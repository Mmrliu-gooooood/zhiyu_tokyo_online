import { AuthError } from './errors';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AppRole = 'user' | 'admin';
export type AccountStatus = 'active' | 'disabled' | 'deleting';

export interface Principal {
  userId: string;
  ownerId: string;
  learnerKey: string;
  assetPrincipal: string;
  role: AppRole;
  sessionId: string;
  email: string;
  status: AccountStatus;
}

export function encodeOwnerId(userId: string): string {
  if (!UUID.test(userId)) {
    throw new Error('userId must be a UUID');
  }
  return `user:${userId.toLowerCase()}`;
}

export function parseOwnerUserId(ownerId: string): string | undefined {
  if (!ownerId.startsWith('user:')) return undefined;
  const userId = ownerId.slice('user:'.length);
  return UUID.test(userId) ? userId.toLowerCase() : undefined;
}

/** Real account owners isolate even when AUTH_MODE is unset. */
export function shouldIsolateOwner(ownerId: string | undefined): boolean {
  return Boolean(ownerId && parseOwnerUserId(ownerId));
}

export function createPrincipal(input: {
  userId: string;
  role: AppRole;
  sessionId: string;
  email: string;
  status?: AccountStatus;
}): Principal {
  const userId = input.userId.toLowerCase();
  const ownerId = encodeOwnerId(userId);
  return {
    userId,
    ownerId,
    learnerKey: ownerId,
    assetPrincipal: ownerId,
    role: input.role,
    sessionId: input.sessionId,
    email: input.email,
    status: input.status ?? 'active',
  };
}

export function requireAdmin(principal: Principal): void {
  if (principal.role !== 'admin') {
    throw new AuthError('FORBIDDEN', 'Administrator role required');
  }
}
