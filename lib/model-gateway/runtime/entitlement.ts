/**
 * Charging seam (plan 3.3.5, ADR-0011). Only platform-funded calls are
 * authorized; every attempt is settled. This round ships the allow-all policy;
 * a credit policy is injected at process start with `setEntitlementPolicy()`.
 */
import type { EntitlementGrant, EntitlementPolicy } from '../types';

export class AllowAllEntitlementPolicy implements EntitlementPolicy {
  async authorize(): Promise<EntitlementGrant> {
    return { id: 'allow-all' };
  }

  async settle(): Promise<void> {}
}

let current: EntitlementPolicy = new AllowAllEntitlementPolicy();

export function setEntitlementPolicy(policy: EntitlementPolicy): void {
  current = policy;
}

export function getEntitlementPolicy(): EntitlementPolicy {
  return current;
}
