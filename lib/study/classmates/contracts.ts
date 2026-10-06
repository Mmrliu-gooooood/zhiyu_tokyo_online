/**
 * Classmates (learning plan B04): wire contracts, input validation and the
 * pure rules shared by the API routes, the classroom generators and the chat
 * routes. Pure — no Next.js, browser store or database imports.
 *
 * A classmate is a long-lived template the student creates (name, role,
 * persona, companion style, speaking rule, avatar, voice, authorised
 * materials). Every saved edit bumps `revision` and stores an immutable
 * snapshot of that revision. A classroom never references the live template:
 * it carries a snapshot of one revision in `stage.generatedAgentConfigs`
 * under the stage agent id `<classmateId>-r<revision>`, so editing or
 * archiving the template never rewrites a generated course, and the server
 * can always resolve a classroom agent back to the exact revision it used.
 *
 * Classmates are participants only (assistant or student role). The system
 * teacher keeps the classroom; a persona never widens the role's actions.
 */

export const CLASSMATE_ROLES = ['assistant', 'student'] as const;
export type ClassmateRole = (typeof CLASSMATE_ROLES)[number];

/** How the classmate keeps the student company; each maps to a fixed prompt rule. */
export const CLASSMATE_LEARNING_STYLES = ['encouraging', 'socratic', 'peer', 'summarizer'] as const;
export type ClassmateLearningStyle = (typeof CLASSMATE_LEARNING_STYLES)[number];

/**
 * When the classmate may speak in live classroom chat.
 * - `active`: an ordinary participant; the director may call on it.
 * - `on_demand`: speaks only when the student names it (or it opens a discussion).
 */
export const CLASSMATE_SPEECH_POLICIES = ['active', 'on_demand'] as const;
export type ClassmateSpeechPolicy = (typeof CLASSMATE_SPEECH_POLICIES)[number];

export const CLASSMATE_STATUSES = ['active', 'archived'] as const;
export type ClassmateStatus = (typeof CLASSMATE_STATUSES)[number];

export const CLASSMATE_LIMITS = {
  name: 40,
  persona: 2000,
  /** Templates per owner, archived ones included. */
  classmatesPerOwner: 30,
  materialsPerClassmate: 20,
  /** Classmates one classroom may bring along (cost and turn-taking stay small). */
  classmatesPerClassroom: 3,
  avatarsPerOwner: 60,
  /** Uploaded avatars are resized in the browser first; the server takes at most this. */
  avatarBytes: 96 * 1024,
} as const;

export const CLASSMATE_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ClassmateAvatarType = (typeof CLASSMATE_AVATAR_TYPES)[number];

/** Bundled avatars a classmate may use without uploading (files under public/avatars/). */
export const CLASSMATE_PRESET_AVATARS = [
  '/avatars/assist.png',
  '/avatars/assist-2.png',
  '/avatars/curious.png',
  '/avatars/curious-2.png',
  '/avatars/thinker.png',
  '/avatars/thinker-2.png',
  '/avatars/note-taker.png',
  '/avatars/note-taker-2.png',
  '/avatars/clown.png',
  '/avatars/clown-2.png',
  '/avatars/teacher-2.png',
  '/avatars/user.png',
] as const;

export const CLASSMATE_COLORS = [
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#f97316',
  '#14b8a6',
  '#e11d48',
  '#6366f1',
  '#84cc16',
] as const;

/** A voice picked from the catalog the student can already use (no cloning, no paid design). */
export interface ClassmateVoice {
  providerId: string;
  modelId?: string;
  voiceId: string;
  source?: 'platform' | 'user' | 'legacy-managed';
  defaultId?: string;
  revision?: string;
}

/** The editable fields of a template. */
export interface ClassmateInput {
  name: string;
  role: ClassmateRole;
  persona: string;
  learningStyle: ClassmateLearningStyle;
  speechPolicy: ClassmateSpeechPolicy;
  avatar: string;
  color: string;
  voice: ClassmateVoice | null;
  materialIds: string[];
}

