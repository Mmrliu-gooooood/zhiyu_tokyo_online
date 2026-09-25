import { AsyncLocalStorage } from 'node:async_hooks';
const quota = new AsyncLocalStorage<boolean>();
const quotaOwner = new AsyncLocalStorage<string>();
/** The caller must supply an owner resolved from a verified server principal. */
export function withProviderQuotaOwner<T>(ownerId: string, work: () => T): T {
  const current = quotaOwner.getStore();
  if (current && current !== ownerId) throw new Error('Provider quota owner cannot change');
  return quotaOwner.run(ownerId, work);
}
export function getProviderQuotaOwner(): string | undefined {
  return quotaOwner.getStore();
}
export function runWithGenerationQuota<T>(work: () => T): T {
  return quota.run(true, work);
}
export function generationQuotaActive(): boolean {
  return quota.getStore() === true;
}
