'use client';

/**
 * Browser client for after-class classmate chats (learning plan B05). Opening
 * a chat and posting a question go through the study APIs (which check the
 * classmate, space and hourly cap); the event stream and cancel are the
 * agent-session APIs.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import type { ClassmateView } from '@/lib/study/classmates/contracts';
import type { CompanionChatView, CompanionOrigin, CompanionPurpose } from './contracts';

const enc = encodeURIComponent;

export interface CompanionChatHeader {
  chat: {
    sessionId: string;
    spaceId: string;
    classmateId: string;
    purpose: CompanionPurpose;
    origin: CompanionOrigin | null;
    createdAt: string;
  };
  session: { id: string; status: string; title: string | null; error: string | null };
  classmate: ClassmateView;
  space: { id: string; name: string; subject: string | null; status: 'active' | 'archived' };
  materials: Array<{ id: string; title: string }>;
  originCourse: { stageId: string; title: string } | null;
}

/**
 * The session model connection for "inherit": the student's current Home
 * model, synced to an opaque reference (credentials never leave the owner
 * API). Undefined when no model is selected locally.
 */
export async function companionModelRef() {
  const [{ flushProModelRevocation, syncProModelConnection }, { getCurrentModelConfig }] =
    await Promise.all([
      import('@/lib/workbench/pro-model-connection-client'),
      import('@/lib/utils/model-config'),
    ]);
  await flushProModelRevocation();
  const config = getCurrentModelConfig();
  if (config.source !== 'platform' && (!config.providerId || !config.modelId)) return undefined;
  return syncProModelConnection(config);
}

export const companionApi = {
  list: (classmateId: string, spaceId?: string) =>
    studyRequest<{ chats: CompanionChatView[] }>(
      `/api/study/classmates/${enc(classmateId)}/chats${spaceId ? `?spaceId=${enc(spaceId)}` : ''}`,
    ).then((body) => body.chats),
  open: async (
    classmateId: string,
    input: { spaceId: string; question: string; discuss: string[]; origin: CompanionOrigin | null },
  ) =>
    studyRequest<{ sessionId: string }>(`/api/study/classmates/${enc(classmateId)}/chats`, {
      method: 'POST',
      json: { ...input, ...(await modelRefField()) },
    }),
  header: (sessionId: string) =>
    studyRequest<CompanionChatHeader>(`/api/study/companion-chats/${enc(sessionId)}`),
  post: async (sessionId: string, input: { text: string; discuss: string[] }) =>
    studyRequest<{ seq: number; delivery: string }>(
      `/api/study/companion-chats/${enc(sessionId)}/messages`,
      { method: 'POST', json: { ...input, ...(await modelRefField()) } },
    ),
  cancel: async (sessionId: string) => {
    const response = await fetch(`/api/agent/sessions/${enc(sessionId)}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });
    return response.ok;
  },
};

async function modelRefField(): Promise<{ modelRef?: unknown }> {
  try {
    const modelRef = await companionModelRef();
    return modelRef ? { modelRef } : {};
  } catch {
    // The server reports a missing model when the classmate inherits one.
    return {};
  }
}