export type ClassmatePatch = Partial<ClassmateInput> & { status?: ClassmateStatus };

/** What one revision froze; a classroom snapshot is built from exactly this. */
export interface ClassmateSnapshot {
  name: string;
  role: ClassmateRole;
  persona: string;
  learningStyle: ClassmateLearningStyle;
  speechPolicy: ClassmateSpeechPolicy;
  avatar: string;
  color: string;
  voice: ClassmateVoice | null;
}

export interface ClassmateView extends ClassmateSnapshot {
  id: string;
  materialIds: string[];
  status: ClassmateStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** A classroom roster entry, shaped like the stage's GeneratedAgentConfig. */
export interface ClassmateRosterConfig {
  id: string;
  name: string;
  role: ClassmateRole;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceConfig?: ClassmateVoice;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string };

// ── ids ────────────────────────────────────────────────────────────────────

const CLASSMATE_ID = /^cm-[0-9a-f]{16}$/;
const STAGE_AGENT_ID = /^(cm-[0-9a-f]{16})-r([1-9]\d{0,8})$/;
const AVATAR_ID = /^av-[0-9a-f]{16}$/;
const AVATAR_PATH = /^\/api\/study\/classmates\/avatars\/(av-[0-9a-f]{16})$/;

export function isClassmateId(value: unknown): value is string {
  return typeof value === 'string' && CLASSMATE_ID.test(value);
}

export function isClassmateAvatarId(value: unknown): value is string {
  return typeof value === 'string' && AVATAR_ID.test(value);
}

/** The id a classroom gives the snapshot of one template revision. */
export function classmateStageAgentId(classmateId: string, revision: number): string {
  return `${classmateId}-r${revision}`;
}

/** The template revision behind a classroom agent id, or null for any other agent. */
export function parseClassmateStageAgentId(
  agentId: unknown,
): { classmateId: string; revision: number } | null {
  if (typeof agentId !== 'string') return null;
  const match = STAGE_AGENT_ID.exec(agentId);
  return match ? { classmateId: match[1]!, revision: Number(match[2]) } : null;
}

export function classmateAvatarPath(avatarId: string): string {
  return `/api/study/classmates/avatars/${avatarId}`;
}

/** The uploaded avatar an avatar value points at, or null for a bundled one. */
export function uploadedAvatarId(avatar: string): string | null {
  return AVATAR_PATH.exec(avatar)?.[1] ?? null;
}

// ── validation ─────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/;
const REF = /^[a-zA-Z0-9_.:/-]{1,200}$/;

function text(value: unknown, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) return required ? undefined : '';
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (required && !trimmed) return undefined;
  if (Array.from(trimmed).length > max || CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function isClassmateAvatar(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((CLASSMATE_PRESET_AVATARS as readonly string[]).includes(value) || AVATAR_PATH.test(value))
  );
}

function parseVoice(value: unknown): { ok: true; value: ClassmateVoice | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isObject(value)) return { ok: false };
  const { providerId, modelId, voiceId, source, defaultId, revision } = value;
  if (typeof providerId !== 'string' || !REF.test(providerId)) return { ok: false };
  if (typeof voiceId !== 'string' || !voiceId || voiceId.length > 200 || CONTROL.test(voiceId)) {
    return { ok: false };
  }
  if (modelId !== undefined && (typeof modelId !== 'string' || !REF.test(modelId))) {
    return { ok: false };
  }
  if (source !== undefined && !['platform', 'user', 'legacy-managed'].includes(source as string)) {
    return { ok: false };
  }
  if (source === 'platform' && (typeof defaultId !== 'string' || !REF.test(defaultId))) {
    return { ok: false };
  }
  if (source !== 'platform' && defaultId !== undefined) return { ok: false };
  if (revision !== undefined && (typeof revision !== 'string' || revision.length > 500)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      providerId,
      ...(modelId ? { modelId: modelId as string } : {}),
      voiceId,
      ...(source ? { source: source as ClassmateVoice['source'] } : {}),
      ...(source === 'platform' ? { defaultId: defaultId as string } : {}),
      ...(revision ? { revision: revision as string } : {}),
    },
  };
}

