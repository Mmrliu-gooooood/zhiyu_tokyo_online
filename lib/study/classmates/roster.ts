/**
 * Classroom rosters with classmates (learning plan B04). Pure.
 *
 * When the student brings classmates into a new classroom, the whole chosen
 * roster is frozen onto the stage (`stage.generatedAgentConfigs`), so the
 * course plays the same on every device and keeps playing after the
 * templates change or are archived. A classmate enters as the snapshot of
 * its current revision (`<classmateId>-r<revision>`); built-in agents keep
 * their ids and stay the code-defined entries. Rosters without classmates are
 * not touched here: they keep the existing preset behaviour.
 */
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { CLASSMATE_LIMITS, classmateStageAgentId } from './contracts';

/** The stage agent id a picked agent takes in a new classroom. */
export function rosterAgentId(agent: Pick<AgentConfig, 'id' | 'classmate'>): string {
  return agent.classmate
    ? classmateStageAgentId(agent.classmate.id, agent.classmate.revision)
    : agent.id;
}

export function countClassmates(agents: ReadonlyArray<Pick<AgentConfig, 'classmate'>>): number {
  return agents.filter((agent) => agent.classmate).length;
}

/**
 * The roster to freeze for a new classroom, or null when no classmate was
 * picked. `voiceFor` returns the voice the student set for an agent on this
 * device (it wins over the agent's own voice, as elsewhere in generation).
 */
export function buildClassmateRoster(
  picked: ReadonlyArray<AgentConfig>,
  voiceFor: (agentId: string) => AgentConfig['voiceConfig'] | undefined,
): GeneratedAgentConfig[] | null {
  const classmates = countClassmates(picked);
  if (classmates === 0) return null;
  if (classmates > CLASSMATE_LIMITS.classmatesPerClassroom) {
    throw new Error('CLASSMATE_ROSTER_TOO_LARGE');
  }
  return picked.map((agent) => {
    const voice = voiceFor(agent.id) ?? agent.voiceConfig;
    return {
      id: rosterAgentId(agent),
      name: agent.name,
      role: agent.role,
      persona: agent.persona,
      avatar: agent.avatar,
      color: agent.color,
      priority: agent.priority,
      ...(voice ? { voiceConfig: voice } : {}),
    };
  });
}
