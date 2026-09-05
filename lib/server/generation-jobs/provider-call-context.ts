import { AsyncLocalStorage } from 'node:async_hooks';
const quota = new AsyncLocalStorage<boolean>();
export function runWithGenerationQuota<T>(work: () => T): T {
  return quota.run(true, work);
}
export function generationQuotaActive(): boolean {
  return quota.getStore() === true;
}
