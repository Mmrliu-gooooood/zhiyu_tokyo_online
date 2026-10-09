/**
 * After-class classmate chats inside the agent runner (learning plan B05).
 *
 * A session with a `study_companion_chats` row is not a Pro session: the
 * runner keeps its durable lifecycle (claim, events, entry tree, resume,
 * cancel, settle) but replaces the model, the system prompt, the toolset and
 * the history view with the ones prepared here. Everything is resolved again
 * for every run, and the runner gives each user message its own run (no
 * mid-run steering), so every turn sees the classmate's current revision,
 * material authorisation and model policy.
 *
 * A companion session never falls back to the Pro toolset: when the feature
 * is off, the classmate or space is archived, or the classmate's own model is
 * unavailable, the run fails with a fixed code the chat page explains.
 */
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Queryable } from '@openmaic/storage/document/pg';

import { gateway, userText, type ModelBinding } from '@/lib/model-gateway';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { getGenerationPool } from '@/lib/server/generation-jobs/runtime';
import { getClassmate } from '@/lib/server/study/classmates/repository';
import { searchStudyKnowledge } from '@/lib/server/study/knowledge/repository';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';
import { isStudyCompanionChatFlagOn } from '@/lib/server/study/flags';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  companionHistoryView,
  companionPersonaKey,
  companionSystemPrompt,
} from '@/lib/server/study/companion/context';
import {
  classmateModelLabel,
  resolveClassmateModelChoice,
} from '@/lib/server/study/companion/model-policy';
import { getCompanionChat, type CompanionChatRow } from '@/lib/server/study/companion/repository';
import { buildCompanionTools } from '@/lib/server/study/companion/tools';
import { resolveMemoryContext } from '@/lib/server/study/memory/context';
import {
  companionMaterials,
  companionScope,
  resolveCompanionTurn,
} from '@/lib/server/study/companion/turn';
import { getReplyPolicy } from '@/lib/chat/reply-policy';
import { composeClassmatePersona } from '@/lib/study/classmates/contracts';
import {
  COMPANION_LIMITS,
  decodeCompanionMessage,
  type CompanionExcerpt,
  type CompanionInviteDetails,
  type CompanionTurnInfo,
} from '@/lib/study/companion/contracts';
import type { Scene } from '@/lib/types/stage';
import type { ProModelContext } from '@/types/pro-model';

import { buildPiDriverModel, resolveAgentDriverModel } from './agent-driver-model';
import type { CourseStore } from './course-tools';
import { probeStageAccess } from './curriculum-tools';
import { textScene } from './dsl-tools';

export class CompanionRunError extends Error {
  constructor(readonly code: string) {
    super(`${code}: this after-class chat cannot continue`);
    this.name = 'CompanionRunError';
  }
}

function workerDb(): Queryable {
  return getGenerationPool() as unknown as Queryable;
}

/** The chat binding of a claimed session, or null for a Pro session. */
export async function loadCompanionChat(
  ownerId: string,
  sessionId: string,
  db?: Queryable,
): Promise<CompanionChatRow | null> {
  let queryable: Queryable;
  try {
    queryable = db ?? workerDb();
  } catch {
    // No generation database: chats are created in that database, so none exist.
    return null;
  }
  try {
    return await getCompanionChat(queryable, ownerId, sessionId);
  } catch (error) {
    // Before v26 the table does not exist: every session is a Pro session.
    if ((error as { code?: string }).code === '42P01') return null;
    throw error;
  }
}

export interface CompanionDriver {
  binding: ModelBinding;
  piModel: ReturnType<typeof buildPiDriverModel>;
  wireMaxOutputTokens?: number;
}

export interface CompanionRun {
  systemPrompt: string;
  tools: AgentTool[];
  toolNames: Set<string>;
  history: AgentMessage[];
  driver: CompanionDriver;
  beforeCall?: () => Promise<void>;
  turnInfo: CompanionTurnInfo;
  /** The text the model receives for the delivered message (options stripped). */
  deliveredText: string;
}

export interface PrepareCompanionRunInput {
  chat: CompanionChatRow;
  ownerId: string;
  sessionId: string;
  /** Durable history (already resume-repaired). */
  historyMessages: readonly AgentMessage[];
  /** The raw text of the message this run delivers ('' on a crash resume). */
  turnText: string;
  /** The session's model connection (inherit mode). */
  modelContext?: ProModelContext;
  /** Opens the owner-bound document store (only when a course is read). */
  store: () => Promise<CourseStore>;
  db?: Queryable;
}

