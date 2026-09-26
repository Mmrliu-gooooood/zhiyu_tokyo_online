/**
 * Per-request stage timing for latency diagnosis (P1-0).
 *
 * Off by default. `REQUEST_TIMING_SAMPLE_RATE` (0..1) samples requests; a
 * sampled request emits one log line with its request id, a fixed route
 * category, the status and per-stage `{count, ms}` totals. Only names from
 * REQUEST_TIMING_STAGES and millisecond numbers are ever written — never
 * cookies, tokens, connection strings, owner ids, object keys or error text.
 * `REQUEST_TIMING_SERVER_HEADER=1` additionally sets a `Server-Timing` header
 * carrying the same stage names and durations for browser waterfalls.
 *
 * Stages nest: `auth.*` wrap whole registry calls, so their SQL also appears
 * under `db.checkout` / `db.query`; `storage.first_byte` is part of
 * `storage.read`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

import { createLogger } from '@/lib/logger';

export const REQUEST_TIMING_STAGES = [
  'auth.claims',
  'auth.account_self',
  'auth.ensure_account',
  'auth.load_account',
  'auth.session_active',
  'auth.retry_wait',
  'db.checkout',
  'db.query',
  'storage.first_byte',
  'storage.read',
] as const;

export type RequestTimingStage = (typeof REQUEST_TIMING_STAGES)[number];

export type RequestTimingRoute =
  | 'persistence.documents'
  | 'persistence.runtime'
  | 'persistence.assets'
  | 'persistence.other'
  | 'stage-meta';

interface StageTotal {
  count: number;
  ms: number;
}

interface TimingContext {
  stages: Map<RequestTimingStage, StageTotal>;
}

export interface RequestTimingRecord {
  requestId: string;
  route: RequestTimingRoute;
  status: number | 'error';
  totalMs: number;
  stages: Partial<Record<RequestTimingStage, StageTotal>>;
}

type TimingEnv = Readonly<Record<string, string | undefined>>;

const storage = new AsyncLocalStorage<TimingContext>();
const log = createLogger('RequestTiming');
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Sampling rate in [0, 1]; anything unset or malformed is 0 (off). */
export function requestTimingSampleRate(env: TimingEnv = process.env): number {
  const raw = env.REQUEST_TIMING_SAMPLE_RATE?.trim();
  if (!raw) return 0;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(rate, 1);
}

export function requestTimingEnabled(env: TimingEnv = process.env): boolean {
  return requestTimingSampleRate(env) > 0;
}

function serverTimingHeaderEnabled(env: TimingEnv = process.env): boolean {
  const value = env.REQUEST_TIMING_SERVER_HEADER?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

const round = (ms: number) => Math.round(ms * 10) / 10;

function add(context: TimingContext, stage: RequestTimingStage, ms: number): void {
  const total = context.stages.get(stage) ?? { count: 0, ms: 0 };
  total.count += 1;
  total.ms += ms;
  context.stages.set(stage, total);
}

/** Record a measured duration against the current sampled request, if any. */
export function recordRequestStage(stage: RequestTimingStage, ms: number): void {
  const context = storage.getStore();
  if (context) add(context, stage, ms);
}

/** Time `work` as `stage` when the current request is sampled; otherwise just run it. */
export async function timeRequestStage<T>(
  stage: RequestTimingStage,
  work: () => Promise<T>,
): Promise<T> {
  const context = storage.getStore();
  if (!context) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    add(context, stage, performance.now() - started);
  }
}

/** Fixed category for a persistence route path; ids never leave this function. */
export function persistenceTimingRoute(path: string): RequestTimingRoute {
  const segment = path.split('/').filter(Boolean)[0];
  if (segment === 'documents') return 'persistence.documents';
  if (segment === 'runtime') return 'persistence.runtime';
  if (segment === 'assets') return 'persistence.assets';
  return 'persistence.other';
}

function snapshot(context: TimingContext): Partial<Record<RequestTimingStage, StageTotal>> {
  const stages: Partial<Record<RequestTimingStage, StageTotal>> = {};
  for (const stage of REQUEST_TIMING_STAGES) {
    const total = context.stages.get(stage);
    if (total) stages[stage] = { count: total.count, ms: round(total.ms) };
  }
  return stages;
}

