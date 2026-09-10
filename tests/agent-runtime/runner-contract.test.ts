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
    expect(boundary.before('submit_course_generation')).toBeUndefined();
    expect(boundary.after('submit_course_generation', false)).toEqual({ terminate: true });
    expect(boundary.before('generate_scene')).toMatchObject({ block: true });

    const resumed = createProCourseRuntimeBoundary();
    expect(resumed.after('get_course_generation_status', false)).toEqual({ terminate: true });
  });

  it('keeps imports and one existing-page operation, but blocks synchronous new-course loops', () => {
    const imported = createProCourseRuntimeBoundary();
    expect(imported.before('create_stage')).toBeUndefined();
    expect(imported.after('create_stage', false)).toBeUndefined();
    expect(imported.before('import_pptx')).toBeUndefined();
    expect(imported.before('generate_scene')).toMatchObject({
      block: true,
      reason: expect.stringContaining('submit_course_generation'),
    });

    const editing = createProCourseRuntimeBoundary();
    expect(editing.before('generate_scene')).toBeUndefined();
    expect(editing.after('generate_scene', false)).toBeUndefined();
    expect(editing.before('generate_scene')).toMatchObject({ block: true });
    expect(editing.before('patch_stage')).toBeUndefined();

    const retry = createProCourseRuntimeBoundary();
    expect(retry.before('generate_scene')).toBeUndefined();
    expect(retry.after('generate_scene', true)).toBeUndefined();
    expect(retry.before('generate_scene')).toBeUndefined();
  });
});
