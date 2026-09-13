import { describe, expect, it } from 'vitest';

import { generateSceneActions, generateSceneContent, type AICallFn } from '@openmaic/generation';
import type { GeneratedInteractiveContent, SceneOutline } from '@/lib/types/generation';

function baseInteractiveOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-widget',
    type: 'interactive',
    title: 'Energy Widget',
    description: 'Explore how energy changes with the slider.',
    keyPoints: ['Observe the slider', 'Set a higher energy value', 'Reveal the formula'],
    order: 0,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Energy transfer', keyVariables: ['energy'] },
    ...overrides,
  };
}

describe('widget actions direct pipeline', () => {
  it('generates a simulation from persisted Pro variables supplied as text', async () => {
    const outline = JSON.parse(JSON.stringify(baseInteractiveOutline()));
    outline.widgetOutline.keyVariables = '常数 C、初值点横坐标 x0、初值点纵坐标 y0';
    const prompts: string[] = [];
    const content = await generateSceneContent(outline, async (_system, user) => {
      prompts.push(user);
      return '<!DOCTYPE html><html><body><div id="curve">曲线</div></body></html>';
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(outline.widgetOutline.keyVariables);
    expect(content).toMatchObject({
      widgetType: 'simulation',
      html: expect.stringContaining('curve'),
    });
  });

  it('generates widget content without a second teacherActions call', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      capturedUsers.push(user);
      return '<!DOCTYPE html><html><body><div id="energy-slider"></div></body></html>';
    };

    const content = await generateSceneContent(baseInteractiveOutline(), aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(capturedUsers).toHaveLength(1);
    expect(content).toMatchObject({
      html: expect.stringContaining('energy-slider'),
      widgetType: 'simulation',
    });
    expect(content && 'teacherActions' in content).toBe(false);
  });

  it('uses interactive action generation directly and preserves all four widget action types', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      capturedUsers.push(user);
      return JSON.stringify([
        {
          type: 'action',
          name: 'widget_highlight',
          params: { target: '#energy-slider', content: 'Watch this control first.' },
        },
        {
          type: 'action',
          name: 'widget_setState',
          params: { state: { energy: 82 }, content: 'Set energy to a high value.' },
        },
        {
          type: 'action',
          name: 'widget_annotation',
          params: { target: '#result-card', content: 'This result reflects the new state.' },
        },
        {
          type: 'action',
          name: 'widget_reveal',
          params: { target: '#hidden-formula', content: 'Reveal the formula behind it.' },
        },
      ]);
    };
    const legacyContent = {
      html: '<!DOCTYPE html><html><body><div id="energy-slider"></div></body></html>',
      widgetType: 'simulation',
      teacherActions: [
        {
          id: 'legacy-highlight',
          type: 'highlight',
          target: '#legacy',
          content: 'Legacy action should be ignored.',
        },
      ],
    } as unknown as GeneratedInteractiveContent;

    const actions = await generateSceneActions(baseInteractiveOutline(), legacyContent, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(capturedUsers).toHaveLength(1);
    expect(capturedUsers[0]).toContain('widget_highlight');
    expect(actions.map((action) => action.type)).toEqual([
      'widget_highlight',
      'widget_setState',
      'widget_annotation',
      'widget_reveal',
    ]);
    expect(actions).toEqual([
      expect.objectContaining({
        type: 'widget_highlight',
        target: '#energy-slider',
        content: 'Watch this control first.',
      }),
      expect.objectContaining({
        type: 'widget_setState',
        state: { energy: 82 },
        content: 'Set energy to a high value.',
      }),
      expect.objectContaining({
        type: 'widget_annotation',
        target: '#result-card',
        content: 'This result reflects the new state.',
      }),
      expect.objectContaining({
        type: 'widget_reveal',
        target: '#hidden-formula',
        content: 'Reveal the formula behind it.',
      }),
    ]);
  });

  it('defaults widget_setState.state to {} when the LLM omits it', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify([
        {
          type: 'action',
          name: 'widget_setState',
          params: { content: 'Update the widget.' },
        },
      ]);
    const content = {
      html: '<!DOCTYPE html><html><body></body></html>',
      widgetType: 'simulation',
    } as unknown as GeneratedInteractiveContent;

    const actions = await generateSceneActions(baseInteractiveOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'widget_setState',
        state: {},
        content: 'Update the widget.',
      }),
    ]);
  });
});