function serverTimingValue(record: RequestTimingRecord): string {
  const parts = Object.entries(record.stages).map(
    ([stage, total]) => `${stage.replace('.', '-')};dur=${total.ms}`,
  );
  parts.push(`total;dur=${record.totalMs}`);
  return parts.join(', ');
}

/**
 * Run a request handler under a timing context when the request is sampled.
 * An unsampled request runs `work` directly with no context and no output.
 */
export async function withRequestTiming(
  input: { requestId: string; route: RequestTimingRoute },
  work: () => Promise<Response>,
  deps: { random?: () => number; emit?: (record: RequestTimingRecord) => void } = {},
): Promise<Response> {
  const rate = requestTimingSampleRate();
  if (rate <= 0 || (deps.random ?? Math.random)() >= rate) return work();

  const context: TimingContext = { stages: new Map() };
  const started = performance.now();
  let response: Response | undefined;
  try {
    response = await storage.run(context, work);
    return response;
  } finally {
    const record: RequestTimingRecord = {
      requestId: SAFE_REQUEST_ID.test(input.requestId) ? input.requestId : 'invalid',
      route: input.route,
      status: response?.status ?? 'error',
      totalMs: round(performance.now() - started),
      stages: snapshot(context),
    };
    if (response && serverTimingHeaderEnabled()) {
      try {
        response.headers.set('server-timing', serverTimingValue(record));
      } catch {
        // Immutable headers: the log line still carries the same data.
      }
    }
    if (deps.emit) deps.emit(record);
    else log.info('request timing', record);
  }
}

const INSTRUMENTED = Symbol.for('openmaic.request-timing.instrumented');
type Instrumentable = { [INSTRUMENTED]?: true };
type AnyFunction = (...args: unknown[]) => unknown;

function timeCallOrPromise(
  context: TimingContext,
  stage: RequestTimingStage,
  call: (args: unknown[]) => unknown,
  args: unknown[],
): unknown {
  const started = performance.now();
  const done = () => add(context, stage, performance.now() - started);
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    const callback = last as AnyFunction;
    return call([
      ...args.slice(0, -1),
      (...callbackArgs: unknown[]) => {
        done();
        return callback(...callbackArgs);
      },
    ]);
  }
  const result = call(args);
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    (result as Promise<unknown>).then(done, done);
  }
  return result;
}

function instrumentClient(client: PoolClient): void {
  const target = client as PoolClient & Instrumentable;
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;
  const original = client.query.bind(client) as unknown as AnyFunction;
  (client as unknown as { query: AnyFunction }).query = (...args: unknown[]) => {
    const context = storage.getStore();
    if (!context) return original(...args);
    return timeCallOrPromise(context, 'db.query', (next) => original(...next), args);
  };
}

/**
 * Count checkout waits and SQL statements of sampled requests on this pool.
 * Only installed when timing is enabled at pool creation, so a disabled
 * deployment runs the unmodified pool.
 */
export function instrumentPoolTiming(pool: Pool): void {
  const target = pool as Pool & Instrumentable;
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;
  pool.on('connect', instrumentClient);
  const original = pool.connect.bind(pool) as unknown as AnyFunction;
  (pool as unknown as { connect: AnyFunction }).connect = (...args: unknown[]) => {
    const context = storage.getStore();
    if (!context) return original(...args);
    return timeCallOrPromise(context, 'db.checkout', (next) => original(...next), args);
  };
}

/** Object-store SDK client wrapper: a GetObject `send` resolves at response headers (first byte). */
export function instrumentObjectStoreClient<T extends { send(command: unknown): Promise<unknown> }>(
  client: T,
): T {
  const send = client.send.bind(client);
  return Object.assign(Object.create(client) as T, {
    send: (command: unknown) => {
      const isGet =
        typeof command === 'object' &&
        command !== null &&
        command.constructor?.name === 'GetObjectCommand';
      return isGet ? timeRequestStage('storage.first_byte', () => send(command)) : send(command);
    },
  });
}
