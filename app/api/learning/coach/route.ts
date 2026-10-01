import { hostedAuthGate, withHostedProviderQuota } from '@/lib/auth/api';
import { refuseForeignStagePost } from '@/lib/auth/stage-owner-gate';
import { NextRequest } from 'next/server';
import { isGuidedLearningEnabled } from '@/lib/learning/feature-flags';
import {
  parseGuidedLearningContext,
  type GuidedLearningOutcome,
} from '@/lib/learning/guided-contracts';
import { DEFAULT_AGENTS } from '@/lib/orchestration/registry/defaults';
import { apiError } from '@/lib/server/api-response';
import { isGuidedLearningContextCurrent } from '@/lib/learning/guided-current';
import type { Scene } from '@/lib/types/stage';
import {
  runGuidedCoach,
  validateGuidedSourceContext,
  type GuidedModelCall,
} from '@/lib/server/learning/coach';
import {
  gateway,
  getBindingResolutionError,
  resolveParamsBinding,
  userText,
} from '@/lib/model-gateway';

export const maxDuration = 100;
const GUIDED_LEARNING_REQUEST_BYTES = 128 * 1024;

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
    if (bytes > GUIDED_LEARNING_REQUEST_BYTES) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastStudentText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.parts)) continue;
    const text = message.parts
      .filter(isRecord)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    if (text) return text.slice(0, 4_000);
  }
  return undefined;
}

async function validatesCurrentSource(
  body: Record<string, unknown>,
  context: ReturnType<typeof parseGuidedLearningContext>,
): Promise<boolean> {
  if (body.sessionId !== context.chatSessionId || !isRecord(body.storeState)) return false;
  const stage = body.storeState.stage;
  if (!isRecord(stage) || stage.id !== context.stageId) return false;
  if (!validateGuidedSourceContext(context)) return false;
  if (context.source.kind !== 'scene') return true;
  if (
    typeof stage.name !== 'string' ||
    stage.name.trim().length === 0 ||
    !Array.isArray(body.storeState.scenes)
  ) {
    return false;
  }
  return isGuidedLearningContextCurrent(context, {
    stage: { id: context.stageId, name: stage.name },
    scenes: body.storeState.scenes as unknown as Scene[],
    currentSceneId:
      typeof body.storeState.currentSceneId === 'string'
        ? body.storeState.currentSceneId
        : undefined,
  });
}

function sseResponse(outcome: GuidedLearningOutcome): Response {
  const teacher = DEFAULT_AGENTS['default-1'];
  const reviewer = DEFAULT_AGENTS['default-2'];
  const teacherMessageId = `guided-${outcome.requestId}-teacher`;
  const reviewerMessageId = `guided-${outcome.requestId}-review`;
  const events = [
    {
      type: 'agent_start',
      data: {
        messageId: teacherMessageId,
        agentId: teacher.id,
        agentName: teacher.name,
        agentAvatar: teacher.avatar,
        agentColor: teacher.color,
      },
    },
    {
      type: 'text_delta',
      data: { messageId: teacherMessageId, content: outcome.published.explanation },
    },
    {
      type: 'agent_end',
      data: { messageId: teacherMessageId, agentId: teacher.id },
    },
    {
      type: 'agent_start',
      data: {
        messageId: reviewerMessageId,
        agentId: reviewer.id,
        agentName: reviewer.name,
        agentAvatar: reviewer.avatar,
        agentColor: reviewer.color,
      },
    },
    {
      type: 'text_delta',
      data: { messageId: reviewerMessageId, content: outcome.published.reviewNote },
    },
    {
      type: 'agent_end',
      data: { messageId: reviewerMessageId, agentId: reviewer.id },
    },
    {
      type: 'cue_user',
      data: {
        fromAgentId: teacher.id,
        ...(outcome.checkPrompt ? { prompt: outcome.checkPrompt } : {}),
      },
    },
    {
      type: 'done',
      data: {
        totalActions: 0,
        totalAgents: 2,
        agentHadContent: true,
        cueUserReceived: true,
        learningOutcome: outcome,
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function POST(req: NextRequest) {
  return withHostedProviderQuota(req, () => handlePOST(req));
}

async function handlePOST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  if (!isGuidedLearningEnabled()) {
    return apiError('INVALID_REQUEST', 404, 'Guided learning is not enabled');
  }

  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > GUIDED_LEARNING_REQUEST_BYTES) {
    return apiError('INVALID_REQUEST', 413, 'Guided learning request exceeds 128 KiB');
  }

  const rawBody = await readBoundedBody(req);
  if (rawBody === undefined) {
    return apiError('INVALID_REQUEST', 413, 'Guided learning request exceeds 128 KiB');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid guided learning request');
  }

  try {
    if (!isRecord(raw)) throw new Error('Invalid request body');
    const context = parseGuidedLearningContext(raw.learningContext);
    const deniedStage = await refuseForeignStagePost(req, context.stageId);
    if (deniedStage) return deniedStage;
    const prompt = lastStudentText(raw.messages);
    if (!prompt || !(await validatesCurrentSource(raw, context))) {
      throw new Error('Guided request context does not match the current session');
    }

    const binding = await resolveParamsBinding(
      {
        modelString: typeof raw.model === 'string' ? raw.model : undefined,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
        providerType: typeof raw.providerType === 'string' ? raw.providerType : undefined,
        source:
          raw.modelSource === 'platform' ||
          raw.modelSource === 'user' ||
          raw.modelSource === 'legacy-managed'
            ? raw.modelSource
            : undefined,
        platformDefaultId:
          typeof raw.platformDefaultId === 'string' ? raw.platformDefaultId : undefined,
        thinkingConfig: isRecord(raw.thinkingConfig) ? raw.thinkingConfig : undefined,
      },
      'chat-adapter',
    );

    const guidedCall: GuidedModelCall = async ({
      system,
      prompt: callPrompt,
      signal,
      maxOutputTokens,
    }) => {
      const result = await gateway.complete(
        binding,
        { system, messages: [userText(callPrompt)], maxOutputTokens },
        { source: 'learning-coach', signal, retry: 'none' },
      );
      return {
        text: result.text,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      };
    };

    const outcome = await runGuidedCoach(context, prompt, {
      callModel: guidedCall,
      signal: req.signal,
    });
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return sseResponse(outcome);
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const resolutionError = getBindingResolutionError(error);
    if (resolutionError) {
      return apiError(resolutionError.code, resolutionError.httpStatus, resolutionError.message);
    }
    const invalidRequest =
      error instanceof Error &&
      (error.message.startsWith('Invalid guided learning') ||
        error.message.includes('current session') ||
        error.message === 'Invalid request body');
    return invalidRequest
      ? apiError('INVALID_REQUEST', 400, 'Invalid guided learning request')
      : apiError('INTERNAL_ERROR', 500, 'Guided learning request failed');
  }
}
