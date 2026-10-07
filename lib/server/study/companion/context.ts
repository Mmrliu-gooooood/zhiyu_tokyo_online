/**
 * Model context of an after-class turn (learning plan B05).
 *
 * - The system prompt is rebuilt every turn from the classmate's current
 *   revision, the space and the currently authorised materials, so a changed
 *   persona or material set applies to the next answer only. Earlier
 *   messages are never rewritten in storage.
 * - Earlier material tool results are re-rendered from their structured
 *   details with the CURRENT authorisation: excerpts of materials the
 *   classmate may no longer use are withheld from the model. This is a
 *   read-time view; the durable entry tree is untouched.
 * - Only the last few user turns of conversation are kept, cut at a user
 *   message so tool calls and their results stay paired.
 */
import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { composeClassmatePersona, type ClassmateSnapshot } from '@/lib/study/classmates/contracts';
import {
  COMPANION_LIMITS,
  COMPANION_TOOL_NAMES,
  renderInviteResult,
  renderMaterialResult,
  type CompanionExcerpt,
  type CompanionInviteDetails,
  type CompanionMaterialDetails,
  type CompanionOrigin,
} from '@/lib/study/companion/contracts';

export interface CompanionPromptInput {
  snapshot: ClassmateSnapshot;
  spaceName: string;
  subject: string | null;
  materials: ReadonlyArray<{ id: string; title: string }>;
  retrieval: 'keyword' | 'unavailable';
  origin: (CompanionOrigin & { courseTitle?: string; sceneTitle?: string }) | null;
  discussing: ReadonlyArray<{ classmateId: string; name: string }>;
  withheldCount: number;
}

function quote(text: string): string {
  return text.replace(/[\u0000-\u001f]/gu, ' ').replace(/"/g, '“');
}

export function companionSystemPrompt(input: CompanionPromptInput): string {
  const { snapshot } = input;
  const roleLine =
    snapshot.role === 'assistant'
      ? '你的身份：助教（学生自己选的陪学助教）。'
      : '你的身份：同学（学生自己选的学伴）。';
  const materials =
    input.retrieval === 'unavailable'
      ? '资料检索当前不可用：只能用你自己的知识回答，并标明是补充说明。'
      : input.materials.length
        ? `你在本学科可以使用的资料（只能通过 search_materials / read_material 读取）：${input.materials
            .map((material) => `《${quote(material.title)}》`)
            .join('、')}。不在这个列表里的资料你看不到，也不能声称引用。`
        : '学生没有给你授权本学科的任何资料：如实说明，只用你自己的知识回答，并标明是补充说明。';
  const origin = input.origin
    ? [
        `本次对话来自课堂${input.origin.courseTitle ? `《${quote(input.origin.courseTitle)}》` : ''}${
          input.origin.sceneTitle ? `的「${quote(input.origin.sceneTitle)}」一页` : ''
        }（stageId: ${input.origin.stageId}${input.origin.sceneId ? `, sceneId: ${input.origin.sceneId}` : ''}）。`,
        input.origin.excerpt
          ? `课堂里的相关内容（学生带过来的原话，仅作背景）："${quote(input.origin.excerpt)}"`
          : '',
        '需要这页课堂的具体内容时，用 read_course_page 读取，不要凭空复述。',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const discussion = input.discussing.length
    ? `这一轮学生邀请了 ${input.discussing.map((item) => quote(item.name)).join('、')} 一起讨论：你先回答，再用 invite_classmate 请他们各补充一个不同的观点（每人最多一次），最后用一两句话收尾。`
    : '这一轮只有你一个人回答，不要模仿或代替其他学伴发言。';
  return [
    `你是「${quote(snapshot.name)}」，正在课后陪学生继续学习「${quote(input.spaceName)}」${
      input.subject ? `（${quote(input.subject)}）` : ''
    }。`,
    roleLine,
    `人设与陪学方式：\n${composeClassmatePersona(snapshot)}`,
    '回答规则：',
    '1. 用学生使用的语言回答，口吻符合你的人设；简洁、具体，先回答问题本身。',
    '2. 涉及学生资料里的内容时，先用 search_materials 检索（用资料里会出现的关键词），需要上下文再用 read_material；引用时在句末标注编号，如 [M2]。只能引用工具返回的编号，不能编造编号或页码。',
    '3. 资料里没有的内容可以用你自己的知识补充，但要明确说“资料中没有找到，以下是补充说明”。',
    '4. 你只有阅读权限：不能修改课程、生成课程、联网搜索或执行其他操作；学生要求这些时说明需要回到对应功能。',
    '5. 标记为“已隐去”的历史资料片段已不在授权范围内，不要再使用、转述或引用其中内容。',
    materials,
    input.withheldCount > 0
      ? `注意：早先对话中有 ${input.withheldCount} 份资料已被取消授权或删除，相关片段已隐去。`
      : '',
    origin,
    discussion,
  ]
    .filter(Boolean)
    .join('\n\n');
}

type ToolResultLike = {
  role: 'toolResult';
  toolName?: string;
  details?: unknown;
  content?: unknown;
};

function isMaterialDetails(value: unknown): value is CompanionMaterialDetails {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'study-companion-materials' &&
    Array.isArray((value as { excerpts?: unknown }).excerpts)
  );
}

function isInviteDetails(value: unknown): value is CompanionInviteDetails {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'study-companion-invite' &&
    Array.isArray((value as { excerpts?: unknown }).excerpts)
  );
}

