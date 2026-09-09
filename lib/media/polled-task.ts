import { ConfirmedMediaFailure } from './generation-errors';
import { readPolledTaskPersistence } from './polled-task-context';

export type TerminalResult<T> =
  | { status: 'done'; result: T }
  | { status: 'failed'; message: string };

export type SubmitResult<T> = { status: 'submitted'; taskId: string } | TerminalResult<T>;

export type PollResult<T> = { status: 'pending'; detail?: string } | TerminalResult<T>;

export interface PolledTaskTimeoutContext {
  label: string;
  taskId: string;
  attempts: number;
  intervalMs: number;
  elapsedMs: number;
  lastPendingDetail?: string;
}

export interface RunPolledTaskOptions<T> {
  submit: () => Promise<SubmitResult<T>>;
  poll: (taskId: string) => Promise<PollResult<T>>;
  intervalMs: number;
  maxAttempts: number;
  label: string;
  signal?: AbortSignal;
  formatTimeout?: (context: PolledTaskTimeoutContext) => string;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runPolledTask<T>({
  submit,
  poll,
  intervalMs,
  maxAttempts,
  label,
  signal,
  formatTimeout,
}: RunPolledTaskOptions<T>): Promise<T> {
  throwIfAborted(signal);
  const persistence = readPolledTaskPersistence();
  const submitted: SubmitResult<T> = persistence?.resumeTaskId
    ? { status: 'submitted', taskId: persistence.resumeTaskId }
    : await submit();
  throwIfAborted(signal);
  if (submitted.status === 'done') return submitted.result;
  if (submitted.status === 'failed') throw new ConfirmedMediaFailure('failed', submitted.message);
  if (!persistence?.resumeTaskId) await persistence?.persistTaskId(submitted.taskId);

  let attempts = 0;
  let lastPendingDetail: string | undefined;

  while (attempts < maxAttempts) {
    await delay(intervalMs, signal);
    throwIfAborted(signal);
    const result = await poll(submitted.taskId);
    throwIfAborted(signal);
    attempts++;

    if (result.status === 'done') return result.result;
    if (result.status === 'failed') throw new ConfirmedMediaFailure('failed', result.message);
    lastPendingDetail = result.detail;
  }

  const timeoutContext: PolledTaskTimeoutContext = {
    label,
    taskId: submitted.taskId,
    attempts,
    intervalMs,
    elapsedMs: attempts * intervalMs,
    lastPendingDetail,
  };
  const message = formatTimeout
    ? formatTimeout(timeoutContext)
    : `${label} timed out after ${attempts} polls`;
  throw new Error(message);
}