function parseMaterialIds(value: unknown): { ok: true; value: string[] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > CLASSMATE_LIMITS.materialsPerClassmate) {
    return { ok: false };
  }
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return { ok: false };
    ids.add(id);
  }
  return { ok: true, value: [...ids] };
}

const FIELD_PARSERS: {
  [K in keyof ClassmateInput]: (
    value: unknown,
  ) => { ok: true; value: ClassmateInput[K] } | { ok: false };
} = {
  name: (value) => {
    const parsed = text(value, CLASSMATE_LIMITS.name, true);
    return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
  },
  role: (value) => {
    const parsed = oneOf(CLASSMATE_ROLES, value);
    return parsed ? { ok: true, value: parsed } : { ok: false };
  },
  persona: (value) => {
    const parsed = text(value, CLASSMATE_LIMITS.persona, false);
    return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
  },
  learningStyle: (value) => {
    const parsed = oneOf(CLASSMATE_LEARNING_STYLES, value);
    return parsed ? { ok: true, value: parsed } : { ok: false };
  },
  speechPolicy: (value) => {
    const parsed = oneOf(CLASSMATE_SPEECH_POLICIES, value);
    return parsed ? { ok: true, value: parsed } : { ok: false };
  },
  avatar: (value) => (isClassmateAvatar(value) ? { ok: true, value } : { ok: false }),
  color: (value) =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
      ? { ok: true, value: value.toLowerCase() }
      : { ok: false },
  voice: parseVoice,
  materialIds: parseMaterialIds,
};

/** Validate a create body. Unknown fields are ignored. */
export function parseClassmateInput(body: unknown): ValidationResult<ClassmateInput> {
  if (!isObject(body)) return { ok: false, field: 'body' };
  const out: Record<string, unknown> = {};
  for (const [field, parse] of Object.entries(FIELD_PARSERS)) {
    const parsed = (parse as (value: unknown) => { ok: boolean; value?: unknown })(body[field]);
    if (!parsed.ok) return { ok: false, field };
    out[field] = parsed.value;
  }
  return { ok: true, value: out as unknown as ClassmateInput };
}

/** Validate a partial update. Only present fields change; `status` archives or restores. */
export function parseClassmatePatch(body: unknown): ValidationResult<ClassmatePatch> {
  if (!isObject(body)) return { ok: false, field: 'body' };
  const out: Record<string, unknown> = {};
  for (const [field, parse] of Object.entries(FIELD_PARSERS)) {
    if (!(field in body)) continue;
    const parsed = (parse as (value: unknown) => { ok: boolean; value?: unknown })(body[field]);
    if (!parsed.ok) return { ok: false, field };
    out[field] = parsed.value;
  }
  if ('status' in body) {
    const status = oneOf(CLASSMATE_STATUSES, body.status);
    if (!status) return { ok: false, field: 'status' };
    out.status = status;
  }
  if (Object.keys(out).length === 0) return { ok: false, field: 'body' };
  return { ok: true, value: out as ClassmatePatch };
}

/** A stored snapshot read back from the database; null when it does not have the expected shape. */
export function parseClassmateSnapshot(value: unknown): ClassmateSnapshot | null {
  if (!isObject(value)) return null;
  const out: Record<string, unknown> = {};
  for (const field of [
    'name',
    'role',
    'persona',
    'learningStyle',
    'speechPolicy',
    'avatar',
    'color',
    'voice',
  ] as const) {
    const parsed = (FIELD_PARSERS[field] as (value: unknown) => { ok: boolean; value?: unknown })(
      value[field],
    );
    if (!parsed.ok) return null;
    out[field] = parsed.value;
  }
  return out as unknown as ClassmateSnapshot;
}

export function snapshotOf(input: ClassmateSnapshot): ClassmateSnapshot {
  return {
    name: input.name,
    role: input.role,
    persona: input.persona,
    learningStyle: input.learningStyle,
    speechPolicy: input.speechPolicy,
    avatar: input.avatar,
    color: input.color,
    voice: input.voice,
  };
}

