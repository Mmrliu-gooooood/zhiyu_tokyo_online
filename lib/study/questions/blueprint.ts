/**
 * Rule-based paper building (learning plan B07): pick questions for a
 * blueprint from the student's bank first, then from the official packs they
 * enabled, and report every shortfall instead of padding the paper. Pure and
 * deterministic: the same blueprint (with its seed) over the same candidates
 * always yields the same paper, so a preview can be published as shown.
 * No model is involved; AI top-ups arrive with B11.
 */
import {
  QUESTION_TYPES,
  type QuestionOrigin,
  type QuestionType,
  type VerificationState,
} from '@/lib/study/questions/contracts';

export const BLUEPRINT_LIMITS = {
  maxPerSection: 50,
  maxItems: 100,
  maxConcepts: 20,
  maxPacks: 10,
  seed: 64,
  title: 80,
} as const;

export type DifficultyPreference = 'any' | 'easier' | 'harder';

export interface BlueprintSection {
  type: QuestionType;
  count: number;
}

export interface ExamBlueprint {
  spaceId: string;
  /** In paper order; at most one section per type. */
  sections: BlueprintSection[];
  /** Knowledge points to cover (empty: the whole subject). */
  conceptIds: string[];
  /** Only questions linked to this course. */
  stageId: string | null;
  difficulty: DifficultyPreference;
  /** Skip questions already in one of this subject's earlier papers. */
  avoidSeen: boolean;
  /** Also use complete questions whose answer nobody checked. */
  includeUnverified: boolean;
  /** Official packs the student allowed, used after their own bank. */
  packIds: string[];
  seed: string;
}

/** A question the builder may pick (already restricted to complete, gradable ones). */
export interface BlueprintCandidate {
  /** `bank:<questionId>` or a pack fingerprint. */
  ref: string;
  tier: 'bank' | 'pack';
  type: QuestionType;
  /** Knowledge-point comparison keys (see conceptKey). */
  conceptKeys: string[];
  stageId: string | null;
  difficulty: number | null;
  verified: boolean;
  /** In an earlier paper of this subject. */
  seen: boolean;
}

export interface SectionShortfall {
  type: QuestionType;
  wanted: number;
  available: number;
  /** Would have been available without these blueprint switches. */
  excludedSeen: number;
  excludedUnverified: number;
}

export interface BlueprintResult {
  picked: BlueprintCandidate[];
  /** Sections that could not be filled. Empty when the paper is complete. */
  shortfalls: SectionShortfall[];
  /** Requested knowledge points with no usable question of any requested type. */
  uncoveredConcepts: string[];
  /** Usable questions per requested type, for the builder's hints. */
  available: Partial<Record<QuestionType, number>>;
}

// ── parsing ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idList(value: unknown, max: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.length > 0 && entry.length <= 120,
  );
  return ids.length === value.length ? [...new Set(ids)] : null;
}

/** Validate a blueprint from a request; the seed may be omitted (the server draws one). */
export function parseBlueprint(
  raw: unknown,
):
  | { ok: true; blueprint: Omit<ExamBlueprint, 'seed'> & { seed: string | null } }
  | { ok: false; field: string } {
  if (!isRecord(raw)) return { ok: false, field: 'blueprint' };
  if (typeof raw.spaceId !== 'string' || !raw.spaceId) return { ok: false, field: 'spaceId' };
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    return { ok: false, field: 'sections' };
  }
  const sections: BlueprintSection[] = [];
  for (const entry of raw.sections) {
    if (
      !isRecord(entry) ||
      !(QUESTION_TYPES as readonly unknown[]).includes(entry.type) ||
      !Number.isInteger(entry.count) ||
      (entry.count as number) < 1 ||
      (entry.count as number) > BLUEPRINT_LIMITS.maxPerSection ||
      sections.some((section) => section.type === entry.type)
    ) {
      return { ok: false, field: 'sections' };
    }
    sections.push({ type: entry.type as QuestionType, count: entry.count as number });
  }
  if (sections.reduce((sum, section) => sum + section.count, 0) > BLUEPRINT_LIMITS.maxItems) {
    return { ok: false, field: 'sections' };
  }
  const conceptIds = idList(raw.conceptIds, BLUEPRINT_LIMITS.maxConcepts);
  if (!conceptIds) return { ok: false, field: 'conceptIds' };
  const packIds = idList(raw.packIds, BLUEPRINT_LIMITS.maxPacks);
  if (!packIds) return { ok: false, field: 'packIds' };
  const stageId = raw.stageId ?? null;
  if (stageId !== null && (typeof stageId !== 'string' || !stageId || stageId.length > 200)) {
    return { ok: false, field: 'stageId' };
  }
  const difficulty = raw.difficulty ?? 'any';
  if (difficulty !== 'any' && difficulty !== 'easier' && difficulty !== 'harder') {
    return { ok: false, field: 'difficulty' };
  }
  for (const flag of ['avoidSeen', 'includeUnverified'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean')
      return { ok: false, field: flag };
  }
  const seed = raw.seed ?? null;
  if (seed !== null && (typeof seed !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(seed))) {
    return { ok: false, field: 'seed' };
  }
  return {
    ok: true,
    blueprint: {
      spaceId: raw.spaceId,
      sections,
      conceptIds,
      stageId: stageId as string | null,
      difficulty,
      avoidSeen: raw.avoidSeen === true,
      includeUnverified: raw.includeUnverified === true,
      packIds,
      seed: seed as string | null,
    },
  };
}

