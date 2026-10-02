import { requirePrincipalIfHosted } from '@/lib/auth/api';
import { withProviderQuotaOwner } from '@/lib/server/generation-jobs/provider-call-context';
import { refuseForeignStagePost } from '@/lib/auth/stage-owner-gate';
import { NextRequest, NextResponse } from 'next/server';
import { isTeachBackEnabled } from '@/lib/learning/feature-flags';
import {
  parseTeachBackApiInput,
  TEACH_BACK_LIMITS,
  type TeachBackErrorCode,
} from '@/lib/learning/teach-back/contracts';
import {
  runTeachBackEvaluate,
  runTeachBackPrepare,
  TeachBackModelError,
} from '@/lib/server/learning/teach-back';
import {
  gateway,
  getBindingResolutionError,
  modelParamsFromBody,
  resolveParamsBinding,
  userText,
} from '@/lib/model-gateway';

export const maxDuration = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResponse(code: TeachBackErrorCode, status: number, error: string) {
  return NextResponse.json({ success: false, code, error }, { status });
}

async function readBoundedBody(req: NextRequest): Promise<string | undefined> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > TEACH_BACK_LIMITS.requestBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export async function POST(req: NextRequest) {
  const principal = await requirePrincipalIfHosted(req);
  if (principal instanceof Response) return principal;
  if (!isTeachBackEnabled()) {
    return errorResponse('feature_disabled', 404, 'Teach-back is not enabled');
  }

  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > TEACH_BACK_LIMITS.requestBytes) {
    return errorResponse('invalid_request', 413, 'Teach-back request exceeds 128 KiB');
  }

  const rawBody = await readBoundedBody(req);
  if (rawBody === undefined) {
    return errorResponse('invalid_request', 413, 'Teach-back request exceeds 128 KiB');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return errorResponse('invalid_request', 400, 'Invalid teach-back request');
  }

  try {
    if (!isRecord(raw)) throw new Error('Invalid request body');
    const input = parseTeachBackApiInput(raw.learning);
    const deniedStage = await refuseForeignStagePost(req, input.source.stageId);
    if (deniedStage) return deniedStage;
    const binding = await resolveParamsBinding(modelParamsFromBody(raw), 'chat-adapter');

    const callModel = async ({
      system,
      prompt,
      signal,
      maxOutputTokens,
    }: {
      system: string;
      prompt: string;
      signal: AbortSignal;
      maxRetries: 0;
      maxOutputTokens: number;
    }) => {
      const work = () =>
        gateway.complete(
          binding,
          { system, messages: [userText(prompt)], maxOutputTokens },
          { source: 'learning-teach-back', signal, retry: 'none' },
        );
      const result = await (principal ? withProviderQuotaOwner(principal.ownerId, work) : work());
      return { text: result.text };
    };

    const output =
      input.operation === 'prepare'
        ? await runTeachBackPrepare(input, input.peer, { callModel, signal: req.signal })
        : await runTeachBackEvaluate(input, { callModel, signal: req.signal });

    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return NextResponse.json({ success: true, ...output });
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (error instanceof TeachBackModelError) {
      const status =
        error.code === 'insufficient_source'
          ? 422
          : error.code === 'invalid_output'
            ? 422
            : error.code === 'timeout'
              ? 504
              : error.code === 'model_unavailable'
                ? 503
                : 400;
      return errorResponse(error.code, status, error.message);
    }
    const resolutionError = getBindingResolutionError(error);
    if (resolutionError) {
      return errorResponse(
        'model_unavailable',
        resolutionError.httpStatus,
        resolutionError.message,
      );
    }
    const invalid =
      error instanceof Error &&
      (error.message.startsWith('Invalid teach-back') ||
        error.message.includes('Teach-back') ||
        error.message === 'Invalid request body');
    return invalid
      ? errorResponse('invalid_request', 400, 'Invalid teach-back request')
      : errorResponse('model_unavailable', 500, 'Teach-back request failed');
  }
}
