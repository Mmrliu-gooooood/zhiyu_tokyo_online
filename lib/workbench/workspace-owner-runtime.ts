'use client';

import {
  OwnerSessionClient,
  type OwnerEventSource,
  type OwnerEventSourceInit,
} from '@/lib/workbench/owner-session-client';
import type { ProHomeSessionItem } from '@/lib/workbench/pro-home-data';
import {
  commitSessionRename,
  createSessionRenameQueue,
  type SessionRenameOutcome,
} from '@/lib/workbench/session-title';

export type WorkspaceOwnerState = 'loading' | 'ready' | 'error';

export interface WorkspaceOwnerSnapshot {
  readonly sessions: readonly ProHomeSessionItem[];
  readonly state: WorkspaceOwnerState;
}

export interface WorkspaceAttachedSessionNaming {
  readonly id: string;
  readonly title: string | null;
  readonly prompt: string | null;
}

export interface WorkspaceOwnerRuntimeOptions {
  readonly fetchSessions: () => Promise<ProHomeSessionItem[]>;
  readonly createEventSource: (url: string, init?: OwnerEventSourceInit) => OwnerEventSource;
  readonly getAttachedSession: () => WorkspaceAttachedSessionNaming | null;
  readonly syncAttachedTitle: (sessionId: string, title: string | null) => void;
  readonly saveSessionTitle: (sessionId: string, title: string | null) => Promise<string | null>;
}

const INITIAL_SNAPSHOT: WorkspaceOwnerSnapshot = Object.freeze({
  sessions: Object.freeze([]) as readonly ProHomeSessionItem[],
  state: 'loading' as const,
});

interface SessionTitleLockManager {
  request<T>(
    name: string,
    options: { readonly signal: AbortSignal },
    task: (lock: object | null) => Promise<T> | T,
  ): Promise<T>;
}

interface StoredSessionTitleLock {
  readonly owner: string;
  readonly expiresAt: number;
}

const SESSION_TITLE_LOCK_LEASE_MS = 30_000;
const SESSION_TITLE_LOCK_REFRESH_MS = 10_000;
const SESSION_TITLE_LOCK_RETRY_MS = 10;

function sessionTitleLockManager(): SessionTitleLockManager | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { readonly locks?: SessionTitleLockManager }).locks ?? null;
}

function sessionTitleLockStorage(): Storage | null {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = globalThis[name];
      const probe = 'openmaic:session-title-lock:probe';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch {
      // Try the next browser-owned store. An embedded/insecure context may
      // expose Storage while denying access to it.
    }
  }
  return null;
}

