/**
 * The after-class chat toolset (learning plan B05). It is the whole toolset
 * of a companion run — none of the Pro tools (course writes, web fetch,
 * skill editing, generation jobs) are registered next to it.
 *
 * - search_materials: keyword search over the materials this classmate may
 *   use in this space. The scope is re-resolved on every call, so a material
 *   removed mid-run is not searched again.
 * - read_material: more of the original text around a returned excerpt (or
 *   one page), re-checking authorisation on every call.
 * - list_space_courses / read_course_page: read-only access to the courses
 *   of this space and the classroom the chat was opened from, loaded on
 *   demand instead of pasting a course into the prompt.
 * - invite_classmate: only registered for a turn where the student chose
 *   classmates to join the discussion; capped by the reply-turn policy.
 *
 * Every material result keeps its excerpts in `details` and renders its
 * model-visible text from them (see `renderMaterialResult`), so later runs
 * can withhold excerpts whose material is no longer authorised.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import type { ScopedIndex, StudySearchHit } from '@/lib/server/study/knowledge/repository';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';
import {
  COMPANION_LIMITS,
  COMPANION_TOOL_NAMES,
  renderInviteResult,
  renderMaterialResult,
  type CompanionExcerpt,
  type CompanionInviteDetails,
  type CompanionMaterialDetails,
} from '@/lib/study/companion/contracts';

export interface CompanionScopeSnapshot {
  allowedMaterialIds: ReadonlySet<string>;
  scope: readonly ScopedIndex[];
  retrieval: 'keyword' | 'unavailable';
}

export interface CompanionInviteCandidate {
  classmateId: string;
  name: string;
}

export interface CompanionToolDeps {
  /** Fresh authorisation and index scope (called on every material tool call). */
  resolveScope(): Promise<CompanionScopeSnapshot>;
  search(scope: readonly ScopedIndex[], terms: string[], k: number): Promise<StudySearchHit[]>;
  /** The parse artifact of one version (the caller already checked the material is allowed). */
  readArtifact(versionId: string, artifactId: string): Promise<StoredArtifactDocument | null>;
  /** Excerpts earlier turns returned, by ref, so read_material can continue from them. */
  knownExcerpt(ref: string): CompanionExcerpt | undefined;
  /** Next citation ref (M1, M2, …), unique across the conversation. */
  nextRef(): string;
  remember(excerpt: CompanionExcerpt): void;
  /** Courses this chat may read: the classroom it came from plus the space's courses. */
  courses(): Promise<Array<{ stageId: string; title: string; origin: boolean }>>;
  readCourse(
    stageId: string,
    sceneId: string | undefined,
  ): Promise<
    | { kind: 'outline'; title: string; scenes: Array<{ id: string; title: string }> }
    | { kind: 'scene'; title: string; sceneTitle: string; text: string }
    | null
  >;
  invite?: {
    candidates: readonly CompanionInviteCandidate[];
    maxCalls: number;
    run(
      classmateId: string,
      request: string,
      signal?: AbortSignal,
    ): Promise<CompanionInviteDetails>;
  };
}

