import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import { assertSafeIp } from './ssrf-guard';

/** Reject every answer set containing a private, local, or reserved address. */
export function assertSafeLookupAddresses(addresses: LookupAddress[]): void {
  if (addresses.length === 0) throw new Error('DNS returned no addresses');
  for (const answer of addresses) assertSafeIp(answer.address);
}

function lookupAllThenPin(
  hostname: string,
  options: Record<string, unknown>,
  callback: (...args: unknown[]) => void,
): void {
  dnsLookup(
    hostname,
    { ...options, all: true, verbatim: true },
    (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) {
        callback(error);
        return;
      }
      try {
        assertSafeLookupAddresses(addresses);
      } catch (error) {
        callback(error);
        return;
      }
      if (options.all === true) callback(null, addresses);
      else {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      }
    },
  );
}

/** Pinned connection-time DNS without importing Agent sessions or browser stores. */
export function createPinnedFetchAgent(): Agent {
  return new Agent({
    headersTimeout: 10_000,
    bodyTimeout: 30_000,
    connect: { timeout: 5_000, lookup: lookupAllThenPin as never },
  });
}
