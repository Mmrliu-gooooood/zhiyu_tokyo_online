import { randomUUID } from 'node:crypto';

import type { PgAgentSessionMaterialStore } from '@openmaic/storage/material/pg';

import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { getAgentSessionMaterialStore } from '@/lib/server/agent-runtime/session-materials';
import { heavyTaskQueueWaitMs, withHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';

import { extractClaimedSessionMaterial } from './extract';
import { isTransientExtractionError } from './errors';

export interface MaterialExtractionRunnerHandle {
  workerId: string;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface MaterialExtractionRunnerDependencies {
  getStore?: () => Promise<PgAgentSessionMaterialStore>;
  execute?: typeof extractClaimedSessionMaterial;
}

type ClaimedMaterialExtraction = NonNullable<
  Awaited<ReturnType<PgAgentSessionMaterialStore['claimNextExtraction']>>
>;

async function runClaimedMaterialExtraction(
  store: PgAgentSessionMaterialStore,
  claim: ClaimedMaterialExtraction,
  workerId: string,
  execute: typeof extractClaimedSessionMaterial,
): Promise<void> {
  const heartbeat = setInterval(() => {
    void store.heartbeatExtraction(claim.material.id, workerId);
  }, agentRuntimeConfig.heartbeatIntervalMs);
  try {
    await withHeavyTaskRootContext(
      {
        ownerId: claim.ownerId,
        rootTaskId: `agent:${claim.material.sessionId}`,
        kind: 'material-extraction',
      },
      () => execute(claim),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await store.settleExtractionFailure(
      claim.material.id,
      workerId,
      reason,
      isTransientExtractionError(error),
    );
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claim and settle one job. Exported so the failure path is contract-testable. */
export async function runNextMaterialExtraction(
  store: PgAgentSessionMaterialStore,
  workerId: string,
  execute: typeof extractClaimedSessionMaterial = extractClaimedSessionMaterial,
): Promise<boolean> {
  const claim = await store.claimNextExtraction(workerId, {
    leaseTtlMs: agentRuntimeConfig.leaseTtlMs,
  });
  if (!claim) return false;
  await runClaimedMaterialExtraction(store, claim, workerId, execute);
  return true;
}

/** Start the process-scoped, lease-fenced extraction queue scanner. */
export function startMaterialExtractionRunner(
  dependencies: MaterialExtractionRunnerDependencies = {},
): MaterialExtractionRunnerHandle {
  const workerId = `${process.pid}:${randomUUID()}`;
  const getStore = dependencies.getStore ?? getAgentSessionMaterialStore;
  const execute = dependencies.execute ?? extractClaimedSessionMaterial;
  const running = new Set<Promise<void>>();
  let stopping = false;
  let scanning = false;

  const scan = async () => {
    if (stopping || scanning) return;
    scanning = true;
    try {
      const store = await getStore();
      await store.expirePendingExtractions(heavyTaskQueueWaitMs());
      while (!stopping && running.size < agentRuntimeConfig.maxConcurrent) {
        const claim = await store.claimNextExtraction(workerId, {
          leaseTtlMs: agentRuntimeConfig.leaseTtlMs,
        });
        if (!claim) break;
        const job: Promise<void> = runClaimedMaterialExtraction(store, claim, workerId, execute)
          .then(() => undefined)
          .catch((error) => {
            console.error('[material-extraction] job failed before settlement', error);
          })
          .finally(() => running.delete(job));
        running.add(job);
      }
    } catch (error) {
      console.error('[material-extraction] scan failed', error);
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(() => void scan(), agentRuntimeConfig.scanIntervalMs);
  void scan();

  return {
    workerId,
    async stop(options) {
      stopping = true;
      clearInterval(timer);
      const deadline = Date.now() + (options?.timeoutMs ?? 15_000);
      while ((scanning || running.size > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
