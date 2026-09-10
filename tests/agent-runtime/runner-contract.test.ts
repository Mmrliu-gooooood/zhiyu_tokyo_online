import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  assembleRunnerTools,
  createProCourseRuntimeBoundary,
} from '@/lib/server/agent-runtime/runner-contract';

function tool(name: string): AgentTool {
  return { name, description: `tool-${name}` } as unknown as AgentTool;
}

describe('assembleRunnerTools', () => {
  it('flattens tool groups into a single runner tool list, preserving order', () => {
    const tools = assembleRunnerTools([tool('a'), tool('b')], [], [tool('c')]);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list when no groups are given', () => {
    expect(assembleRunnerTools()).toEqual([]);
  });

  it('ends a run after whole-course submission or a status observation', () => {
    const boundary = createProCourseRuntimeBoundary();
    expect(boundary.before('submit_course_generation', 'new-course')).toBeUndefined();
    expect(boundary.after('submit_course_generation', false)).toEqual({ terminate: true });
    expect(boundary.before('generate_scene', 'new-course')).toMatchObject({ block: true });

    const resumed = createProCourseRuntimeBoundary();
    expect(resumed.after('get_course_generation_status', false)).toEqual({ terminate: true });
  });

  it('uses durable operation intent instead of call count to separate new courses and edits', () => {
    const newCourse = createProCourseRuntimeBoundary();
    expect(newCourse.before('generate_scene', 'new-course')).toMatchObject({
      block: true,
      reason: expect.stringContaining('submit_course_generation'),
    });
    expect(newCourse.before('create_stage', 'new-course')).toMatchObject({ block: true });

    const imported = createProCourseRuntimeBoundary();
    expect(imported.before('create_stage', 'pptx-import')).toBeUndefined();
    expect(imported.after('create_stage', false)).toBeUndefined();
    expect(imported.before('import_pptx', 'pptx-import')).toBeUndefined();
    expect(imported.before('generate_scene', 'pptx-import')).toMatchObject({
      block: true,
      reason: expect.stringContaining('submit_course_generation'),
    });

    const editing = createProCourseRuntimeBoundary();
    expect(editing.before('generate_scene', 'existing-course-edit')).toBeUndefined();
    expect(editing.after('generate_scene', false)).toBeUndefined();
    expect(editing.before('generate_scene', 'existing-course-edit')).toMatchObject({ block: true });
    expect(editing.before('patch_stage', 'existing-course-edit')).toBeUndefined();

    const retry = createProCourseRuntimeBoundary();
    expect(retry.before('generate_scene', 'existing-course-edit')).toBeUndefined();
    expect(retry.after('generate_scene', true)).toBeUndefined();
    expect(retry.before('generate_scene', 'existing-course-edit')).toBeUndefined();
  });

  it('cannot evade the new-course boundary by starting a later run', () => {
    for (let turn = 0; turn < 3; turn += 1) {
      const resumedBoundary = createProCourseRuntimeBoundary();
      expect(resumedBoundary.before('generate_scene', 'new-course')).toMatchObject({ block: true });
    }
  });
});
