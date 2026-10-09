/**
 * Memory in the two live classroom chat routes (learning plan B06, option A):
 * /api/chat (LangGraph director) and /api/chat/pi. Every speaking agent —
 * teacher, assistant, classmates — receives the student's explanation-style
 * preferences, read on the server for each request; facts, goals and
 * learning records stay out of the classroom.
 *
 * `body.learnerPreferences` is server-set only: any client value is discarded
 * before the directors run. A lookup that cannot run (signed out, feature
 * off, database unavailable) leaves it unset — Memory shapes how agents
 * explain, it never blocks a reply. The resolved state and item references
 * (never the text) are logged as the per-request evidence.
 */
import { parseOwnerUserId } from '@/lib/auth/principal';
import { resolveOptionalChatOwnerId, stageIdFromStoreState } from '@/lib/auth/stage-owner-gate';
import { createLogger } from '@/lib/logger';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { isStudyMemoryEnabled } from '@/lib/server/study/route';
import type { MemoryTurnInfo } from '@/lib/study/memory/contracts';
import type { StatelessChatRequest } from '@/lib/types/chat';

import { resolveClassroomMemoryContext, type ResolvedMemoryContext } from './context';

const log = createLogger('ClassroomMemory');

export interface ClassroomMemoryDeps {
  enabled: () => boolean;
  resolveOwnerId: (req: Request) => Promise<string | undefined>;
  resolve: (ownerId: string, stageId: string) => Promise<ResolvedMemoryContext>;
}

const defaultDeps: ClassroomMemoryDeps = {
  enabled: isStudyMemoryEnabled,
  resolveOwnerId: resolveOptionalChatOwnerId,
  resolve: async (ownerId, stageId) =>
    resolveClassroomMemoryContext(await getOwnerBoundStageAccessDb(ownerId), ownerId, stageId),
};

const UNAVAILABLE: MemoryTurnInfo = { state: 'unavailable', refs: [], tokens: 0 };

/** Sets `body.learnerPreferences` in place. Never throws. */
export async function applyClassroomMemory(
  req: Request,
  body: StatelessChatRequest,
  deps: ClassroomMemoryDeps = defaultDeps,
): Promise<MemoryTurnInfo> {
  delete body.learnerPreferences;
  const stageId = stageIdFromStoreState(body.storeState);
  if (!stageId || !deps.enabled()) return UNAVAILABLE;
  let memory: ResolvedMemoryContext;
  try {
    const ownerId = await deps.resolveOwnerId(req);
    if (!ownerId || !parseOwnerUserId(ownerId)) return UNAVAILABLE;
    memory = await deps.resolve(ownerId, stageId);
  } catch (error) {
    log.warn('classroom memory unavailable; answering without it', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return UNAVAILABLE;
  }
  if (memory.block) body.learnerPreferences = memory.block;
  log.info('classroom memory', memory.info);
  return memory.info;
}