function driverOf(binding: ModelBinding): CompanionDriver {
  const wireMaxOutputTokens = binding.capabilities.knownModel
    ? binding.capabilities.maxOutputTokens
    : undefined;
  return { binding, piModel: buildPiDriverModel(binding), wireMaxOutputTokens };
}

function studyCode(error: unknown): string | null {
  return error instanceof StudyError ? error.code : null;
}

export async function prepareCompanionRun(input: PrepareCompanionRunInput): Promise<CompanionRun> {
  if (!isStudyCompanionChatFlagOn()) throw new CompanionRunError('STUDY_COMPANION_UNAVAILABLE');
  const db = input.db ?? workerDb();
  const { ownerId, chat } = input;
  let turn;
  try {
    turn = await resolveCompanionTurn(db, ownerId, chat);
  } catch (error) {
    const code = studyCode(error);
    if (code) throw new CompanionRunError(code);
    throw error;
  }

  // ── model ──────────────────────────────────────────────────────────────
  let inherited: CompanionDriver | undefined;
  const inheritedDriver = async (): Promise<CompanionDriver> => {
    if (!inherited) {
      const resolved = await resolveAgentDriverModel(input.modelContext, 'study-companion');
      if (!resolved.binding.credentialReady) {
        throw new Error('PRO_MODEL_CONFIGURATION_REQUIRED: model credential is not configured');
      }
      inherited = {
        binding: resolved.binding,
        piModel: resolved.piModel,
        wireMaxOutputTokens: resolved.wireMaxOutputTokens,
      };
    }
    return inherited;
  };
  let driver: CompanionDriver;
  const policy = turn.classmate.modelPolicy;
  if (policy.mode === 'custom') {
    try {
      driver = driverOf(
        await resolveClassmateModelChoice(ownerId, policy.model, 'study-companion', {
          requireTools: true,
        }),
      );
    } catch (error) {
      const code = studyCode(error);
      if (code === 'STUDY_CLASSMATE_MODEL_UNAVAILABLE') {
        const reason = (error as StudyError).details?.reason;
        throw new CompanionRunError(`STUDY_CLASSMATE_MODEL_UNAVAILABLE:${String(reason ?? '')}`);
      }
      throw error;
    }
  } else {
    driver = await inheritedDriver();
  }

  // ── Memory (B06): the same owner Memory for every classmate, this subject ─
  const memory = await resolveMemoryContext(db, ownerId, chat.spaceId);

  // ── history and refs ───────────────────────────────────────────────────
  const view = companionHistoryView(input.historyMessages, turn.allowedMaterialIds);
  const excerpts = new Map(view.excerpts);
  let lastRef = view.lastRef;

  // ── per-message options (discussion) ───────────────────────────────────
  const decoded = decodeCompanionMessage(input.turnText);
  const policyTurns = getReplyPolicy([{ role: 'user', content: decoded.text }], {}).maxTurns;
  const inviteBudget = Math.max(0, Math.min(COMPANION_LIMITS.discussionInvites, policyTurns - 1));
  const candidates: Array<{ classmateId: string; name: string }> = [];
  if (inviteBudget > 0) {
    for (const classmateId of decoded.options.discuss) {
      if (classmateId === chat.classmateId) continue;
      try {
        const other = await getClassmate(db, ownerId, classmateId);
        if (other.status === 'active') candidates.push({ classmateId, name: other.name });
      } catch (error) {
        if (!studyCode(error)) throw error;
      }
    }
  }

  // ── course access ──────────────────────────────────────────────────────
  let courseList: Array<{ stageId: string; title: string; origin: boolean }> | undefined;
  const courses = async () => {
    if (courseList) return courseList;
    const linked = await db.query<{ stage_id: string }>(
      `SELECT stage_id FROM study_space_courses WHERE owner_id = $1 AND space_id = $2
        ORDER BY added_at DESC LIMIT 30`,
      [ownerId, chat.spaceId],
    );
    const ids = [
      ...(chat.origin?.stageId ? [chat.origin.stageId] : []),
      ...linked.rows.map((row) => row.stage_id),
    ];
    const list: Array<{ stageId: string; title: string; origin: boolean }> = [];
    for (const stageId of [...new Set(ids)]) {
      const access = await probeStageAccess(ownerId, stageId).catch(() => null);
      if (access?.kind === 'owned') {
        list.push({
          stageId,
          title: access.stage.name,
          origin: stageId === chat.origin?.stageId,
        });
      }
    }
    courseList = list;
    return list;
  };
  const readCourse = async (stageId: string, sceneId: string | undefined) => {
    const document = await (await input.store()).loadDocument(stageId);
    if (!document) return null;
    const title = (document.stage as { name?: string }).name ?? stageId;
    const scenes = [...((document.scenes ?? []) as Scene[])].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    if (!sceneId) {
      return {
        kind: 'outline' as const,
        title,
        scenes: scenes.map((scene) => ({ id: scene.id, title: scene.title })),
      };
    }
    const scene = scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) return null;
    return {
      kind: 'scene' as const,
      title,
      sceneTitle: scene.title,
      text: textScene(scene).combinedText,
    };
  };

  const readArtifact = async (
    versionId: string,
    artifactId: string,
  ): Promise<StoredArtifactDocument | null> => {
    const row = await db.query<{ artifact_key: string | null }>(
      `SELECT artifact_key FROM study_material_artifacts
        WHERE owner_id = $1 AND version_id = $2 AND id = $3`,
      [ownerId, versionId, artifactId],
    );
    const key = row.rows[0]?.artifact_key;
    if (!key) return null;
    try {
      const bytes = await getMaterialByteStore().get(key);
      return JSON.parse(bytes.toString('utf8')) as StoredArtifactDocument;
    } catch {
      return null;
    }
  };

  const resolveScopeFor = async (classmateId: string) => {
    const materials = await companionMaterials(db, ownerId, chat.spaceId, classmateId);
    const allowedMaterialIds = new Set(materials.map((material) => material.id));
    const { scope, retrieval } = await companionScope(
      db,
      ownerId,
      chat.spaceId,
      allowedMaterialIds,
    );
    return { allowedMaterialIds, scope, retrieval, materials };
  };

  const nextRef = () => `M${++lastRef}`;

  // ── invited classmates (one reply each, their own persona/scope/model) ─
  const runInvite = async (
    classmateId: string,
    request: string,
    signal?: AbortSignal,
  ): Promise<CompanionInviteDetails> => {
    const other = await getClassmate(db, ownerId, classmateId);
    const base = {
      kind: 'study-companion-invite' as const,
      classmateId,
      revision: other.revision,
      name: other.name,
      avatar: other.avatar,
      color: other.color,
      reply: '',
      excerpts: [] as CompanionExcerpt[],
    };
    if (other.status !== 'active')
      return { ...base, error: `${other.name} 已归档，无法参与讨论。` };
    let binding: ModelBinding;
    try {
      binding =
        other.modelPolicy.mode === 'custom'
          ? await resolveClassmateModelChoice(ownerId, other.modelPolicy.model, 'study-companion')
          : (await inheritedDriver()).binding;
    } catch (error) {
      if (studyCode(error) === 'STUDY_CLASSMATE_MODEL_UNAVAILABLE') {
        return { ...base, error: `${other.name} 的独立模型当前不可用，本次没有发言。` };
      }
      throw error;
    }
    const scope = await resolveScopeFor(classmateId);
    const hits =
      scope.retrieval === 'keyword' && scope.scope.length
        ? await searchStudyKnowledge(
            db,
            ownerId,
            scope.scope,
            questionTerms(`${decoded.text} ${request}`),
            null,
            4,
          )
        : [];
    const found = hits
      .filter((hit) => scope.allowedMaterialIds.has(hit.index.materialId))
      .map(
        (hit): CompanionExcerpt => ({
          ref: nextRef(),
          materialId: hit.index.materialId,
          versionId: hit.index.versionId,
          versionNo: hit.index.versionNo,
          artifactId: hit.index.artifactId,
          title: hit.index.title,
          page: hit.pageNumber,
          blockId: hit.blockId,
          text: Array.from(hit.text.replace(/\s+/gu, ' ').trim())
            .slice(0, COMPANION_LIMITS.excerptChars)
            .join(''),
        }),
      );
    const system = [
      `你是「${other.name}」，学生课后学习讨论里被邀请的${other.role === 'assistant' ? '助教' : '同学'}。`,
      composeClassmatePersona(other),
      '只补充一个和主回答不同的要点，两三句话，用学生使用的语言。',
      memory.block,
      found.length
        ? '可以引用下面你被授权的资料片段，在句末标注编号（如 [M3]）；没有用到就不要标注。'
        : '你没有找到可引用的资料：只能用自己的知识，并说明是补充。',
    ]
      .filter(Boolean)
      .join('\n');
    const prompt = [
      `学生的问题：${decoded.text}`,
      `主学伴请你补充：${request}`,
      ...found.map((excerpt) => `[${excerpt.ref}] 《${excerpt.title}》\n${excerpt.text}`),
    ].join('\n\n');
    const result = await gateway.complete(
      binding,
      { system, messages: [userText(prompt)], maxOutputTokens: 600, temperature: 0.5 },
      {
        source: 'study-companion',
        signal,
        ownerId,
        usage: {
          requestId: `${input.sessionId}:invite`,
          eventKey: `${input.sessionId}:invite:${classmateId}:${Date.now()}`,
        },
      },
    );
    const reply = result.text.trim();
    const cited = new Set([...reply.matchAll(/\[(M\d+)\]/gu)].map((match) => match[1]!));
    const used = found.filter((excerpt) => cited.has(excerpt.ref));
    used.forEach((excerpt) => excerpts.set(excerpt.ref, excerpt));
    return { ...base, reply, excerpts: used };
  };

  const tools = buildCompanionTools({
    resolveScope: async () => resolveScopeFor(chat.classmateId),
    search: (scope, terms, k) => searchStudyKnowledge(db, ownerId, scope, terms, null, k),
    readArtifact,
    knownExcerpt: (ref) => excerpts.get(ref),
    nextRef,
    remember: (excerpt) => excerpts.set(excerpt.ref, excerpt),
    courses,
    readCourse,
    ...(candidates.length
      ? {
          invite: {
            candidates,
            maxCalls: Math.min(inviteBudget, candidates.length),
            run: runInvite,
          },
        }
      : {}),
  }) as unknown as AgentTool[];

  // ── prompt ─────────────────────────────────────────────────────────────
  let originTitles: { courseTitle?: string; sceneTitle?: string } = {};
  if (chat.origin?.stageId) {
    const access = await probeStageAccess(ownerId, chat.origin.stageId).catch(() => null);
    if (access?.kind === 'owned') {
      originTitles = { courseTitle: access.stage.name };
      if (chat.origin.sceneId) {
        const scene = (await (await input.store())
          .getScene(chat.origin.stageId, chat.origin.sceneId)
          .catch(() => null)) as Scene | null;
        if (scene) originTitles.sceneTitle = scene.title;
      }
    }
  }
  const systemPrompt = companionSystemPrompt({
    snapshot: turn.snapshot,
    spaceName: turn.space.name,
    subject: turn.space.subject,
    materials: turn.materials,
    retrieval: turn.retrieval,
    origin: chat.origin ? { ...chat.origin, ...originTitles } : null,
    discussing: candidates,
    withheldCount: view.withheldMaterialIds.length,
    memoryBlock: memory.block,
  });

  const turnInfo: CompanionTurnInfo = {
    classmateId: chat.classmateId,
    revision: turn.classmate.revision,
    personaKey: companionPersonaKey(turn.snapshot),
    name: turn.snapshot.name,
    avatar: turn.snapshot.avatar,
    color: turn.snapshot.color,
    status: turn.classmate.status,
    spaceId: chat.spaceId,
    materials: turn.materials,
    withheldMaterialIds: view.withheldMaterialIds,
    retrieval: turn.retrieval,
    model:
      policy.mode === 'custom'
        ? { mode: 'custom', label: classmateModelLabel(policy.model) }
        : { mode: 'inherit', label: driver.binding.modelString },
    discuss: candidates,
    memory: memory.info,
  };

  return {
    systemPrompt,
    tools,
    toolNames: new Set(tools.map((tool) => tool.name)),
    history: view.messages,
    driver,
    beforeCall: policy.mode === 'custom' ? undefined : input.modelContext?.assertActive,
    turnInfo,
    deliveredText: decoded.text,
  };
}
