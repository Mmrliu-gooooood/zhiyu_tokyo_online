import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  REQUEST_TIMING_STAGES,
  instrumentPoolTiming,
  instrumentObjectStoreClient,
  persistenceTimingRoute,
  recordRequestStage,
  requestTimingSampleRate,
  timeRequestStage,
  withRequestTiming,
  type RequestTimingRecord,
} from '@/lib/server/request-timing';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('request timing switch', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['abc', 0],
    ['-1', 0],
    ['0', 0],
    ['0.25', 0.25],
    ['5', 1],
  ])('parses REQUEST_TIMING_SAMPLE_RATE=%j as %d', (value, expected) => {
    expect(
      requestTimingSampleRate(value === undefined ? {} : { REQUEST_TIMING_SAMPLE_RATE: value }),
    ).toBe(expected);
  });

  it('runs the handler untouched and emits nothing when off', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '');
    vi.stubEnv('REQUEST_TIMING_SERVER_HEADER', '1');
    const emit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await withRequestTiming(
      { requestId: 'req-1', route: 'stage-meta' },
      async () => {
        // No context: stage helpers are pass-through.
        recordRequestStage('db.query', 5);
        await timeRequestStage('auth.claims', async () => undefined);
        return new Response('ok');
      },
      { emit },
    );
    expect(await response.text()).toBe('ok');
    expect(response.headers.has('server-timing')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('skips requests outside the sample', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '0.5');
    const emit = vi.fn();
    await withRequestTiming(
      { requestId: 'req-1', route: 'stage-meta' },
      async () => new Response('ok'),
      { emit, random: () => 0.9 },
    );
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('sampled request records', () => {
  it('emits only whitelisted fields and stage names', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    let record: RequestTimingRecord | undefined;
    await withRequestTiming(
      { requestId: 'req-1', route: 'persistence.documents' },
      async () => {
        await timeRequestStage('auth.claims', async () => undefined);
        recordRequestStage('db.query', 2);
        recordRequestStage('db.query', 3);
        return new Response('ok', { status: 201 });
      },
      { emit: (value) => (record = value) },
    );
    expect(record).toBeDefined();
    expect(Object.keys(record!).sort()).toEqual([
      'requestId',
      'route',
      'stages',
      'status',
      'totalMs',
    ]);
    expect(record!.status).toBe(201);
    expect(record!.stages['db.query']).toEqual({ count: 2, ms: 5 });
    expect(record!.stages['auth.claims']?.count).toBe(1);
    for (const stage of Object.keys(record!.stages)) {
      expect(REQUEST_TIMING_STAGES).toContain(stage);
    }
    for (const total of Object.values(record!.stages)) {
      expect(Object.keys(total).sort()).toEqual(['count', 'ms']);
    }
  });

  it('replaces an unsafe request id', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    let record: RequestTimingRecord | undefined;
    await withRequestTiming(
      { requestId: 'bad id; token=secret', route: 'stage-meta' },
      async () => new Response('ok'),
      { emit: (value) => (record = value) },
    );
    expect(record?.requestId).toBe('invalid');
  });

  it('does not leak error messages on failure and still rethrows', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    vi.stubEnv('LOG_FORMAT', 'json');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const secret = 'postgres://app_web:hunter2@db.example/owner-uuid-123';
    await expect(
      withRequestTiming({ requestId: 'req-2', route: 'persistence.assets' }, async () => {
        await timeRequestStage('auth.session_active', async () => {
          throw new Error(secret);
        });
        return new Response('unreachable');
      }),
    ).rejects.toThrow(secret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('owner-uuid-123');
    const message = (JSON.parse(lines[0]) as { message: string }).message;
    expect(message).toContain('"status":"error"');
    expect(lines[0]).toContain('auth.session_active');
  });

  it('sets a Server-Timing header with stage names only when requested', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    vi.stubEnv('REQUEST_TIMING_SERVER_HEADER', '1');
    const response = await withRequestTiming(
      { requestId: 'req-3', route: 'stage-meta' },
      async () => {
        recordRequestStage('storage.first_byte', 12.34);
        return new Response('ok');
      },
      { emit: () => undefined },
    );
    const header = response.headers.get('server-timing') ?? '';
    expect(header).toMatch(/^storage-first_byte;dur=12\.3, total;dur=[\d.]+$/);
  });

  it('keeps concurrent requests separate', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    const records: RequestTimingRecord[] = [];
    const run = (id: string, n: number) =>
      withRequestTiming(
        { requestId: id, route: 'persistence.runtime' },
        async () => {
          for (let i = 0; i < n; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            recordRequestStage('db.query', 1);
          }
          return new Response('ok');
        },
        { emit: (record) => records.push(record) },
      );
    await Promise.all([run('a', 2), run('b', 5)]);
    const byId = Object.fromEntries(records.map((record) => [record.requestId, record]));
    expect(byId.a.stages['db.query']?.count).toBe(2);
    expect(byId.b.stages['db.query']?.count).toBe(5);
  });
});