function readStoredSessionTitleLock(storage: Storage, key: string): StoredSessionTitleLock | null {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<StoredSessionTitleLock>;
    return typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number'
      ? { owner: parsed.owner, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function waitForSessionTitleLock(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, SESSION_TITLE_LOCK_RETRY_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runStorageSessionTitleWrite<T>(
  name: string,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const storage = sessionTitleLockStorage();
  // Storage-denied embeds have no browser-wide primitive left. Preserve the
  // ordinary single-mount rename path; persistent contexts are serialized by
  // Web Locks or the lease below.
  if (!storage) return task();
  const key = `openmaic:session-title-lock:${name}`;
  const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  while (true) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const now = Date.now();
    const current = readStoredSessionTitleLock(storage, key);
    if (!current || current.expiresAt <= now) {
      storage.setItem(key, JSON.stringify({ owner, expiresAt: now + SESSION_TITLE_LOCK_LEASE_MS }));
      if (readStoredSessionTitleLock(storage, key)?.owner === owner) break;
    }
    await waitForSessionTitleLock(signal);
  }

  const refresh = setInterval(() => {
    try {
      if (readStoredSessionTitleLock(storage, key)?.owner !== owner) return;
      storage.setItem(
        key,
        JSON.stringify({ owner, expiresAt: Date.now() + SESSION_TITLE_LOCK_LEASE_MS }),
      );
    } catch {
      clearInterval(refresh);
    }
  }, SESSION_TITLE_LOCK_REFRESH_MS);
  try {
    return await task();
  } finally {
    clearInterval(refresh);
    if (readStoredSessionTitleLock(storage, key)?.owner === owner) storage.removeItem(key);
  }
}

/** Browser-owned exclusion survives a React/Shell remount without a module runtime. */
function runSessionTitleWrite<T>(
  sessionId: string,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const locks = sessionTitleLockManager();
  const name = `openmaic:session-title:${sessionId}`;
  if (!locks) return runStorageSessionTitleWrite(name, signal, task);
  return locks.request(name, { signal }, async () => task());
}

/**
 * Mount-scoped owner of the Workspace session list, owner EventSource and title writes.
 * The class has no module singleton: one Workspace mount creates one runtime and stop()
 * releases every resource owned by its OwnerSessionClient.
 */
export class WorkspaceOwnerRuntime {
  private readonly listeners = new Set<() => void>();
  private readonly renameQueue = createSessionRenameQueue();
  private readonly client: OwnerSessionClient;
  private snapshot: WorkspaceOwnerSnapshot = INITIAL_SNAPSHOT;
  private generation = 0;
  private started = false;
  private titleLockAbortController = new AbortController();

  constructor(private readonly options: WorkspaceOwnerRuntimeOptions) {
    this.client = new OwnerSessionClient({
      fetchSessions: options.fetchSessions,
      createEventSource: options.createEventSource,
      onSessions: (sessions, source) => this.publishSessions(sessions, source),
      onSessionTitle: options.syncAttachedTitle,
      onState: (state) => this.publishState(state),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkspaceOwnerSnapshot => this.snapshot;

  readonly getServerSnapshot = (): WorkspaceOwnerSnapshot => INITIAL_SNAPSHOT;

  start(): void {
    if (this.started) return;
    if (this.titleLockAbortController.signal.aborted) {
      this.titleLockAbortController = new AbortController();
    }
    this.started = true;
    this.client.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.titleLockAbortController.abort();
    this.client.stop();
  }

  requestFullFetch(showLoading = false): void {
    this.client.requestFullFetch(showLoading);
  }

  isActive(): boolean {
    return this.started;
  }

  getSession(sessionId: string): ProHomeSessionItem | null {
    return this.snapshot.sessions.find((session) => session.id === sessionId) ?? null;
  }

  updateSessions(
    update: (sessions: readonly ProHomeSessionItem[]) => readonly ProHomeSessionItem[],
  ): void {
    this.client.updateSessions(update);
  }

  getUnconfirmedSessionTitle(sessionId: string): { readonly title: string | null } | null {
    return this.client.getUnconfirmedSessionTitle(sessionId);
  }

  async renameSession(sessionId: string, raw: string): Promise<SessionRenameOutcome> {
    const generation = this.generation;
    const isOriginCurrent = () => this.started && this.generation === generation;
    const signal = this.titleLockAbortController.signal;
    try {
      return await this.renameQueue.run(sessionId, () =>
        runSessionTitleWrite(sessionId, signal, async () => {
          if (!isOriginCurrent()) return 'unchanged';
          const row = this.snapshot.sessions.find((session) => session.id === sessionId);
          const attached = this.options.getAttachedSession();
          const attachedNaming = attached?.id === sessionId ? attached : null;
          let revision: number | null = null;
          const outcome = await commitSessionRename({
            current: {
              title: row?.title ?? attachedNaming?.title ?? null,
              prompt: row?.prompt ?? attachedNaming?.prompt ?? null,
            },
            raw,
            apply: (title, settled) => {
              if (!isOriginCurrent()) return;
              this.options.syncAttachedTitle(sessionId, title);
              revision = this.client.updateSessionTitle(sessionId, title, settled);
            },
            save: (title) => this.options.saveSessionTitle(sessionId, title),
            isCurrent: () =>
              isOriginCurrent() &&
              revision !== null &&
              this.client.isSessionTitleRevisionCurrent(sessionId, revision),
            // The mounted snapshot may lag a write from a previous mount, so
            // every explicit submission is authoritative even when it looks
            // unchanged locally.
            forceSave: true,
          });
          if (isOriginCurrent() && outcome !== 'unchanged') this.client.requestFullFetch();
          return outcome;
        }),
      );
    } catch {
      return isOriginCurrent() ? 'failed' : 'unchanged';
    }
  }

  private publishSessions(
    sessions: readonly ProHomeSessionItem[],
    source?: 'incremental' | 'snapshot',
  ): void {
    const next = [...sessions];
    this.publish({ sessions: next, state: this.snapshot.state });
    if (source !== 'snapshot') return;
    const attached = this.options.getAttachedSession();
    if (!attached) return;
    const row = next.find((session) => session.id === attached.id);
    if (row) this.options.syncAttachedTitle(row.id, row.title ?? null);
  }

  private publishState(state: WorkspaceOwnerState): void {
    if (state === this.snapshot.state) return;
    this.publish({ sessions: this.snapshot.sessions, state });
  }

  private publish(snapshot: WorkspaceOwnerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
