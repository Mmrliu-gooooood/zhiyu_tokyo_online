/**
 * Classmates in Pro sessions (learning plan B04).
 *
 * `list_classmates` shows the session owner's active classmate templates.
 * `submit_course_generation` then takes their ids (`classmateIds`) and the
 * server adds each one's saved snapshot to the course cast — the model never
 * copies a persona, avatar or voice, so it cannot alter or invent a
 * classmate. The owner is captured from the claimed session, never a tool
 * parameter.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import { DEFAULT_AGENTS } from '@/lib/orchestration/registry/defaults';
import {
  CLASSMATE_LIMITS,
  classmateRosterConfig,
  type ClassmateRosterConfig,
  type ClassmateSnapshot,
  type ClassmateVoice,
} from '@/lib/study/classmates/contracts';
import type { AgentSessionMediaConfig } from './course-tools';
import { effectiveSessionVoiceConfigs, mediaConfigVoiceSource } from './effective-voice-directory';

export interface ClassmateRosterSource {
  /** The owner's active templates at their current revision. */
  listActive(): Promise<Array<{ id: string; revision: number; snapshot: ClassmateSnapshot }>>;
}

const ListParams = Type.Object({});

export function buildClassmateTools(source: ClassmateRosterSource): AgentTool<never, never>[] {
  const list: AgentTool<typeof ListParams, unknown> = {
    name: 'list_classmates',
    label: 'List classmates',
    description:
      'List the classmates (learning companions) this student created. To bring some into a new course, pass their ids as classmateIds to submit_course_generation; the server adds their saved name, persona, avatar and voice. Do not copy a classmate into agents yourself. At most 3 per course.',
    parameters: ListParams,
    async execute() {
      const classmates = await source.listActive();
      const details = classmates.map(({ id, snapshot }) => ({
        id,
        name: snapshot.name,
        role: snapshot.role,
        learningStyle: snapshot.learningStyle,
        speechPolicy: snapshot.speechPolicy,
        persona: Array.from(snapshot.persona).slice(0, 160).join(''),
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: details.length
              ? JSON.stringify(details, null, 2)
              : 'The student has no active classmates. Do not pass classmateIds.',
          },
        ],
        details: { classmates: details },
      };
    },
  };
  return [list] as unknown as AgentTool<never, never>[];
}

/** Keep a classmate's voice only when this session can actually speak with it. */
function voiceForSession(
  voice: ClassmateVoice | undefined,
  mediaConfig: AgentSessionMediaConfig | undefined,
): ClassmateVoice | undefined {
  if (!voice || !mediaConfig) return undefined;
  try {
    const available = effectiveSessionVoiceConfigs(mediaConfigVoiceSource(mediaConfig));
    const usable = available.some(
      (candidate) =>
        candidate.voice === voice.voiceId &&
        (voice.source === 'platform'
          ? candidate.source === 'platform' && candidate.defaultId === voice.defaultId
          : candidate.providerId === voice.providerId &&
            (candidate.source ?? 'legacy-managed') === (voice.source ?? 'legacy-managed')),
    );
    return usable ? voice : undefined;
  } catch {
    return undefined;
  }
}

export type ClassmateCastResult =
  | { ok: true; agents: unknown[] }
  | { ok: false; code: string; message: string };

/**
 * The cast to submit: the model's agents (or, when it supplied none, the
 * system teacher) plus the requested classmates' snapshots.
 */
export async function castWithClassmates(input: {
  classmateIds: readonly string[];
  agents: readonly unknown[] | undefined;
  source: ClassmateRosterSource | undefined;
  mediaConfig: AgentSessionMediaConfig | undefined;
}): Promise<ClassmateCastResult> {
  if (!input.source) {
    return {
      ok: false,
      code: 'CLASSMATES_UNAVAILABLE',
      message: 'Classmates are not available here. Submit without classmateIds.',
    };
  }
  const ids = [...new Set(input.classmateIds)];
  if (ids.length > CLASSMATE_LIMITS.classmatesPerClassroom) {
    return {
      ok: false,
      code: 'CLASSMATES_TOO_MANY',
      message: `Choose at most ${CLASSMATE_LIMITS.classmatesPerClassroom} classmates for one course.`,
    };
  }
  const active = new Map((await input.source.listActive()).map((item) => [item.id, item]));
  const missing = ids.filter((id) => !active.has(id));
  if (missing.length) {
    return {
      ok: false,
      code: 'CLASSMATE_NOT_FOUND',
      message: `Unknown or archived classmates: ${missing.join(', ')}. Call list_classmates and use its ids.`,
    };
  }
  const cast: ClassmateRosterConfig[] = ids.map((id) => {
    const { revision, snapshot } = active.get(id)!;
    const entry = classmateRosterConfig(id, revision, snapshot);
    const voiceConfig = voiceForSession(entry.voiceConfig, input.mediaConfig);
    const { voiceConfig: _dropped, ...rest } = entry;
    return voiceConfig ? { ...rest, voiceConfig } : rest;
  });
  const castIds = new Set(cast.map((entry) => entry.id));
  const teacher = DEFAULT_AGENTS['default-1']!;
  const base = input.agents?.length
    ? input.agents.filter(
        (agent) =>
          !(
            agent &&
            typeof agent === 'object' &&
            castIds.has((agent as { id?: unknown }).id as string)
          ),
      )
    : [
        {
          id: teacher.id,
          name: teacher.name,
          role: teacher.role,
          persona: teacher.persona,
          avatar: teacher.avatar,
          color: teacher.color,
          priority: teacher.priority,
        },
      ];
  return { ok: true, agents: [...base, ...cast] };
}
