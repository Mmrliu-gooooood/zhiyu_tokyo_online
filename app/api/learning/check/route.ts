import { hostedAuthGate, withHostedProviderQuota } from '@/lib/auth/api';
import { NextRequest } from 'next/server';

import { LEARNING_CHECK_LIMITS } from '@/lib/learning/contracts';
import { isLearningChecksEnabled } from '@/lib/learning/feature-flags';
import {
  generateLearningCheck,
  LearningCheckRequestError,
  parseLearningCheckRequest,
} from '@/lib/server/learning/check';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getModelResolutionError } from '@/lib/server/resolve-model';

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
    if (bytes > LEARNING_CHECK_LIMITS.requestBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export async function POST(req: NextRequest) {
  return withHostedProviderQuota(req, () => handlePOST(req));
}

async function handlePOST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  if (!isLearningChecksEnabled()) {
    return apiError('PROVIDER_DISABLED', 404, 'Learning checks are not enabled');
  }
  try {
    const contentLength = Number(req.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > LEARNING_CHECK_LIMITS.requestBytes) {
      return apiError('INVALID_REQUEST', 413, 'Learning check request exceeds 128 KiB');
    }
    const raw = await readBoundedBody(req);
    if (raw === undefined) {
      return apiError('INVALID_REQUEST', 413, 'Learning check request exceeds 128 KiB');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError('INVALID_REQUEST', 400, 'Invalid learning check request');
    }
    const input = parseLearningCheckRequest(body);
    return apiSuccess({ ...(await generateLearningCheck(req, input)) });
  } catch (error) {
    if (error instanceof LearningCheckRequestError) {
      return apiError(
        error.code === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'GENERATION_FAILED',
        error.status,
        error.message,
      );
    }
    const resolution = getModelResolutionError(error);
    if (resolution) return apiError(resolution.code, resolution.httpStatus, resolution.message);
    if (req.signal.aborted)
      return apiError('GENERATION_FAILED', 499, 'Learning check request cancelled');
    return apiError('GENERATION_FAILED', 502, 'Failed to generate learning check');
  }
}
