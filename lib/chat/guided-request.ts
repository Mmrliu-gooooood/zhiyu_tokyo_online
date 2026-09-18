import type { StatelessEvent } from '@/lib/types/chat';
import {
  parseGuidedLearningOutcome,
  type GuidedLearningOutcome,
} from '@/lib/learning/guided-contracts';

export interface GuidedStreamConsumer {
  onEvent: (event: StatelessEvent) => void;
  onIterationEnd: () => Promise<{
    totalAgents: number;
    agentHadContent?: boolean;
    cueUserReceived?: boolean;
  } | null>;
}

export type GuidedStreamConsumerFactory = () => GuidedStreamConsumer;
export type GuidedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ALLOWED_EVENT_TYPES = new Set([
  'agent_start',
  'text_delta',
  'agent_end',
  'cue_user',
  'done',
  'error',
]);

function protocolError(detail: string): Error {
  return new Error(`Invalid guided stream: ${detail}`);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function awaitOrAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Consume one bounded guided-coach request. This deliberately has no retry
 * path: an incomplete or invalid stream cannot be replayed without risking a
 * duplicate published answer in the current chat session.
 */
export async function runGuidedSingleRequest(
  requestBody: Record<string, unknown>,
  controller: AbortController,
  createConsumer: GuidedStreamConsumerFactory,
  fetchFn: GuidedFetch = fetch,
  onResponseAccepted?: (response: Response) => void,
  isRequestCurrent: () => boolean = () => true,
): Promise<GuidedLearningOutcome> {
  const assertCurrent = () => {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!isRequestCurrent()) {
      const error = new DOMException('The guided request is no longer current.', 'AbortError');
      controller.abort(error);
      throw error;
    }
  };
  const consumer = createConsumer();
  const response = await awaitOrAbort(
    fetchFn('/api/learning/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }),
    controller.signal,
  );
  assertCurrent();
  if (!response.ok) {
    throw new Error(`Guided coach request failed: ${response.status}`);
  }
  if (!response.body) throw protocolError('missing response body');
  onResponseAccepted?.(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let activeMessageId: string | undefined;
  let hadContent = false;
  let cueCount = 0;
  let doneCount = 0;
  let outcome: GuidedLearningOutcome | undefined;
  const context = isRecord(requestBody.learningContext) ? requestBody.learningContext : undefined;
  const evidence = context && Array.isArray(context.evidence) ? context.evidence : [];
  const allowedEvidenceRefs = new Set(
    evidence
      .filter(isRecord)
      .map((item) => item.ref)
      .filter((ref): ref is string => typeof ref === 'string'),
  );

  const acceptEvent = (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !ALLOWED_EVENT_TYPES.has(raw.type)) {
      throw protocolError('forbidden event');
    }
    if (doneCount > 0) throw protocolError('event after done');
    if (!isRecord(raw.data)) throw protocolError('malformed event');

    switch (raw.type) {
      case 'agent_start': {
        if (
          cueCount > 0 ||
          activeMessageId ||
          typeof raw.data.messageId !== 'string' ||
          typeof raw.data.agentId !== 'string' ||
          typeof raw.data.agentName !== 'string'
        ) {
          throw protocolError('agent_start out of order');
        }
        activeMessageId = raw.data.messageId;
        break;
      }
      case 'text_delta': {
        if (
          cueCount > 0 ||
          !activeMessageId ||
          typeof raw.data.content !== 'string' ||
          (raw.data.messageId !== undefined && raw.data.messageId !== activeMessageId)
        ) {
          throw protocolError('text_delta out of order');
        }
        if (raw.data.content.length > 0) hadContent = true;
        break;
      }
      case 'agent_end': {
        if (
          cueCount > 0 ||
          !activeMessageId ||
          raw.data.messageId !== activeMessageId ||
          typeof raw.data.agentId !== 'string'
        ) {
          throw protocolError('agent_end out of order');
        }
        activeMessageId = undefined;
        break;
      }
      case 'cue_user': {
        cueCount += 1;
        if (cueCount !== 1 || activeMessageId || !hadContent) {
          throw protocolError('cue_user out of order');
        }
        break;
      }
      case 'done': {
        doneCount += 1;
        if (
          doneCount !== 1 ||
          cueCount !== 1 ||
          activeMessageId ||
          raw.data.agentHadContent !== true ||
          raw.data.cueUserReceived !== true
        ) {
          throw protocolError('done out of order');
        }
        outcome = parseGuidedLearningOutcome(raw.data.learningOutcome, allowedEvidenceRefs);
        break;
      }
      case 'error':
        throw new Error(
          typeof raw.data.message === 'string' ? raw.data.message : 'Guided coach failed',
        );
    }

    assertCurrent();
    consumer.onEvent(raw as StatelessEvent);
  };

  try {
    for (;;) {
      const { done, value } = await awaitOrAbort(reader.read(), controller.signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        const dataLines = part.split('\n').filter((line) => line.startsWith('data: '));
        if (dataLines.length !== 1) throw protocolError('malformed SSE frame');
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLines[0].slice(6));
        } catch {
          throw protocolError('malformed JSON');
        }
        acceptEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }

  assertCurrent();
  if (buffer.trim().length > 0 || cueCount !== 1 || doneCount !== 1 || !outcome) {
    throw protocolError('unexpected EOF');
  }

  const drained = await awaitOrAbort(consumer.onIterationEnd(), controller.signal);
  assertCurrent();
  if (
    !drained ||
    drained.agentHadContent !== true ||
    drained.cueUserReceived !== true ||
    drained.totalAgents < 1
  ) {
    throw protocolError('consumer did not confirm published turn');
  }
  return outcome;
}