const MATERIAL_TOOLS = new Set<string>([COMPANION_TOOL_NAMES.search, COMPANION_TOOL_NAMES.read]);

export interface CompanionHistoryView {
  messages: AgentMessage[];
  /** Materials earlier results used that the classmate may no longer use. */
  withheldMaterialIds: string[];
  /** Authorised excerpts by ref (for read_material continuation). */
  excerpts: Map<string, CompanionExcerpt>;
  /** Highest M-number seen, so new refs stay unique across the conversation. */
  lastRef: number;
}

/**
 * Re-render earlier companion tool results with the current authorisation
 * and keep the last `historyTurns` user turns.
 */
export function companionHistoryView(
  messages: readonly AgentMessage[],
  allowedMaterialIds: ReadonlySet<string>,
  historyTurns: number = COMPANION_LIMITS.historyTurns,
): CompanionHistoryView {
  const withheld = new Set<string>();
  const excerpts = new Map<string, CompanionExcerpt>();
  let lastRef = 0;
  const note = (list: readonly CompanionExcerpt[]) => {
    for (const excerpt of list) {
      const number = /^M(\d+)$/.exec(excerpt.ref)?.[1];
      if (number) lastRef = Math.max(lastRef, Number(number));
      if (allowedMaterialIds.has(excerpt.materialId)) excerpts.set(excerpt.ref, excerpt);
      else withheld.add(excerpt.materialId);
    }
  };
  // Withheld excerpts leave the view entirely (text and structured copy).
  const allowedOnly = (list: readonly CompanionExcerpt[]) =>
    list.filter((excerpt) => allowedMaterialIds.has(excerpt.materialId));
  const rendered = messages.map((message) => {
    if ((message as { role?: string }).role !== 'toolResult') return message;
    const result = message as unknown as ToolResultLike;
    if (MATERIAL_TOOLS.has(result.toolName ?? '') && isMaterialDetails(result.details)) {
      note(result.details.excerpts);
      return {
        ...message,
        content: [{ type: 'text', text: renderMaterialResult(result.details, allowedMaterialIds) }],
        details: { ...result.details, excerpts: allowedOnly(result.details.excerpts) },
      } as unknown as AgentMessage;
    }
    if (result.toolName === COMPANION_TOOL_NAMES.invite && isInviteDetails(result.details)) {
      note(result.details.excerpts);
      return {
        ...message,
        content: [{ type: 'text', text: renderInviteResult(result.details, allowedMaterialIds) }],
        details: { ...result.details, excerpts: allowedOnly(result.details.excerpts) },
      } as unknown as AgentMessage;
    }
    return message;
  });
  const userIndexes = rendered.flatMap((message, index) =>
    (message as { role?: string }).role === 'user' ? [index] : [],
  );
  const start =
    userIndexes.length > historyTurns ? userIndexes[userIndexes.length - historyTurns]! : 0;
  return {
    messages: rendered.slice(start),
    withheldMaterialIds: [...withheld],
    excerpts,
    lastRef,
  };
}

/** Stable key of what shapes the answers' voice (not model or materials). */
export function companionPersonaKey(snapshot: ClassmateSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify([snapshot.name, snapshot.role, snapshot.persona, snapshot.learningStyle]),
    )
    .digest('hex')
    .slice(0, 16);
}
