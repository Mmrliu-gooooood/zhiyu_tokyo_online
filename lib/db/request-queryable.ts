import type { Pool } from 'pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import type {
  PoolClientLike,
  TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';

/**
 * Request-bound queryable: each query() opens a short transaction, sets
 * `app.owner_id`, then commits. withTransaction() reuses that connection.
 * Never share an instance across HTTP requests.
 */
export type OwnerBoundQueryable = Queryable & {
  withTransaction: <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;
};

export function createOwnerBoundQueryable(pool: Pool, ownerId: string): OwnerBoundQueryable {
  const run = async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.owner_id', ownerId]);
      const queryable: Queryable = {
        async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
          const result = await client.query(text, params);
          return { rows: result.rows as TRow[] };
        },
      };
      const value = await body(queryable);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      return run((queryable) => queryable.query<TRow>(text, params));
    },
    withTransaction: run,
  };
}

export function currentOwnerSettingSql(): string {
  return `nullif(current_setting('app.owner_id', true), '')`;
}

/**
 * TransactionSource adapter for request repositories that own their BEGIN /
 * COMMIT lifecycle. The first BEGIN is immediately followed by a transaction-
 * local owner setting on the same checked-out connection.
 */
export function createOwnerBoundTransactionSource(
  pool: Pick<Pool, 'connect'>,
  ownerId: string,
): TransactionSource {
  return {
    async connect(): Promise<PoolClientLike> {
      const client = await pool.connect();
      let ownerBound = false;
      return {
        async query(text: string, params?: unknown[]) {
          const result = await client.query(text, params);
          if (!ownerBound && /^\s*BEGIN\s*;?\s*$/i.test(text)) {
            await client.query('SELECT set_config($1, $2, true)', ['app.owner_id', ownerId]);
            ownerBound = true;
          }
          if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(text)) ownerBound = false;
          return { rows: result.rows as unknown[] };
        },
        release: () => client.release(),
      };
    },
  };
}
