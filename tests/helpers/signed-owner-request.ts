import { createHmac } from 'node:crypto';
import { NextRequest as FrameworkNextRequest } from 'next/server';
import { vi } from 'vitest';

const SECRET = 'unit-test-signed-owner-secret-32-bytes-long';

/** Explicit deployment fixture; auth rejection tests use native Requests instead. */
function configureIdentity() {
  if (!process.env.GENERATION_SESSION_SECRET) vi.stubEnv('GENERATION_SESSION_SECRET', SECRET);
  if (!process.env.GENERATION_ALLOWED_ORIGINS) {
    vi.stubEnv(
      'GENERATION_ALLOWED_ORIGINS',
      'http://localhost,http://localhost:3000,http://127.0.0.1:3000',
    );
  }
}

export function signedOwnerCookie(id: string): string {
  configureIdentity();
  const proof = createHmac('sha256', process.env.GENERATION_SESSION_SECRET!)
    .update(`generation-owner:v1:${id}`)
    .digest('base64url');
  return `generation_owner=${id}.${proof}`;
}

function browserInit(
  input: string | URL | globalThis.Request,
  init: RequestInit = {},
): RequestInit {
  configureIdentity();
  const headers = new Headers(
    init.headers ?? (input instanceof globalThis.Request ? input.headers : undefined),
  );
  const url = input instanceof globalThis.Request ? input.url : input.toString();
  // Native browser fetch supplies this on writes; keep an explicitly supplied
  // Origin intact so a fixture can exercise rejection deliberately.
  if (!headers.has('origin')) headers.set('origin', new URL(url).origin);
  return { ...init, headers };
}

export class Request extends globalThis.Request {
  constructor(input: string | URL | globalThis.Request, init?: RequestInit) {
    super(input, { ...browserInit(input, init), signal: init?.signal ?? undefined });
  }
}

export class NextRequest extends FrameworkNextRequest {
  constructor(
    input: string | URL | globalThis.Request,
    init?: ConstructorParameters<typeof FrameworkNextRequest>[1],
  ) {
    super(input, { ...browserInit(input, init), signal: init?.signal ?? undefined });
  }
}