function textResult<T>(text: string, details: T) {
  return { content: [{ type: 'text' as const, text }], details };
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

const SearchParams = Type.Object({
  query: Type.String({
    description:
      'Keywords or a short question in the language of the materials (e.g. "定积分 换元法"). Keyword matching, not semantic search: use the specific terms the material would contain.',
    minLength: 1,
    maxLength: 200,
  }),
});

const ReadParams = Type.Object({
  ref: Type.Optional(
    Type.String({ description: 'An excerpt ref returned earlier, e.g. "M3": reads around it.' }),
  ),
  materialId: Type.Optional(Type.String({ description: 'Material id (with page) when no ref.' })),
  page: Type.Optional(Type.Integer({ minimum: 1, description: 'Page number to read.' })),
});

const CourseParams = Type.Object({
  stageId: Type.String({ description: 'Course id from list_space_courses.' }),
  sceneId: Type.Optional(
    Type.String({ description: 'Page (scene) id; omit to get the course outline.' }),
  ),
});

const InviteParams = Type.Object({
  classmateId: Type.String({ description: 'One of the invited classmates.' }),
  request: Type.String({
    description: 'What you ask this classmate to add, in one or two sentences.',
    minLength: 1,
    maxLength: 400,
  }),
});

function excerptOf(ref: string, hit: StudySearchHit): CompanionExcerpt {
  return {
    ref,
    materialId: hit.index.materialId,
    versionId: hit.index.versionId,
    versionNo: hit.index.versionNo,
    artifactId: hit.index.artifactId,
    title: hit.index.title,
    page: hit.pageNumber,
    blockId: hit.blockId,
    text: clip(hit.text.replace(/\s+/gu, ' ').trim(), COMPANION_LIMITS.excerptChars),
  };
}

export function buildCompanionTools(deps: CompanionToolDeps): AgentTool<never, never>[] {
  const search: AgentTool<typeof SearchParams, CompanionMaterialDetails> = {
    name: COMPANION_TOOL_NAMES.search,
    label: 'Search materials',
    description:
      "Search the study materials you are allowed to use in this subject. Returns numbered excerpts [M1]…; cite them in your answer as [M1]. Only these excerpts count as the student's materials.",
    parameters: SearchParams,
    async execute(_id, params) {
      const snapshot = await deps.resolveScope();
      if (snapshot.retrieval === 'unavailable') {
        const details: CompanionMaterialDetails = {
          kind: 'study-companion-materials',
          note: '资料检索当前不可用（服务未开启）。请说明这一点，并只用你自己的知识回答，标明是补充说明。',
          excerpts: [],
        };
        return textResult(renderMaterialResult(details), details);
      }
      if (snapshot.allowedMaterialIds.size === 0 || snapshot.scope.length === 0) {
        const details: CompanionMaterialDetails = {
          kind: 'study-companion-materials',
          note:
            snapshot.allowedMaterialIds.size === 0
              ? '你在这个学科没有被授权使用任何资料。请如实说明，并只用你自己的知识回答，标明是补充说明。'
              : '你被授权的资料还没有建立检索索引，暂时无法检索。请如实说明，并只用你自己的知识回答，标明是补充说明。',
          excerpts: [],
        };
        return textResult(renderMaterialResult(details), details);
      }
      const terms = questionTerms(params.query);
      const hits = await deps.search(snapshot.scope, terms, COMPANION_LIMITS.searchHits);
      const excerpts = hits
        .filter((hit) => snapshot.allowedMaterialIds.has(hit.index.materialId))
        .map((hit) => excerptOf(deps.nextRef(), hit));
      excerpts.forEach((excerpt) => deps.remember(excerpt));
      const details: CompanionMaterialDetails = {
        kind: 'study-companion-materials',
        note: excerpts.length
          ? `检索“${clip(params.query, 60)}”找到 ${excerpts.length} 段资料：`
          : `检索“${clip(params.query, 60)}”在你可用的资料中没有找到相关内容。可以换用资料里会出现的关键词再试一次；仍没有就如实说明“资料中未找到”，再用自己的知识补充并标明。`,
        excerpts,
      };
      return textResult(renderMaterialResult(details), details);
    },
  };

  const read: AgentTool<typeof ReadParams, CompanionMaterialDetails> = {
    name: COMPANION_TOOL_NAMES.read,
    label: 'Read material',
    description:
      'Read more of the original text around an excerpt ref (e.g. "M2"), or one page of a material (materialId + page). Use it when an excerpt is cut off or you need the surrounding steps.',
    parameters: ReadParams,
    async execute(_id, params) {
      const snapshot = await deps.resolveScope();
      const known = params.ref ? deps.knownExcerpt(params.ref.trim().toUpperCase()) : undefined;
      const materialId = known?.materialId ?? params.materialId;
      const fail = (note: string) => {
        const details: CompanionMaterialDetails = {
          kind: 'study-companion-materials',
          note,
          excerpts: [],
        };
        return textResult(renderMaterialResult(details), details);
      };
      if (!materialId) return fail('需要提供之前的资料编号（如 M2），或资料 id 加页码。');
      if (!snapshot.allowedMaterialIds.has(materialId)) {
        return fail('这份资料不在你当前的授权范围内（或已删除），不能阅读或引用。');
      }
      const index =
        snapshot.scope.find((candidate) => candidate.materialId === materialId) ?? undefined;
      const versionId = known?.versionId ?? index?.versionId;
      const artifactId = known?.artifactId ?? index?.artifactId;
      if (!versionId || !artifactId) return fail('这份资料还没有可阅读的解析结果。');
      const document = await deps.readArtifact(versionId, artifactId);
      if (!document) return fail('这份资料的解析结果暂时无法读取。');
      const page = params.page ?? known?.page ?? null;
      let blocks = document.blocks;
      if (known?.blockId && params.page === undefined) {
        const at = blocks.findIndex((block) => block.id === known.blockId);
        if (at >= 0) blocks = blocks.slice(Math.max(0, at - 2), at + 8);
      } else if (document.paged && page !== null) {
        blocks = blocks.filter((block) => block.pageNumber === page);
      }
      let used = 0;
      const parts: string[] = [];
      for (const block of blocks) {
        const table = block.cells?.map((row) => row.join('\t')).join('\n');
        const text = [block.text, table].filter(Boolean).join('\n').trim();
        if (!text) continue;
        if (used + text.length > COMPANION_LIMITS.readChars) break;
        used += text.length;
        parts.push(text);
      }
      if (parts.length === 0) return fail('这个位置没有可读的文字（可能是扫描页）。');
      const title =
        known?.title ??
        index?.title ??
        snapshot.scope.find((s) => s.materialId === materialId)?.title;
      const excerpt: CompanionExcerpt = {
        ref: deps.nextRef(),
        materialId,
        versionId,
        versionNo: known?.versionNo ?? index?.versionNo ?? 0,
        artifactId,
        title: title ?? '资料',
        page: page ?? blocks.find((block) => block.pageNumber !== undefined)?.pageNumber ?? null,
        blockId: known?.blockId ?? blocks[0]?.id ?? null,
        text: parts.join('\n'),
      };
      deps.remember(excerpt);
      const details: CompanionMaterialDetails = {
        kind: 'study-companion-materials',
        note: '原文：',
        excerpts: [excerpt],
      };
      return textResult(renderMaterialResult(details), details);
    },
  };

  const courses: AgentTool<ReturnType<typeof Type.Object>, unknown> = {
    name: COMPANION_TOOL_NAMES.courses,
    label: 'List courses',
    description:
      'List the courses of this subject (and the classroom this chat came from) you may read with read_course_page.',
    parameters: Type.Object({}),
    async execute() {
      const list = await deps.courses();
      return textResult(
        list.length
          ? list
              .map(
                (course) =>
                  `- ${course.title} (stageId: ${course.stageId})${course.origin ? ' ← 本次对话来自这门课' : ''}`,
              )
              .join('\n')
          : '这个学科还没有课程。',
        { courses: list },
      );
    },
  };

  const coursePage: AgentTool<typeof CourseParams, unknown> = {
    name: COMPANION_TOOL_NAMES.coursePage,
    label: 'Read course page',
    description:
      'Read a course outline (omit sceneId) or the visible text of one page: titles, slide text, quiz questions and the spoken lines.',
    parameters: CourseParams,
    async execute(_id, params) {
      const allowed = (await deps.courses()).some((course) => course.stageId === params.stageId);
      if (!allowed) {
        return textResult('只能阅读这个学科的课程或本次对话来源的课堂。', {
          error: 'COURSE_NOT_ALLOWED',
        });
      }
      const result = await deps.readCourse(params.stageId, params.sceneId);
      if (!result) return textResult('没有找到这门课或这一页。', { error: 'COURSE_NOT_FOUND' });
      if (result.kind === 'outline') {
        return textResult(
          [`《${result.title}》共 ${result.scenes.length} 页：`]
            .concat(
              result.scenes.map(
                (scene, index) => `${index + 1}. ${scene.title} (sceneId: ${scene.id})`,
              ),
            )
            .join('\n'),
          { stageId: params.stageId, scenes: result.scenes.length },
        );
      }
      return textResult(
        `《${result.title}》· ${result.sceneTitle}\n${clip(result.text, COMPANION_LIMITS.readChars)}`,
        { stageId: params.stageId, sceneId: params.sceneId },
      );
    },
  };

  const tools: AgentTool<never, never>[] = [
    search,
    read,
    courses,
    coursePage,
  ] as unknown as AgentTool<never, never>[];

  const invite = deps.invite;
  if (invite && invite.candidates.length > 0 && invite.maxCalls > 0) {
    let calls = 0;
    const invited = new Set<string>();
    const inviteTool: AgentTool<typeof InviteParams, CompanionInviteDetails | { error: string }> = {
      name: COMPANION_TOOL_NAMES.invite,
      label: 'Invite classmate',
      description: `The student asked these classmates to join this turn's discussion: ${invite.candidates
        .map((candidate) => `${candidate.name} (${candidate.classmateId})`)
        .join(
          ', ',
        )}. Answer first, then invite each at most once (at most ${invite.maxCalls} in total) to add one distinct point. Their reply is shown to the student as their own message.`,
      parameters: InviteParams,
      async execute(_id, params, signal) {
        const candidate = invite.candidates.find((item) => item.classmateId === params.classmateId);
        if (!candidate) {
          return textResult('只能邀请学生这次选中的学伴。', { error: 'NOT_INVITED' });
        }
        if (invited.has(candidate.classmateId)) {
          return textResult('这位学伴本轮已经发言过了。', { error: 'ALREADY_INVITED' });
        }
        if (calls >= invite.maxCalls) {
          return textResult('本轮讨论的发言次数已用完，请直接总结结束。', { error: 'TURN_LIMIT' });
        }
        calls += 1;
        invited.add(candidate.classmateId);
        const details = await invite.run(candidate.classmateId, params.request, signal);
        return textResult(renderInviteResult(details), details);
      },
    };
    tools.push(inviteTool as unknown as AgentTool<never, never>);
  }
  return tools;
}
