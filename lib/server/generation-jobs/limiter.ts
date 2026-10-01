import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';
import { GenerationJobRepository } from './repository';
import { GenerationJobError } from './contracts';
import { generationConfig } from './config';
// Direct module (not the gateway index): the gateway's quota stage imports this file.
import { isGatewayError } from '@/lib/model-gateway/runtime/errors';

export function quotaGroupForCredential(providerId: string, apiKey: string): string {
  return `${providerId}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}
export interface ProviderSlot {
  group: string;
  slot: number;
  holder: string;
  epoch: number;
}
export type QuotaKind = 'llm' | 'tts' | 'media';
/** PostgreSQL, not process-local counters, is the authority for all shared callers. */
export class PostgresGenerationLimiter {
  private readonly repo: GenerationJobRepository;
  private readonly limits: Record<QuotaKind, number>;
  constructor(
    pool: TransactionSource,
    limits: Partial<Record<QuotaKind, number>> = {},
    private readonly options: { ownerId?: string } = {},
  ) {
    this.repo = new GenerationJobRepository(pool);
    const c = generationConfig();
    this.limits = {
      llm: c.llmConcurrency,
      tts: c.ttsConcurrency,
      media: c.mediaConcurrency,
      ...limits,
    };
  }
  async acquire(
    group: string,
    limit: number,
    holder = randomUUID(),
    deadlineMs = 300_000,
  ): Promise<ProviderSlot | null> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new GenerationJobError('INVALID_PROVIDER_LIMIT', 400);
    return this.repo.transaction(async (q) => {
      if (this.options.ownerId) {
        await q.query("SELECT set_config('app.owner_id',$1,true)", [this.options.ownerId]);
        const row = (
          await q.query<{ slot_no: number; lease_epoch: string }>(
            'SELECT * FROM app_internal.acquire_provider_quota($1,$2,$3,$4)',
            [group, limit, holder, deadlineMs],
          )
        ).rows[0];
        return row ? { group, slot: row.slot_no, holder, epoch: Number(row.lease_epoch) } : null;
      }
      await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:quota:' || $1))", [group]);
      await q.query(
        `INSERT INTO generation_provider_slots(quota_group,slot_no)
         SELECT $1, slot_no FROM generate_series(0, $2 - 1) AS slot_no
         ON CONFLICT DO NOTHING`,
        [group, limit],
      );
      // Expiry does not imply a provider stopped. A dead holder stays isolated until deadline + grace.
      const row = (
        await q.query<{ slot_no: number; lease_epoch: number }>(
          `SELECT slot_no,lease_epoch FROM generation_provider_slots WHERE quota_group=$1 AND slot_no<$2
        AND (holder_attempt_id IS NULL OR (expires_at<=clock_timestamp() AND quarantine_until<=clock_timestamp()))
        AND (quarantine_until IS NULL OR quarantine_until<=clock_timestamp())
        AND (cooldown_until IS NULL OR cooldown_until<=clock_timestamp()) ORDER BY slot_no LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [group, limit],
        )
      ).rows[0];
      if (!row) return null;
      await q.query(
        "UPDATE generation_provider_slots SET holder_attempt_id=$3,lease_epoch=lease_epoch+1,expires_at=clock_timestamp()+$4*interval '1 millisecond',quarantine_until=clock_timestamp()+($4+30000)*interval '1 millisecond' WHERE quota_group=$1 AND slot_no=$2",
        [group, row.slot_no, holder, deadlineMs],
      );
      return { group, slot: row.slot_no, holder, epoch: Number(row.lease_epoch) + 1 };
    });
  }
  async release(slot: ProviderSlot, uncertain = false): Promise<void> {
    await this.repo.transaction(async (q) => {
      if (this.options.ownerId) {
        await q.query("SELECT set_config('app.owner_id',$1,true)", [this.options.ownerId]);
        await q.query('SELECT app_internal.release_provider_quota($1,$2,$3,$4,$5)', [
          slot.group,
          slot.slot,
          slot.holder,
          slot.epoch,
          uncertain,
        ]);
        return;
      }
      await q.query(
        `UPDATE generation_provider_slots SET holder_attempt_id=NULL,expires_at=NULL,quarantine_until=${uncertain ? 'quarantine_until' : 'NULL'} WHERE quota_group=$1 AND slot_no=$2 AND holder_attempt_id=$3 AND lease_epoch=$4`,
        [slot.group, slot.slot, slot.holder, slot.epoch],
      );
    });
  }
  async heartbeat(slot: ProviderSlot, deadlineMs: number): Promise<boolean> {
    return this.repo.transaction(async (q) => {
      if (this.options.ownerId) {
        await q.query("SELECT set_config('app.owner_id',$1,true)", [this.options.ownerId]);
        return (
          (
            await q.query<{ alive: boolean }>(
              'SELECT app_internal.heartbeat_provider_quota($1,$2,$3,$4,$5) AS alive',
              [slot.group, slot.slot, slot.holder, slot.epoch, deadlineMs],
            )
          ).rows[0]?.alive === true
        );
      }
      const result = await q.query<{ slot_no: number }>(
        "UPDATE generation_provider_slots SET expires_at=clock_timestamp()+$5*interval '1 millisecond',quarantine_until=GREATEST(quarantine_until,clock_timestamp()+($5+30000)*interval '1 millisecond') WHERE quota_group=$1 AND slot_no=$2 AND holder_attempt_id=$3 AND lease_epoch=$4 AND expires_at>clock_timestamp() RETURNING slot_no",
        [slot.group, slot.slot, slot.holder, slot.epoch, deadlineMs],
      );
      return result.rows.length === 1;
    });
  }
  async cooldown(group: string, retryAfterMs: number, slot?: ProviderSlot): Promise<void> {
    if (this.options.ownerId) {
      if (!slot || slot.group !== group) throw new GenerationJobError('PROVIDER_SLOT_REQUIRED');
      await this.repo.transaction(async (q) => {
        await q.query("SELECT set_config('app.owner_id',$1,true)", [this.options.ownerId]);
        return q.query('SELECT app_internal.cooldown_provider_quota($1,$2,$3,$4,$5)', [
          group,
          slot.slot,
          slot.holder,
          slot.epoch,
          Math.max(0, Math.min(3_600_000, retryAfterMs)),
        ]);
      });
      return;
    }
    await this.repo.transaction((q) =>
      q.query(
        "UPDATE generation_provider_slots SET cooldown_until=GREATEST(COALESCE(cooldown_until,clock_timestamp()),clock_timestamp()+$2*interval '1 millisecond') WHERE quota_group=$1",
        [group, Math.max(0, Math.min(3_600_000, retryAfterMs))],
      ),
    );
  }
  async run<T>(
    kind: QuotaKind,
    group: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const deadline = kind === 'media' ? 600_000 : kind === 'tts' ? 120_000 : 300_000;
    let slot: ProviderSlot | null = null;
    while (!slot) {
      signal.throwIfAborted();
      slot = await this.acquire(`${kind}:${group}`, this.limits[kind], randomUUID(), deadline);
      if (!slot)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const timer = setTimeout(done, 250 + Math.floor(Math.random() * 250));
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(signal.reason ?? new Error('Aborted'));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
    }
    let succeeded = false,
      renewing = false;
    let rejectLease: (reason: unknown) => void = () => {};
    const lostLease = new Promise<never>((_, reject) => {
      rejectLease = reject;
    });
    const held = slot;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.heartbeat(held, deadline)
        .then(
          (alive) => {
            if (!alive) rejectLease(new GenerationJobError('PROVIDER_SLOT_LEASE_LOST'));
          },
          () => rejectLease(new GenerationJobError('PROVIDER_SLOT_DATABASE_UNAVAILABLE')),
        )
        .finally(() => {
          renewing = false;
        });
    }, 10_000);
    timer.unref?.();
    try {
      signal.throwIfAborted();
      const result = await Promise.race([work(), lostLease]);
      succeeded = true;
      return result;
    } catch (error) {
      if (isGatewayError(error)) {
        // Model calls: only an explicit provider rate limit cools the group down.
        if (kind !== 'media' && error.code === 'MODEL_RATE_LIMITED') {
          succeeded = true;
          await this.cooldown(
            `${kind}:${group}`,
            error.retryAfterMs !== undefined && error.retryAfterMs > 0 ? error.retryAfterMs : 5000,
            held,
          );
        }
        throw error;
      }
      const failure = error as {
        safeToRetry?: boolean;
        statusCode?: number;
        responseHeaders?: Record<string, string>;
      } | null;
      if (failure?.safeToRetry === true || (kind !== 'media' && failure?.statusCode === 429)) {
        succeeded = true;
        const seconds = Number(failure?.responseHeaders?.['retry-after']);
        await this.cooldown(
          `${kind}:${group}`,
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000,
          held,
        );
      }
      throw error;
    } finally {
      clearInterval(timer);
      await this.release(slot, !succeeded);
    }
  }
}
