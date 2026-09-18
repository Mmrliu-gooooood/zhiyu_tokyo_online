import { describe, expect, it } from 'vitest';

import { createLearningContentSnapshot } from '@/lib/learning/content-snapshot';
import type { Scene } from '@/lib/types/stage';

function scenes(): Scene[] {
  return [
    {
      id: 'slide-1',
      stageId: 'stage-1',
      order: 0,
      title: 'Forces',
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas-1',
          elements: [
            { id: 't1', type: 'text', content: '<p>Net <b>force</b> changes motion.</p>' },
            {
              id: 'c1',
              type: 'code',
              language: 'python',
              lines: [{ id: 'L1', content: 'f = m*a' }],
            },
            { id: 'l1', type: 'latex', latex: 'F=ma' },
            {
              id: 'table-1',
              type: 'table',
              data: [[{ id: 'cell', colspan: 1, rowspan: 1, text: 'mass' }]],
            },
          ],
        },
      },
    },
    {
      id: 'quiz-1',
      stageId: 'stage-1',
      order: 1,
      title: 'Quick check',
      type: 'quiz',
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: 'What does net force change?',
            options: [
              { label: 'Motion', value: 'A' },
              { label: 'Color', value: 'B' },
            ],
            answer: ['A'],
            analysis: 'Acceleration changes.',
            points: 2,
          },
        ],
      },
    },
    {
      id: 'interactive-1',
      stageId: 'stage-1',
      order: 2,
      title: 'Force lab',
      type: 'interactive',
      content: {
        type: 'interactive',
        html: '<main><h1>Drag the force arrow</h1></main><script>doNotExecute()</script>',
        widgetType: 'simulation',
        widgetConfig: { type: 'simulation', task: 'Balance the forces' },
      },
    },
    {
      id: 'pbl-1',
      stageId: 'stage-1',
      order: 3,
      title: 'Bridge project',
      type: 'pbl',
      content: {
        type: 'pbl',
        projectV2: {
          uiPhase: 'workspace',
          status: 'active',
          title: 'Bridge project',
          description: 'Design a stable bridge.',
          proficiency: 'beginner',
          language: 'en-US',
          tags: ['forces'],
          roles: [
            {
              id: 'teacher',
              type: 'instructor',
              name: 'Coach',
              description: 'Guides the learner.',
            },
          ],
          milestones: [
            {
              id: 'm1',
              title: 'Plan loads',
              status: 'active',
              order: 0,
              microtasks: [
                {
                  id: 'mt1',
                  title: 'Draw a force diagram',
                  status: 'in_progress',
                  assignee: 'user',
                  hints: ['Mark every external force'],
                  order: 0,
                },
              ],
              documents: [],
              briefing: 'Explain the load paths.',
              completionCriteria: 'All loads are represented.',
              debrief: 'Compare the load paths.',
            },
          ],
          submissions: [{ learner: 'must not leak' }],
          evaluations: [],
          threads: [{ agentId: 'teacher', messages: [{ content: 'learner secret' }] }],
          engagementEvents: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    },
  ] as unknown as Scene[];
}

describe('createLearningContentSnapshot', () => {
  it('extracts all four scene kinds without executing or exposing learner state', async () => {
    const snapshot = await createLearningContentSnapshot({
      courseTitle: 'Physics',
      scenes: scenes(),
    });

    expect(snapshot.contentRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.fragments.map((fragment) => fragment.sourceRef.sceneType)).toEqual([
      'slide',
      'quiz',
      'interactive',
      'pbl',
    ]);
    const text = snapshot.fragments.map((fragment) => fragment.text).join('\n');
    expect(text).toContain('Net force changes motion.');
    expect(text).toContain('What does net force change?');
    expect(text).toContain('Drag the force arrow');
    expect(text).toContain('Plan loads');
    expect(text).not.toContain('doNotExecute');
    expect(text).not.toContain('learner secret');
    expect(text).not.toContain('must not leak');
  });

  it('is stable across visual/runtime-only edits but changes for authored or interactive source edits', async () => {
    const baseScenes = scenes();
    const baseline = await createLearningContentSnapshot({
      courseTitle: 'Physics',
      scenes: baseScenes,
    });

    const visualOnly = structuredClone(baseScenes) as Scene[];
    visualOnly[0]!.updatedAt = Date.now();
    const textElement =
      visualOnly[0]!.content.type === 'slide'
        ? (visualOnly[0]!.content.canvas.elements[0] as unknown as Record<string, unknown>)
        : undefined;
    if (textElement) textElement.left = 900;
    const pblProject =
      visualOnly[3]!.content.type === 'pbl' ? visualOnly[3]!.content.projectV2 : undefined;
    if (pblProject)
      pblProject.threads[0]!.messages = [{ content: 'another learner answer' }] as never;
    const stable = await createLearningContentSnapshot({
      courseTitle: 'Physics',
      scenes: visualOnly,
    });
    expect(stable.contentRevision).toBe(baseline.contentRevision);

    const changedInteractive = structuredClone(baseScenes) as Scene[];
    if (changedInteractive[2]!.content.type === 'interactive') {
      changedInteractive[2]!.content.html += '<!-- authored-v2 -->';
    }
    expect(
      (await createLearningContentSnapshot({ courseTitle: 'Physics', scenes: changedInteractive }))
        .contentRevision,
    ).not.toBe(baseline.contentRevision);
  });

  it('digests the exact truncated fragments that are sent to the model', async () => {
    const source = scenes()[0]!;
    const manyScenes = Array.from({ length: 13 }, (_, index) => {
      const scene = structuredClone(source) as Scene;
      scene.id = `scene-${index}`;
      scene.order = index;
      if (scene.content.type === 'slide') {
        const element = scene.content.canvas.elements[0] as unknown as { content: string };
        element.content = index === 0 ? 'short' : 'x'.repeat(3_000);
      }
      return scene;
    });
    const snapshot = await createLearningContentSnapshot({
      courseTitle: 'Bounded course',
      scenes: manyScenes,
    });
    const last = snapshot.fragments.at(-1)!;
    const bytes = new TextEncoder().encode(last.text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const expected = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;

    expect(snapshot.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBe(
      24_000,
    );
    expect(last.text.length).toBeLessThan(2_000);
    expect(last.digest).toBe(expected);
  });
});