// ── classroom snapshot ─────────────────────────────────────────────────────

const STYLE_RULES: Record<ClassmateLearningStyle, string> = {
  encouraging:
    'Companion style — encouraging: notice the student’s effort, keep them motivated, and reassure them after a mistake. Praise only something specific; never give empty praise.',
  socratic:
    'Companion style — guiding questions: prefer one short hint or guiding question over handing over the full answer, so the student takes the next step themselves.',
  peer: 'Companion style — study peer: think aloud like a fellow student. When it helps, voice a plausible confusion or common misconception so the teacher can clear it up; never present a misconception as fact.',
  summarizer:
    'Companion style — note-taker: when useful, add a brief recap of the key point or how it connects to what came before. Keep recaps short.',
};

const ROLE_DEFAULT_PERSONA: Record<ClassmateRole, string> = {
  assistant:
    'You are a teaching assistant the student chose to study with. Fill gaps, rephrase hard parts in simpler words, and give concrete examples.',
  student:
    'You are a classmate the student chose to study with. Take part like a real student: ask the questions a learner would ask and share your own understanding.',
};

/**
 * The credential owner of a voice picked in the classmate form, decided the
 * same way the media snapshot decides it for the session narrator: the
 * selected platform TTS default when provider and model are that default's,
 * the server's own key when the server configured the provider and the
 * student has none, otherwise the student's own provider configuration.
 * Pro keeps a classmate's voice only when this owner is in the session.
 */
export function classmateVoiceBinding(
  pick: { providerId: string; modelId?: string; voiceId: string },
  settings: {
    ttsSelection?: { source: string; defaultId?: string };
    platformDefaults?: {
      entries: ReadonlyArray<{
        capability: string;
        defaultId: string;
        providerId: string;
        modelId: string;
        available: boolean;
        revision: string;
      }>;
    } | null;
    ttsProvidersConfig: Record<
      string,
      { isServerConfigured?: boolean; apiKey?: string } | undefined
    >;
  },
): ClassmateVoice {
  const base = {
    providerId: pick.providerId,
    ...(pick.modelId ? { modelId: pick.modelId } : {}),
    voiceId: pick.voiceId,
  };
  const platform =
    settings.ttsSelection?.source === 'platform'
      ? settings.platformDefaults?.entries.find(
          (entry) =>
            entry.capability === 'tts' &&
            entry.available &&
            entry.defaultId === settings.ttsSelection?.defaultId,
        )
      : undefined;
  if (platform && platform.providerId === pick.providerId && platform.modelId === pick.modelId) {
    return {
      ...base,
      source: 'platform',
      defaultId: platform.defaultId,
      revision: platform.revision,
    };
  }
  const config = settings.ttsProvidersConfig[pick.providerId];
  return {
    ...base,
    source: config?.isServerConfigured && !config.apiKey ? 'legacy-managed' : 'user',
  };
}

/**
 * The persona text a classroom snapshot carries: the student's own words (or
 * a role default), then the fixed rule for the chosen companion style. The
 * speaking rule is not prompt text — the chat routes enforce it in code.
 */
export function composeClassmatePersona(snapshot: ClassmateSnapshot): string {
  const persona = snapshot.persona.trim() || ROLE_DEFAULT_PERSONA[snapshot.role];
  return `${persona}\n\n${STYLE_RULES[snapshot.learningStyle]}`;
}

/** The roster entry a classroom stores for one template revision. */
export function classmateRosterConfig(
  classmateId: string,
  revision: number,
  snapshot: ClassmateSnapshot,
): ClassmateRosterConfig {
  return {
    id: classmateStageAgentId(classmateId, revision),
    name: snapshot.name,
    role: snapshot.role,
    persona: composeClassmatePersona(snapshot),
    avatar: snapshot.avatar,
    color: snapshot.color,
    priority: snapshot.role === 'assistant' ? 7 : 5,
    ...(snapshot.voice ? { voiceConfig: snapshot.voice } : {}),
  };
}