describe('route categories', () => {
  it('never includes ids', () => {
    expect(persistenceTimingRoute('/documents/stage-abc')).toBe('persistence.documents');
    expect(persistenceTimingRoute('/runtime/sessions/x')).toBe('persistence.runtime');
    expect(persistenceTimingRoute('/assets/sha256-abc/bytes')).toBe('persistence.assets');
    expect(persistenceTimingRoute('/owner-123')).toBe('persistence.other');
  });
});

class FakeClient {
  calls = 0;
  query(
    text: string,
    params?: unknown,
    callback?: (error: Error | null, result?: unknown) => void,
  ) {
    this.calls += 1;
    const cb = typeof params === 'function' ? params : callback;
    if (typeof cb === 'function') {
      setTimeout(() => (cb as (e: null, r: unknown) => void)(null, { rows: [] }), 1);
      return undefined;
    }
    void text;
    return new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 1));
  }
}

class FakePool extends EventEmitter {
  client = new FakeClient();
  connect(callback?: (error: Error | null, client?: FakeClient, done?: () => void) => void) {
    const deliver = () => {
      this.emit('connect', this.client);
      return this.client;
    };
    if (callback) {
      setTimeout(() => callback(null, deliver(), () => undefined), 2);
      return undefined;
    }
    return new Promise((resolve) => setTimeout(() => resolve(deliver()), 2));
  }
  query(text: string, params?: unknown[]) {
    return new Promise((resolve, reject) => {
      this.connect((error, client) => {
        if (error || !client) return reject(error);
        client.query(text, params, (queryError, result) =>
          queryError ? reject(queryError) : resolve(result),
        );
      });
    });
  }
}

describe('pool instrumentation', () => {
  it('counts checkout and SQL for sampled requests in callback and promise forms', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    const pool = new FakePool();
    instrumentPoolTiming(pool as unknown as Pool);
    instrumentPoolTiming(pool as unknown as Pool); // idempotent
    let record: RequestTimingRecord | undefined;
    await withRequestTiming(
      { requestId: 'req-4', route: 'persistence.documents' },
      async () => {
        await pool.query('SELECT 1');
        const client = (await pool.connect()) as FakeClient;
        await client.query('BEGIN');
        await client.query('COMMIT');
        return new Response('ok');
      },
      { emit: (value) => (record = value) },
    );
    expect(record?.stages['db.checkout']?.count).toBe(2);
    expect(record?.stages['db.query']?.count).toBe(3);
  });

  it('does not count work outside a sampled request', async () => {
    const pool = new FakePool();
    instrumentPoolTiming(pool as unknown as Pool);
    await pool.query('SELECT 1');
    expect(pool.client.calls).toBe(1);
  });
});

describe('S3 first-byte instrumentation', () => {
  it('times GetObject sends only', async () => {
    vi.stubEnv('REQUEST_TIMING_SAMPLE_RATE', '1');
    class GetObjectCommand {}
    class PutObjectCommand {}
    const send = vi.fn(async (_command: unknown) => ({}));
    const client = instrumentObjectStoreClient({ send, region: 'ap-northeast-1' });
    let record: RequestTimingRecord | undefined;
    await withRequestTiming(
      { requestId: 'req-5', route: 'persistence.assets' },
      async () => {
        await client.send(new GetObjectCommand());
        await client.send(new PutObjectCommand());
        return new Response('ok');
      },
      { emit: (value) => (record = value) },
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(record?.stages['storage.first_byte']?.count).toBe(1);
    expect((client as { region?: string }).region).toBe('ap-northeast-1');
  });
});
