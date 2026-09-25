import { describe, expect, it, vi } from 'vitest';

import { createOwnerBoundTransactionSource } from '@/lib/db/request-queryable';

describe('owner-bound transaction source', () => {
  it('sets the local owner immediately after the caller begins a transaction', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const source = createOwnerBoundTransactionSource(
      { connect: vi.fn(async () => ({ query, release })) } as never,
      'owner-a',
    );

    const client = await source.connect();
    await client.query('BEGIN');
    await client.query('SELECT * FROM generation_jobs WHERE owner_id=$1', ['owner-a']);
    await client.query('COMMIT');
    client.release();

    expect(query.mock.calls).toEqual([
      ['BEGIN', undefined],
      ['SELECT set_config($1, $2, true)', ['app.owner_id', 'owner-a']],
      ['SELECT * FROM generation_jobs WHERE owner_id=$1', ['owner-a']],
      ['COMMIT', undefined],
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
