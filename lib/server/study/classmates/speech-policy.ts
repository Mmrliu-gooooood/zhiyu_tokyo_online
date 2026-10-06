/**
 * Server-side classmate rules for the two live classroom chat routes
 * (learning plan B04): /api/chat (LangGraph director) and /api/chat/pi.
 *
 * A classroom agent whose id is `<classmateId>-r<revision>` is a snapshot of
 * one of the caller's classmate templates. Its speaking rule and role are
 * read from that exact revision on the server — never from the request — and
 * applied before either director runs:
 * - an `on_demand` classmate the student did not name is removed from the
 *   request's agents;
 * - the classmate the student named is passed on as `addressedAgentId`;
 * - the classmate's role and allowed actions are reset from the snapshot, so
 *   neither the request nor the persona can widen what it may do.
 *
 * Requests without classmate agents never touch the database. A lookup that
 * cannot run (signed out, study features off, database unavailable) leaves
 * the request as the client sent it, minus any client-supplied
 * `addressedAgentId`: speaking rules shape the conversation, they are not an
 * access control.
 */
import { createLogger } from '@/lib/logger';
import { parseOwnerUserId } from '@/lib/auth/principal';
import { resolveOptionalChatOwnerId } from '@/lib/auth/stage-owner-gate';
import { getActionsForRole } from '@/lib/orchestration/registry/types';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { readClassmateRevisions } from '@/lib/server/study/classmates/repository';
import { isStudySpacesEnabled } from '@/lib/server/study/route';
import {
  parseClassmateStageAgentId,
  type ClassmateSnapshot,
  type ClassmateSpeechPolicy,
} from '@/lib/study/classmates/contracts';
import { lastUserText, planClassmateSpeech } from '@/lib/study/classmates/speech';
import type { StatelessChatRequest } from '@/lib/types/chat';

const log = createLogger('ClassmateSpeech');

export interface ClassmateSpeechDeps {
  resolveOwnerId: (req: Request) => Promise<string | undefined>;
  readRevisions: (
    ownerId: string,
    refs: Array<{ classmateId: string; revision: number }>,
  ) => Promise<Map<string, ClassmateSnapshot>>;
  enabled: () => boolean;
}

const defaultDeps: ClassmateSpeechDeps = {
  resolveOwnerId: resolveOptionalChatOwnerId,
  readRevisions: async (ownerId, refs) =>
    readClassmateRevisions(await getOwnerBoundStageAccessDb(ownerId), ownerId, refs),
  enabled: isStudySpacesEnabled,
};

/** Mutates `body.config` in place. Never throws. */
export async function applyClassmateSpeechRules(
  req: Request,
  body: StatelessChatRequest,
  deps: ClassmateSpeechDeps = defaultDeps,
): Promise<void> {
  const config = body.config;
  delete config.addressedAgentId;
  const refs = config.agentIds
    .map((id) => ({ id, ref: parseClassmateStageAgentId(id) }))
    .filter((entry): entry is { id: string; ref: { classmateId: string; revision: number } } =>
      Boolean(entry.ref),
    );
  if (refs.length === 0) return;
  let snapshots: Map<string, ClassmateSnapshot>;
  try {
    if (!deps.enabled()) return;
    const ownerId = await deps.resolveOwnerId(req);
    if (!ownerId || !parseOwnerUserId(ownerId)) return;
    snapshots = await deps.readRevisions(
      ownerId,
      refs.map((entry) => entry.ref),
    );
  } catch (error) {
    log.warn('classmate rules unavailable; using the request roster as sent', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return;
  }
  if (snapshots.size === 0) return;

  const policies = new Map<string, ClassmateSpeechPolicy>();
  for (const [agentId, snapshot] of snapshots) policies.set(agentId, snapshot.speechPolicy);
  for (const agentConfig of config.agentConfigs ?? []) {
    const snapshot = snapshots.get(agentConfig.id);
    if (!snapshot) continue;
    agentConfig.role = snapshot.role;
    agentConfig.allowedActions = getActionsForRole(snapshot.role);
  }

  const names = new Map((config.agentConfigs ?? []).map((agent) => [agent.id, agent]));
  const plan = planClassmateSpeech({
    agents: config.agentIds.map((id) => ({
      id,
      name: snapshots.get(id)?.name ?? names.get(id)?.name ?? '',
      role: snapshots.get(id)?.role ?? names.get(id)?.role ?? '',
    })),
    policies,
    userText: lastUserText(body.messages),
    triggerAgentId: config.triggerAgentId,
  });
  config.agentIds = plan.agentIds;
  if (plan.addressedAgentId) config.addressedAgentId = plan.addressedAgentId;
}
