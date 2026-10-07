/**
 * Classmates' own live-answer models in the classroom (learning plan B05).
 *
 * A classroom keeps a classmate snapshot under `<classmateId>-r<revision>`.
 * Its model policy is read from the CURRENT template (application policy,
 * not persona), so changing it applies to the next live answer in every
 * classroom. Pre-generated lecture lines are untouched: they were written
 * with the course generation model.
 *
 * - inherit (default): the classmate answers with the request's model;
 * - custom and usable: that classmate's turns use its own binding;
 * - custom but unusable: the classmate is left out of this reply and the
 *   stream carries a notice. It is never answered with another model.
 *
 * Requests without classmate agents, signed-out callers and deployments with
 * after-class chats switched off never touch the database.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { parseOwnerUserId } from '@/lib/auth/principal';
import { resolveOptionalChatOwnerId } from '@/lib/auth/stage-owner-gate';
import { createLogger } from '@/lib/logger';
import { withThinking, type ModelBinding } from '@/lib/model-gateway';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { modelPolicyFromColumn } from '@/lib/server/study/classmates/repository';
import { isStudyCompanionChatFlagOn } from '@/lib/server/study/flags';
import { isStudySpacesEnabled } from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  parseClassmateStageAgentId,
  type ClassmateModelPolicy,
} from '@/lib/study/classmates/contracts';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

import { resolveClassmateModelChoice } from './model-policy';

const log = createLogger('ClassmateModels');

export interface ClassroomClassmateModels {
  agentBindings: Record<string, ModelBinding>;
  notices: Array<Extract<StatelessEvent, { type: 'notice' }>>;
  /** Every agent of the request was a classmate whose model is unavailable: answer nothing. */
  nothingToRun: boolean;
}

export interface ClassroomModelDeps {
  enabled: () => boolean;
  resolveOwnerId: (req: Request) => Promise<string | undefined>;
  readPolicies: (
    ownerId: string,
    classmateIds: string[],
  ) => Promise<Map<string, ClassmateModelPolicy>>;
  resolveChoice: typeof resolveClassmateModelChoice;
}

async function readPolicies(
  ownerId: string,
  classmateIds: string[],
): Promise<Map<string, ClassmateModelPolicy>> {
  const db = (await getOwnerBoundStageAccessDb(ownerId)) as Queryable;
  const result = await db.query<{ id: string; model_policy: unknown }>(
    'SELECT id, model_policy FROM study_classmates WHERE owner_id = $1 AND id = ANY($2::text[])',
    [ownerId, classmateIds],
  );
  return new Map(result.rows.map((row) => [row.id, modelPolicyFromColumn(row.model_policy)]));
}

const defaultDeps: ClassroomModelDeps = {
  enabled: () => isStudyCompanionChatFlagOn() && isStudySpacesEnabled(),
  resolveOwnerId: resolveOptionalChatOwnerId,
  readPolicies,
  resolveChoice: resolveClassmateModelChoice,
};

/**
 * Resolve the classmates' own models for one classroom chat request. Drops a
 * classmate whose model is unavailable from `body.config.agentIds` (in place);
 * when no agent is left the caller answers with the notices only.
 */
export async function resolveClassroomClassmateModels(
  req: Request,
  body: StatelessChatRequest,
  deps: ClassroomModelDeps = defaultDeps,
): Promise<ClassroomClassmateModels> {
  const empty: ClassroomClassmateModels = { agentBindings: {}, notices: [], nothingToRun: false };
  const refs = body.config.agentIds.flatMap((agentId) => {
    const ref = parseClassmateStageAgentId(agentId);
    return ref ? [{ agentId, classmateId: ref.classmateId }] : [];
  });
  if (refs.length === 0) return empty;
  let ownerId: string | undefined;
  let policies: Map<string, ClassmateModelPolicy>;
  try {
    if (!deps.enabled()) return empty;
    ownerId = await deps.resolveOwnerId(req);
    if (!ownerId || !parseOwnerUserId(ownerId)) return empty;
    policies = await deps.readPolicies(ownerId, [...new Set(refs.map((ref) => ref.classmateId))]);
  } catch (error) {
    log.warn('classmate model policies unavailable; classmates inherit the request model', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return empty;
  }
  const result: ClassroomClassmateModels = { agentBindings: {}, notices: [], nothingToRun: false };
  const dropped = new Set<string>();
  for (const ref of refs) {
    const policy = policies.get(ref.classmateId);
    if (!policy || policy.mode !== 'custom') continue;
    try {
      const binding = await deps.resolveChoice(ownerId, policy.model, 'chat-adapter');
      // Live chat defaults to no reasoning, like the request model.
      result.agentBindings[ref.agentId] = binding.thinking
        ? binding
        : withThinking(binding, { mode: 'disabled', enabled: false });
    } catch (error) {
      if (!(error instanceof StudyError)) throw error;
      dropped.add(ref.agentId);
      const name =
        body.config.agentConfigs?.find((agent) => agent.id === ref.agentId)?.name ?? ref.agentId;
      result.notices.push({
        type: 'notice',
        data: { code: 'CLASSMATE_MODEL_UNAVAILABLE', agentId: ref.agentId, agentName: name },
      });
    }
  }
  if (dropped.size > 0) {
    const remaining = body.config.agentIds.filter((agentId) => !dropped.has(agentId));
    if (remaining.length > 0) body.config.agentIds = remaining;
    else result.nothingToRun = true;
    if (body.config.addressedAgentId && dropped.has(body.config.addressedAgentId)) {
      delete body.config.addressedAgentId;
    }
  }
  return result;
}

/** An SSE reply carrying only the notices and an empty `done` (no agent could answer). */
export function noticeOnlyResponse(notices: ClassroomClassmateModels['notices']): Response {
  const events: StatelessEvent[] = [
    ...notices,
    { type: 'done', data: { totalActions: 0, totalAgents: 0, agentHadContent: false } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