// ── seeded order ────────────────────────────────────────────────────────────

/** 32-bit string hash (xmur3) feeding a small PRNG (mulberry32). */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

const DIFFICULTY_TARGET: Record<DifficultyPreference, number | null> = {
  any: null,
  easier: 1,
  harder: 5,
};

/**
 * Candidates in pick order: own bank before official packs; within a tier a
 * seeded shuffle, then (stable) closest to the preferred difficulty first —
 * unknown difficulty counts as medium.
 */
function ordered(
  candidates: readonly BlueprintCandidate[],
  difficulty: DifficultyPreference,
  random: () => number,
): BlueprintCandidate[] {
  const target = DIFFICULTY_TARGET[difficulty];
  const rank = (candidate: BlueprintCandidate) =>
    target === null ? 0 : Math.abs((candidate.difficulty ?? 3) - target);
  return (['bank', 'pack'] as const).flatMap((tier) =>
    shuffled(
      candidates.filter((candidate) => candidate.tier === tier),
      random,
    )
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
      .map((entry) => entry.candidate),
  );
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * Pick the paper. With knowledge points chosen, each section takes questions
 * round-robin across them so every point is covered before any repeats.
 * `conceptKeys` are the comparison keys of the chosen knowledge points.
 */
export function selectQuestions(
  blueprint: ExamBlueprint,
  candidates: readonly BlueprintCandidate[],
  conceptKeys: readonly string[],
): BlueprintResult {
  const random = seededRandom(`${blueprint.seed}:${blueprint.spaceId}`);
  const wanted = new Set(conceptKeys);
  const inScope = candidates.filter(
    (candidate) =>
      (blueprint.stageId === null || candidate.stageId === blueprint.stageId) &&
      (wanted.size === 0 || candidate.conceptKeys.some((key) => wanted.has(key))),
  );
  const usable = (candidate: BlueprintCandidate) =>
    (blueprint.includeUnverified || candidate.verified) && !(blueprint.avoidSeen && candidate.seen);

  const picked: BlueprintCandidate[] = [];
  const shortfalls: SectionShortfall[] = [];
  const available: BlueprintResult['available'] = {};
  const taken = new Set<string>();
  for (const section of blueprint.sections) {
    const ofType = inScope.filter((candidate) => candidate.type === section.type);
    const pool = ordered(ofType.filter(usable), blueprint.difficulty, random);
    available[section.type] = pool.length;
    const chosen: BlueprintCandidate[] = [];
    if (wanted.size === 0) {
      chosen.push(...pool.slice(0, section.count));
    } else {
      const queues = conceptKeys.map((key) =>
        pool.filter((candidate) => candidate.conceptKeys.includes(key)),
      );
      const cursors = queues.map(() => 0);
      let progressed = true;
      while (chosen.length < section.count && progressed) {
        progressed = false;
        for (let index = 0; index < queues.length && chosen.length < section.count; index += 1) {
          const queue = queues[index]!;
          while (cursors[index]! < queue.length && taken.has(queue[cursors[index]!]!.ref)) {
            cursors[index]! += 1;
          }
          const next = queue[cursors[index]!];
          if (!next) continue;
          taken.add(next.ref);
          chosen.push(next);
          progressed = true;
        }
      }
    }
    for (const candidate of chosen) taken.add(candidate.ref);
    picked.push(...chosen);
    if (chosen.length < section.count) {
      shortfalls.push({
        type: section.type,
        wanted: section.count,
        available: chosen.length,
        excludedSeen: blueprint.avoidSeen
          ? ofType.filter(
              (candidate) => candidate.seen && (blueprint.includeUnverified || candidate.verified),
            ).length
          : 0,
        excludedUnverified: blueprint.includeUnverified
          ? 0
          : ofType.filter(
              (candidate) => !candidate.verified && !(blueprint.avoidSeen && candidate.seen),
            ).length,
      });
    }
  }
  const requestedTypes = new Set(blueprint.sections.map((section) => section.type));
  const uncoveredConcepts = conceptKeys.filter(
    (key) =>
      !inScope.some(
        (candidate) =>
          requestedTypes.has(candidate.type) &&
          usable(candidate) &&
          candidate.conceptKeys.includes(key),
      ),
  );
  return { picked, shortfalls, uncoveredConcepts, available };
}

// ── preview (API shape) ─────────────────────────────────────────────────────

export interface PreviewItem {
  ref: string;
  tier: 'bank' | 'pack';
  type: QuestionType;
  stem: string;
  concepts: string[];
  difficulty: number | null;
  points: number;
  origin: QuestionOrigin;
  verification: VerificationState;
}

export interface PaperPreview {
  seed: string;
  items: PreviewItem[];
  totalPoints: number;
  shortfalls: BlueprintResult['shortfalls'];
  /** Chosen knowledge points (ids) with no usable question. */
  uncoveredConceptIds: string[];
  available: BlueprintResult['available'];
  complete: boolean;
}
