import type { AgentTool } from '@earendil-works/pi-agent-core';
import { courseSystemPrompt, DSL_TOOLS_PROMPT } from './course-tools';

type PromptBlocks = Parameters<typeof courseSystemPrompt>[0];

/** Pure runner assembly seam: tests can pin the exact registered name set. */
export function assembleRunnerTools(
  ...groups: ReadonlyArray<ReadonlyArray<AgentTool>>
): AgentTool[] {
  return groups.flat();
}

export interface ProCourseRuntimeBoundary {
  before(toolName: string): { block: true; reason: string } | undefined;
  after(toolName: string, isError: boolean): { terminate: true } | undefined;
}

/**
 * A claimed Pro run may plan and enqueue a whole course, or perform one
 * targeted page generation against an existing course. It must not become a
 * second whole-course executor beside generation-worker. Creating a stage is
 * still allowed for the layout-preserving PPT importer.
 */
export function createProCourseRuntimeBoundary(): ProCourseRuntimeBoundary {
  let creatingStage = false;
  let createdStage = false;
  let sceneReserved = false;
  let sceneCompleted = false;
  let submitReserved = false;
  let submitted = false;
  const wholeCourseReason =
    'Complete new courses must be submitted once with submit_course_generation. generate_scene remains available for one targeted page in an existing course; create_stage may be followed by import_pptx.';
  return {
    before(toolName) {
      if (toolName === 'submit_course_generation') {
        if (submitReserved || submitted) {
          return { block: true, reason: 'A whole-course generation job was already submitted.' };
        }
        submitReserved = true;
        return undefined;
      }
      if (toolName === 'create_stage') {
        if (submitted || submitReserved) return { block: true, reason: wholeCourseReason };
        creatingStage = true;
        return undefined;
      }
      if (toolName === 'generate_scene') {
        if (
          creatingStage ||
          createdStage ||
          sceneReserved ||
          sceneCompleted ||
          submitReserved ||
          submitted
        ) {
          return { block: true, reason: wholeCourseReason };
        }
        sceneReserved = true;
      }
      return undefined;
    },
    after(toolName, isError) {
      if (toolName === 'create_stage') {
        creatingStage = false;
        if (!isError) createdStage = true;
      } else if (toolName === 'generate_scene') {
        sceneReserved = false;
        if (!isError) sceneCompleted = true;
      } else if (toolName === 'submit_course_generation') {
        submitReserved = false;
        if (!isError) {
          submitted = true;
          return { terminate: true };
        }
      } else if (toolName === 'get_course_generation_status' && !isError) {
        return { terminate: true };
      }
      return undefined;
    },
  };
}

/** The DSL compatibility block is part of every runner prompt. */
export function buildRunnerCoursePrompt(blocks: Omit<PromptBlocks, 'dslTools'>): string {
  return (
    courseSystemPrompt({ ...blocks, dslTools: DSL_TOOLS_PROMPT }) +
    '\nWhen generating a course, carry forward the topic, prior knowledge, learning goals and scope already established in the conversation into each page brief and materialFacts. A final message such as "生成课程" is a continuation of that request. Follow active skills without adding a fixed number of questions.'
  );
}
