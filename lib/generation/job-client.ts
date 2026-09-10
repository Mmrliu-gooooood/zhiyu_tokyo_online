import type {
  GenerationDisplayProgress,
  GenerationInput,
  GenerationJobView,
} from '@/lib/server/generation-jobs/contracts';
import type { SceneOutline } from '@/lib/types/generation';
import { nanoid } from 'nanoid';

export interface GenerationJobSnapshot extends GenerationJobView {
  /** Absent only when reconnecting to a pre-T01 server revision. */
  displayProgress?: GenerationDisplayProgress;
  queueReason?: 'owner_limit' | 'site_limit' | 'queued' | 'service_unavailable' | null;
  retryAt?: string | null;
  outlines?: SceneOutline[];
  activeSteps?: Array<{ key: string; kind: string; outlineId: string | null }>;
  scenes?: Array<{ outlineId: string; sceneId: string; ordinal: number; status: string }>;
}

export class GenerationJobRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function generationJobRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api/generate-classroom${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new GenerationJobRequestError(
      response.status,
      typeof body.error === 'string' ? body.error : (body.code ?? 'GENERATION_REQUEST_FAILED'),
    );
  }
  return body as T;
}

/** A failed capability lookup is never interpreted as permission to start local work. */
export async function readBackgroundGenerationCapability(signal?: AbortSignal): Promise<{
  enabled: boolean;
  available: boolean;
  pipelineVersion?: string;
}> {
  const response = await fetch('/api/server-providers', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok)
    throw new GenerationJobRequestError(response.status, 'GENERATION_CAPABILITY_UNAVAILABLE');
  const body = await response.json();
  const capability = body.generation?.background;
  // Old servers lack this capability and continue to support local generation.
  if (capability === undefined) return { enabled: false, available: false };
  if (typeof capability.enabled !== 'boolean' || typeof capability.available !== 'boolean') {
    throw new GenerationJobRequestError(503, 'GENERATION_CAPABILITY_UNAVAILABLE');
  }
  return capability;
}

export function createGenerationJob(input: GenerationInput, key: string, signal?: AbortSignal) {
  return generationJobRequest<GenerationJobSnapshot>('', {
    method: 'POST',
    body: input,
    key,
    signal,
  });
}

/** Explicit user retry only. Unknown external results require a fresh cost acknowledgement. */
export async function retryGenerationJob(
  job: Pick<GenerationJobSnapshot, 'jobId' | 'status' | 'stateVersion'>,
  options: { key?: string; confirmUnknown?: (message: string) => boolean } = {},
): Promise<GenerationJobSnapshot | null> {
  if (!['failed', 'needs_attention'].includes(job.status)) return null;
  const needsAcknowledgement = job.status === 'needs_attention';
  if (
    needsAcknowledgement &&
    !(options.confirmUnknown ?? ((message) => window.confirm(message)))(
      '上一次生成请求的结果尚未确定。重试可能再次调用生成服务并产生重复费用。是否继续重试？',
    )
  )
    return null;
  const commandKey = options.key ?? nanoid();
  return generationJobRequest<GenerationJobSnapshot>(`/${encodeURIComponent(job.jobId)}/retry`, {
    method: 'POST',
    key: commandKey,
    body: {
      commandKey,
      expectedVersion: job.stateVersion,
      ...(needsAcknowledgement ? { acknowledged: true } : {}),
    },
  });
}

/** Cancellation is a command, never an observer cleanup or navigation side effect. */
export function cancelGenerationJob(jobId: string, commandKey = nanoid()) {
  return generationJobRequest<GenerationJobSnapshot>(`/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    key: commandKey,
    body: { commandKey },
  });
}

/** Sequential polling: an old job's late response can never reach a new observer. */
export function observeGenerationJob(
  jobId: string,
  onSnapshot: (job: GenerationJobSnapshot) => void | Promise<void>,
  onError: (error: Error) => void,
  onReconnect?: () => void,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = -1;
  let disconnected = false;
  const poll = async () => {
    let interval = 2000;
    try {
      const job = await generationJobRequest<GenerationJobSnapshot>(
        `/${encodeURIComponent(jobId)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || job.jobId !== jobId) return;
      if (disconnected) {
        disconnected = false;
        onReconnect?.();
      }
      interval = Math.max(1000, Math.min(job.pollIntervalMs ?? 2000, 30_000));
      if (job.stateVersion > version) {
        await onSnapshot(job);
        version = job.stateVersion;
      }
      if (['succeeded', 'cancelled'].includes(job.status)) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      disconnected = true;
      onError(error instanceof Error ? error : new Error('GENERATION_OBSERVATION_FAILED'));
      interval = 5000;
    }
    if (!controller.signal.aborted) timer = setTimeout(poll, interval);
  };
  void poll();
  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}
