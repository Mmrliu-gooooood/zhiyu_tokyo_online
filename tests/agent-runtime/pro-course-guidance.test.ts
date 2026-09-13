import { describe, expect, it, vi } from 'vitest';
import {
  buildRosterTools,
  ROSTER_TOOLS_PROMPT,
  type CourseStore,
} from '@/lib/server/agent-runtime/roster-tools';
import { DSL_TOOLS_PROMPT } from '@/lib/server/agent-runtime/course-tools';
import {
  buildRunnerCoursePrompt,
  createProCourseRuntimeBoundary,
} from '@/lib/server/agent-runtime/runner-contract';

function rosterTools() {
  const store = { loadDocument: vi.fn(async () => null), saveDocument: vi.fn() };
  return {
    store,
    tools: buildRosterTools({
      store: store as unknown as CourseStore,
      onCheckpoint: vi.fn(),
      providerConfigs: [],
    }),
  };
}

describe('Pro course tool guidance stays consistent with the execution boundary', () => {
  it('guides whole-course voice selection to submission without prescribing a stage write', () => {
    const { tools } = rosterTools();
    const list = tools.find((tool) => tool.name === 'list_voices')!;
    const set = tools.find((tool) => tool.name === 'set_roster')!;
    expect(list.description).toContain('submit_course_generation');
    expect(list.description).not.toContain('BEFORE set_roster');
    expect(set.description).toContain('existing');
    expect(set.description).toContain('PPTX');
    expect(set.description).toContain('submit_course_generation');
    // Both valid workflows still discover the same tools; runtime authorization is unchanged.
    expect(tools.map((tool) => tool.name)).toEqual(['list_voices', 'set_roster']);
  });
  it('does not tell an unsubmitted course to create a stage after roster lookup fails', async () => {
    const { tools, store } = rosterTools();
    const result = await tools
      .find((tool) => tool.name === 'set_roster')!
      .execute(
        'call',
        {
          stageId: 'uncreated-stage',
          agents: [
            { name: 'Teacher', role: 'teacher', persona: 'Teaches' },
            { name: 'Assistant', role: 'assistant', persona: 'Assists' },
          ],
        } as never,
        undefined,
        undefined,
      );
    const text = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain('submit_course_generation');
    expect(text).toContain('PPTX');
    expect(text).not.toContain('call create_stage first, then set_roster');
    expect(store.saveDocument).not.toHaveBeenCalled();
  });
  it('keeps the composed runner prompt explicit about submission and valid stage references', () => {
    const prompt = buildRunnerCoursePrompt({ roster: ROSTER_TOOLS_PROMPT });
    expect(ROSTER_TOOLS_PROMPT).toContain('submit_course_generation.agents');
    expect(ROSTER_TOOLS_PROMPT).toContain('stable id');
    expect(prompt).not.toContain('The classroom roster is written with set_roster:');
    expect(DSL_TOOLS_PROMPT).not.toContain('generate_roster → set_roster');
    expect(DSL_TOOLS_PROMPT).not.toContain('stageId obtained from create_stage');
    expect(DSL_TOOLS_PROMPT).toContain('verified');
  });
  it('retains existing-course and original PPTX capabilities while rejecting a synchronous new course', () => {
    expect(createProCourseRuntimeBoundary().before('create_stage', 'new-course')).toMatchObject({
      block: true,
    });
    expect(createProCourseRuntimeBoundary().before('generate_scene', 'new-course')).toMatchObject({
      block: true,
    });
    expect(createProCourseRuntimeBoundary().before('create_stage', 'pptx-import')).toBeUndefined();
    expect(createProCourseRuntimeBoundary().before('import_pptx', 'pptx-import')).toBeUndefined();
    expect(
      createProCourseRuntimeBoundary().before('generate_scene', 'existing-course-edit'),
    ).toBeUndefined();
    expect(
      createProCourseRuntimeBoundary().before('set_roster', 'existing-course-edit'),
    ).toBeUndefined();
  });
});
