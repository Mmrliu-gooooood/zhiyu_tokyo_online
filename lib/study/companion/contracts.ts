/**
 * After-class classmate chats (learning plan B05): wire contracts shared by
 * the study APIs, the agent runner and the chat page. Pure — no Next.js,
 * browser store or database imports.
 *
 * A chat is a durable agent session plus one `study_companion_chats` row
 * (purpose, study space, classmate, classroom origin). Messages, the event
 * stream, cancel and resume use the agent-session APIs unchanged.
 */

import type { MemoryTurnInfo } from '@/lib/study/memory/contracts';

export const COMPANION_PURPOSES = ['after_class_qa'] as const;
export type CompanionPurpose = (typeof COMPANION_PURPOSES)[number];

export const COMPANION_LIMITS = {
  /** Characters of one question (same order as a Pro message, much smaller). */
  question: 2_000,
  /** Characters of the classroom context carried into a chat. */
  originExcerpt: 600,
  /** Messages per owner per hour across all after-class chats. */
  messagesPerHour: 60,
  /** Other classmates the student may invite into one message's discussion. */
  discussionInvites: 2,
  /** Excerpts one search returns. */
  searchHits: 6,
  /** Characters of one excerpt shown to the model. */
  excerptChars: 700,
  /** Characters one read_material / read_course_page call returns. */
  readChars: 4_000,
  /** User turns of earlier conversation kept in the model context. */
  historyTurns: 8,
} as const;

/** Where a chat was opened from ("继续问这个学伴" in a classroom). */
export interface CompanionOrigin {
  stageId: string;
  sceneId?: string;
  /** The classroom agent id (`<classmateId>-r<revision>`) the student clicked. */
  agentId?: string;
  /** The classroom question or remark the chat continues (bounded). */
  excerpt?: string;
}

export interface CompanionChatView {
  sessionId: string;
  spaceId: string;
  classmateId: string;
  purpose: CompanionPurpose;
  origin: CompanionOrigin | null;
  createdAt: string;
  /** From the agent session. */
  title: string;
  status: string;
  updatedAt: string;
}

// ── per-message options ─────────────────────────────────────────────────────

/**
 * A message may name other classmates to invite into this turn's discussion.
 * The option travels at the end of the durable message text in a fixed
 * envelope (the agent-session message format has no free metadata field);
 * the runner strips it before the model sees the message and the chat page
 * strips it before display.
 */
const OPTIONS_ENVELOPE = /\n*\[\[companion-options (\{[^\n]*\})\]\]\s*$/u;

export interface CompanionMessageOptions {
  discuss: string[];
}

export function encodeCompanionMessage(text: string, options: CompanionMessageOptions): string {
  const discuss = [...new Set(options.discuss)];
  if (discuss.length === 0) return text;
  return `${text}\n\n[[companion-options ${JSON.stringify({ discuss })}]]`;
}

export function decodeCompanionMessage(text: string): {
  text: string;
  options: CompanionMessageOptions;
} {
  const match = OPTIONS_ENVELOPE.exec(text);
  if (!match) return { text, options: { discuss: [] } };
  let discuss: string[] = [];
  try {
    const parsed = JSON.parse(match[1]!) as { discuss?: unknown };
    if (Array.isArray(parsed.discuss)) {
      discuss = parsed.discuss
        .filter((id): id is string => typeof id === 'string' && /^cm-[0-9a-f]{16}$/.test(id))
        .slice(0, COMPANION_LIMITS.discussionInvites);
    }
  } catch {
    discuss = [];
  }
  return {
    text: text.slice(0, match.index).trimEnd(),
    options: { discuss: [...new Set(discuss)] },
  };
}

// ── tool results ───────────────────────────────────────────────────────────

export const COMPANION_TOOL_NAMES = {
  search: 'search_materials',
  read: 'read_material',
  coursePage: 'read_course_page',
  courses: 'list_space_courses',
  invite: 'invite_classmate',
} as const;

/** One material excerpt a tool returned. `ref` is what the model cites ([M1]). */
export interface CompanionExcerpt {
  ref: string;
  materialId: string;
  versionId: string;
  versionNo: number;
  artifactId: string;
  title: string;
  page: number | null;
  blockId: string | null;
  text: string;
}

/**
 * The structured part of a material tool result. The model-visible text is
 * always rendered from this, so a later run can re-render it with excerpts
 * of materials the classmate may no longer use withheld.
 */
export interface CompanionMaterialDetails {
  kind: 'study-companion-materials';
  note: string;
  excerpts: CompanionExcerpt[];
}

/** The structured part of an invite_classmate result. */
export interface CompanionInviteDetails {
  kind: 'study-companion-invite';
  classmateId: string;
  revision: number;
  name: string;
  avatar: string;
  color: string;
  reply: string;
  excerpts: CompanionExcerpt[];
  error?: string;
}

export const WITHHELD_EXCERPT =
  '[学生已取消这份资料的授权（或已删除），原内容已隐去。当时基于它的回答并没有错，不用更正或道歉；只是现在不能再引用或转述它。]';

export function renderMaterialResult(
  details: CompanionMaterialDetails,
  allowedMaterialIds?: ReadonlySet<string>,
): string {
  const lines = [details.note];
  for (const excerpt of details.excerpts) {
    const where = [
      `《${excerpt.title}》v${excerpt.versionNo}`,
      excerpt.page !== null ? `第 ${excerpt.page} 页` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const allowed = !allowedMaterialIds || allowedMaterialIds.has(excerpt.materialId);
    lines.push(
      allowed
        ? `[${excerpt.ref}] ${where}\n${excerpt.text}`
        : `[${excerpt.ref}] ${WITHHELD_EXCERPT}`,
    );
  }
  return lines.join('\n\n');
}

export function renderInviteResult(
  details: CompanionInviteDetails,
  allowedMaterialIds?: ReadonlySet<string>,
): string {
  if (details.error) return details.error;
  const withheld =
    allowedMaterialIds &&
    details.excerpts.some((excerpt) => !allowedMaterialIds.has(excerpt.materialId));
  return [
    `${details.name} 的发言：`,
    details.reply,
    withheld ? '（其中引用的部分资料不在你的授权范围内：不要转述或引用那部分内容。）' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── turn record ────────────────────────────────────────────────────────────

/** The `study_companion_turn` event: what one turn resolved on the server. */
export interface CompanionTurnInfo {
  classmateId: string;
  revision: number;
  /** Changes only when name / role / persona / style change (not on model or material edits). */
  personaKey: string;
  name: string;
  avatar: string;
  color: string;
  status: 'active' | 'archived';
  spaceId: string;
  materials: Array<{ id: string; title: string }>;
  /** Materials earlier turns used that this turn may no longer use. */
  withheldMaterialIds: string[];
  retrieval: 'keyword' | 'hybrid' | 'unavailable';
  model: { mode: 'inherit' | 'custom'; label: string };
  discuss: Array<{ classmateId: string; name: string }>;
  /** What this turn took from the student's Memory (B06); absent before B06. */
  memory?: MemoryTurnInfo;
}

export const COMPANION_TURN_EVENT = 'study_companion_turn';

/** Reader deep link for one excerpt (the B03 citation link). */
export function excerptReaderHref(excerpt: CompanionExcerpt): string {
  const params = new URLSearchParams({ version: excerpt.versionId });
  if (excerpt.page) params.set('page', String(excerpt.page));
  params.set('artifact', excerpt.artifactId);
  if (excerpt.blockId) params.set('block', excerpt.blockId);
  return `/study/materials/${encodeURIComponent(excerpt.materialId)}/read?${params.toString()}`;
}
