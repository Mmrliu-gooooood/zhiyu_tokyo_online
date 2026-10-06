'use client';

/**
 * Browser client for classmate templates (learning plan B04), plus the
 * projection of the signed-in student's active templates into the in-memory
 * agent registry, where the home roster picker and the generators find them.
 *
 * Projections are memory-only (never in the device-wide localStorage
 * snapshot) and belong to one account: a sync for another account first
 * removes the previous account's projections.
 */
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { getActionsForRole, type AgentConfig } from '@/lib/orchestration/registry/types';
import { fetchStudyCapabilities, studyRequest } from '@/lib/study/spaces/client';
import {
  CLASSMATE_COLORS,
  CLASSMATE_PRESET_AVATARS,
  composeClassmatePersona,
  type ClassmateInput,
  type ClassmatePatch,
  type ClassmateStatus,
  type ClassmateView,
} from '@/lib/study/classmates/contracts';

const enc = encodeURIComponent;

export const classmateApi = {
  list: (status?: ClassmateStatus) =>
    studyRequest<{ classmates: ClassmateView[] }>(
      `/api/study/classmates${status ? `?status=${status}` : ''}`,
    ).then((body) => body.classmates),
  get: (classmateId: string) =>
    studyRequest<{ classmate: ClassmateView }>(`/api/study/classmates/${enc(classmateId)}`).then(
      (body) => body.classmate,
    ),
  create: (input: ClassmateInput) =>
    studyRequest<{ classmate: ClassmateView }>('/api/study/classmates', {
      method: 'POST',
      json: input,
    }).then((body) => body.classmate),
  update: (classmateId: string, revision: number, patch: ClassmatePatch) =>
    studyRequest<{ classmate: ClassmateView }>(`/api/study/classmates/${enc(classmateId)}`, {
      method: 'PATCH',
      json: { ...patch, revision },
    }).then((body) => body.classmate),
  importLocal: (items: ClassmateInput[]) =>
    studyRequest<{ created: ClassmateView[]; skipped: number }>('/api/study/classmates/import', {
      method: 'POST',
      json: { items },
    }),
  uploadAvatar: (blob: Blob) =>
    studyRequest<{ id: string; avatar: string }>('/api/study/classmates/avatars', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    }),
};

// ── registry projection ────────────────────────────────────────────────────

let projectedFor: string | null = null;
let syncing: Promise<void> | null = null;

/** The registry entry the home picker shows for a template's current revision. */
export function classmateProjection(classmate: ClassmateView): AgentConfig {
  const now = new Date(classmate.updatedAt);
  return {
    id: classmate.id,
    name: classmate.name,
    role: classmate.role,
    persona: composeClassmatePersona(classmate),
    avatar: classmate.avatar,
    color: classmate.color,
    allowedActions: getActionsForRole(classmate.role),
    priority: classmate.role === 'assistant' ? 7 : 5,
    ...(classmate.voice ? { voiceConfig: classmate.voice as AgentConfig['voiceConfig'] } : {}),
    createdAt: new Date(classmate.createdAt),
    updatedAt: now,
    isDefault: false,
    classmate: { id: classmate.id, revision: classmate.revision },
  };
}

/** Replace the registry's classmate projections with `classmates` (active ones only). */
export function projectClassmates(classmates: ClassmateView[]): void {
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.classmate) registry.deleteAgent(agent.id);
  }
  for (const classmate of classmates) {
    if (classmate.status === 'active') registry.addAgent(classmateProjection(classmate));
  }
}

/**
 * Load the signed-in student's classmates into the registry. Signed out or
 * feature off: any projection is removed. Never throws; concurrent calls share one load.
 */
export function syncClassmateRegistry(options: { force?: boolean } = {}): Promise<void> {
  syncing ??= (async () => {
    const userId = peekAccountUserId();
    if (!userId) {
      projectClassmates([]);
      projectedFor = null;
      return;
    }
    if (projectedFor === userId && !options.force) return;
    if (projectedFor !== userId) projectClassmates([]);
    try {
      if (!(await fetchStudyCapabilities()).classmates) return;
      projectClassmates(await classmateApi.list('active'));
      projectedFor = userId;
    } catch {
      // The picker simply shows no classmates; the next sync retries.
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// ── device-local roles from before templates lived on the server ───────────

/** Custom roles saved in this browser that can become templates (teachers stay local). */
export function localRolesToImport(): ClassmateInput[] {
  return useAgentRegistry
    .getState()
    .listAgents()
    .filter(
      (agent) =>
        !agent.isDefault &&
        !agent.isGenerated &&
        !agent.classmate &&
        !agent.id.startsWith('default-') &&
        (agent.role === 'assistant' || agent.role === 'student'),
    )
    .map((agent, index) => ({
      name: Array.from(agent.name.trim() || 'Classmate')
        .slice(0, 40)
        .join(''),
      role: agent.role as ClassmateInput['role'],
      persona: Array.from(agent.persona.trim()).slice(0, 2000).join(''),
      learningStyle: 'peer',
      speechPolicy: 'active',
      avatar: (CLASSMATE_PRESET_AVATARS as readonly string[]).includes(agent.avatar)
        ? agent.avatar
        : CLASSMATE_PRESET_AVATARS[index % CLASSMATE_PRESET_AVATARS.length]!,
      color: /^#[0-9a-fA-F]{6}$/.test(agent.color)
        ? agent.color.toLowerCase()
        : CLASSMATE_COLORS[index % CLASSMATE_COLORS.length]!,
      voice: null,
      materialIds: [],
    }));
}
