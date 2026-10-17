// @vitest-environment jsdom

/**
 * `?scene=` (the wrong-answer book's "look back", learning plan B10): the
 * page is taken from the URL once, saved as this device's position before
 * the classroom loads, still owed to a load that starts again (an effect run
 * twice), and opened — or reported missing — after loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ scene: [] as unknown[][], cursor: [] as unknown[][] }));
vi.mock('@/lib/document-store/current-scene', () => ({
  saveCurrentScene: vi.fn(async (...args: unknown[]) => void saved.scene.push(args)),
}));
vi.mock('@/lib/playback/cursor', () => ({
  saveCursor: vi.fn(async (...args: unknown[]) => void saved.cursor.push(args)),
}));
vi.mock('@/lib/study/spaces/pending-links', () => ({
  flushPendingStudyLinks: vi.fn(async () => {}),
}));
vi.mock('@/lib/study/progress/resume', () => ({
  applyStudyResume: vi.fn(),
  checkStudyResume: vi.fn(),
}));

import {
  openStudyScene,
  prepareStudySceneFromUrl,
  type StudyResumeUi,
} from '@/lib/study/progress/classroom-resume';

function ui(pages: Record<string, number>) {
  const jumps: string[] = [];
  const value: StudyResumeUi = {
    pageOf: (sceneId) => pages[sceneId] ?? null,
    currentSceneId: () => null,
    jumpTo: (sceneId) => void jumps.push(sceneId),
    notify: () => {},
    isCurrent: () => true,
  };
  return { value, jumps };
}

beforeEach(() => {
  saved.scene.length = 0;
  saved.cursor.length = 0;
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('classroom ?scene= link', () => {
  it('saves the page before loading, survives a second load start and opens it once', async () => {
    window.history.replaceState(null, '', '/classroom/stage-a?scene=quiz-1&x=1');
    expect(await prepareStudySceneFromUrl('stage-a')).toBe('quiz-1');
    expect(window.location.search).toBe('?x=1');
    expect(saved.scene).toEqual([['stage-a', 'quiz-1']]);
    expect(saved.cursor[0]).toMatchObject(['stage-a', { sceneId: 'quiz-1', actionIndex: 0 }]);
    // The load started again: the parameter is gone from the URL, the page is still owed.
    expect(await prepareStudySceneFromUrl('stage-a')).toBe('quiz-1');
    expect(await prepareStudySceneFromUrl('stage-b')).toBeNull();
    const { value, jumps } = ui({ 'quiz-1': 3 });
    expect(openStudyScene('stage-a', 'quiz-1', value)).toBe(true);
    expect(jumps).toEqual(['quiz-1']);
    // Opened: a later visit without the parameter resumes normally.
    expect(await prepareStudySceneFromUrl('stage-a')).toBeNull();
  });

  it('reports a page that is not in the course and ignores malformed ids', async () => {
    window.history.replaceState(null, '', '/classroom/stage-a?scene=gone');
    expect(await prepareStudySceneFromUrl('stage-a')).toBe('gone');
    const { value, jumps } = ui({});
    expect(openStudyScene('stage-a', 'gone', value)).toBe(false);
    expect(jumps).toEqual([]);
    window.history.replaceState(null, '', '/classroom/stage-a?scene=%3Cscript%3E');
    expect(await prepareStudySceneFromUrl('stage-a')).toBeNull();
    expect(window.location.search).toBe('');
    expect(saved.scene).toEqual([['stage-a', 'gone']]);
  });
});
