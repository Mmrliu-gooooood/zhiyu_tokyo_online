/**
 * Pure study-space rules (learning plan B01): input validation, the resume
 * decision between device and server positions, and what the pages show.
 */
import { describe, expect, it } from 'vitest';

import {
  calendarDateIn,
  daysUntilExam,
  parseProgressWrite,
  parseStudySpaceInput,
  parseStudySpacePatch,
  type StudyCourseProgressView,
  type StudySpaceCourse,
  type StudySpaceSummary,
} from '@/lib/study/spaces/contracts';
import { decideStudyResume, localPositionTime } from '@/lib/study/progress/resume';
import {
  courseViewStatus,
  pickContinueCourse,
  pickGlobalContinue,
  spaceNextStep,
  viewedPercent,
} from '@/lib/study/spaces/view-model';

function progress(overrides: Partial<StudyCourseProgressView> = {}): StudyCourseProgressView {
  return {
    stageId: 'stage-1',
    courseName: 'c',
    sceneId: 's2',
    sceneIndex: 1,
    sceneCount: 4,
    actionIndex: 3,
    actionId: 'a3',
    furthestSceneIndex: 2,
    reachedEnd: false,
    sceneChanged: false,
    sceneMissing: false,
    resumeSceneId: 's2',
    resumeActionIndex: 3,
    revision: 2,
    observedAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:01.000Z',
    ...overrides,
  };
}

function course(stageId: string, overrides: Partial<StudySpaceCourse> = {}): StudySpaceCourse {
  return {
    stageId,
    name: stageId,
    sceneCount: 4,
    generation: 'complete',
    addedAt: '2026-10-01T00:00:00.000Z',
    addedVia: 'link',
    courseUpdatedAt: '2026-10-01T00:00:00.000Z',
    progress: null,
    ...overrides,
  };
}

describe('study space input', () => {
  it('trims, normalizes empty optional fields to null and rejects bad values', () => {
    expect(
      parseStudySpaceInput({
        name: '  高等数学 ',
        educationLevel: 'university',
        subject: '',
        goal: ' 85 分 ',
        examDate: '2027-01-08',
        timezone: 'Asia/Shanghai',
        unknown: 'ignored',
      }),
    ).toEqual({
      ok: true,
      value: {
        name: '高等数学',
        educationLevel: 'university',
        subject: null,
        goal: '85 分',
        examDate: '2027-01-08',
        examScope: null,
        timezone: 'Asia/Shanghai',
      },
    });
    expect(parseStudySpaceInput({ name: '   ' })).toEqual({ ok: false, field: 'name' });
    expect(parseStudySpaceInput({ name: 'x'.repeat(61) })).toEqual({ ok: false, field: 'name' });
    // 60 Chinese characters fit: the limit counts characters, not bytes.
    expect(parseStudySpaceInput({ name: '数'.repeat(60) }).ok).toBe(true);
    expect(parseStudySpaceInput({ name: 'x', educationLevel: 'phd' })).toEqual({
      ok: false,
      field: 'educationLevel',
    });
    expect(parseStudySpaceInput({ name: 'x', examDate: '2027-02-30' })).toEqual({
      ok: false,
      field: 'examDate',
    });
    expect(parseStudySpaceInput({ name: 'x', timezone: 'Mars/Base' })).toEqual({
      ok: false,
      field: 'timezone',
    });
  });

  it('changes only the fields a patch names', () => {
    expect(parseStudySpacePatch({ goal: '' })).toEqual({ ok: true, value: { goal: null } });
    expect(parseStudySpacePatch({ status: 'archived' })).toEqual({
      ok: true,
      value: { status: 'archived' },
    });
    expect(parseStudySpacePatch({})).toEqual({ ok: false, field: 'body' });
    expect(parseStudySpacePatch({ status: 'deleted' })).toEqual({ ok: false, field: 'status' });
    expect(parseStudySpacePatch({ name: '' })).toEqual({ ok: false, field: 'name' });
  });

  it('validates progress writes without trusting anything but position and time', () => {
    expect(
      parseProgressWrite({
        sceneId: 's1',
        actionIndex: 2,
        baseRevision: 3,
        observedAt: '2026-10-04T10:00:00Z',
      }),
    ).toEqual({
      ok: true,
      value: {
        sceneId: 's1',
        actionIndex: 2,
        baseRevision: 3,
        observedAt: '2026-10-04T10:00:00.000Z',
      },
    });
    expect(parseProgressWrite({ sceneId: 's1', observedAt: '2026-10-04T10:00:00Z' })).toMatchObject(
      { ok: true, value: { actionIndex: null, baseRevision: null } },
    );
    expect(parseProgressWrite({ sceneId: 's1', actionIndex: -1, observedAt: 'x' })).toEqual({
      ok: false,
      field: 'actionIndex',
    });
    expect(parseProgressWrite({ sceneId: 'a\u0000b', observedAt: '2026-10-04' })).toEqual({
      ok: false,
      field: 'sceneId',
    });
    expect(
      parseProgressWrite({ sceneId: 's1', baseRevision: 0, observedAt: '2026-10-04' }),
    ).toEqual({ ok: false, field: 'baseRevision' });
  });

  it('counts exam days between calendar dates in the space time zone', () => {
    expect(daysUntilExam('2027-01-08', '2026-12-30')).toBe(9);
    expect(daysUntilExam('2027-01-08', '2027-01-08')).toBe(0);
    expect(daysUntilExam(null, '2027-01-08')).toBeNull();
    // 2026-10-04 23:30 UTC is already 10-05 in Shanghai.
    expect(calendarDateIn('Asia/Shanghai', new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
    expect(calendarDateIn('UTC', new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-04');
  });
});

describe('cross-device resume decision', () => {
  it('opens at the newer of the device and server positions', () => {
    const server = progress({ observedAt: '2026-10-04T10:00:00.000Z' });
    expect(decideStudyResume(null, 0)).toEqual({ kind: 'none' });
    expect(decideStudyResume(server, Date.parse('2026-10-04T10:05:00.000Z'))).toEqual({
      kind: 'local-newer',
    });
    expect(decideStudyResume(server, Date.parse('2026-10-04T09:00:00.000Z'))).toEqual({
      kind: 'server-newer',
      sceneId: 's2',
      actionIndex: 3,
      notice: null,
    });
    // Never opened on this device: the server position wins.
    expect(decideStudyResume(server, 0).kind).toBe('server-newer');
  });

  it('uses the server resume target and explains edited or deleted pages', () => {
    expect(
      decideStudyResume(progress({ sceneChanged: true, resumeActionIndex: 0 }), 0),
    ).toMatchObject({ sceneId: 's2', actionIndex: 0, notice: 'scene-changed' });
    expect(
      decideStudyResume(progress({ sceneMissing: true, resumeSceneId: null }), 0),
    ).toMatchObject({ sceneId: null, notice: 'scene-missing' });
  });

  it('takes the latest of the device scene and cursor times', () => {
    expect(localPositionTime(null, null)).toBe(0);
    expect(
      localPositionTime(
        { updatedAt: '2026-10-04T09:00:00.000Z' },
        { updatedAt: '2026-10-04T09:30:00.000Z' },
      ),
    ).toBe(Date.parse('2026-10-04T09:30:00.000Z'));
    expect(localPositionTime({ updatedAt: 'garbage' }, null)).toBe(0);
  });
});

describe('study page view model', () => {
  it('shows viewing status and share of pages seen, never mastery', () => {
    expect(courseViewStatus(null)).toBe('not-started');
    expect(courseViewStatus(progress())).toBe('in-progress');
    expect(courseViewStatus(progress({ reachedEnd: true }))).toBe('reached-end');
    expect(viewedPercent(progress(), 4)).toBe(75);
    expect(viewedPercent(progress({ reachedEnd: true }), 4)).toBe(100);
    expect(viewedPercent(progress({ furthestSceneIndex: 9 }), 4)).toBe(100);
    expect(viewedPercent(null, 4)).toBe(0);
  });

  it('continues the latest unfinished course, then a fresh one, then the latest finished', () => {
    const done = course('done', {
      progress: progress({ reachedEnd: true, updatedAt: '2026-10-04T12:00:00.000Z' }),
    });
    const mid = course('mid', { progress: progress({ updatedAt: '2026-10-04T08:00:00.000Z' }) });
    const fresh = course('fresh', { addedAt: '2026-10-02T00:00:00.000Z' });
    const older = course('older-fresh', { addedAt: '2026-10-01T00:00:00.000Z' });
    expect(pickContinueCourse([done, mid, fresh])?.stageId).toBe('mid');
    expect(pickContinueCourse([done, fresh, older])?.stageId).toBe('older-fresh');
    expect(pickContinueCourse([done])?.stageId).toBe('done');
    expect(pickContinueCourse([])).toBeNull();
  });

  it('picks the most recent course across active spaces only', () => {
    const space = (id: string, status: 'active' | 'archived', updatedAt: string) =>
      ({
        id,
        status,
        lastStudied: progress({ stageId: id, updatedAt }),
      }) as StudySpaceSummary;
    expect(
      pickGlobalContinue([
        space('a', 'active', '2026-10-04T08:00:00.000Z'),
        space('b', 'active', '2026-10-04T09:00:00.000Z'),
        space('c', 'archived', '2026-10-04T10:00:00.000Z'),
      ])?.space.id,
    ).toBe('b');
  });
});

describe('spaceNextStep', () => {
  const space = (overrides: Partial<StudySpaceSummary>) =>
    ({
      id: 'sp',
      status: 'active',
      courseCount: 2,
      lastStudied: null,
      ...overrides,
    }) as StudySpaceSummary;

  it('continues the unfinished course at the page the learner stopped on', () => {
    expect(spaceNextStep(space({ lastStudied: progress({ courseName: 'Trig' }) }))).toEqual({
      kind: 'continue',
      stageId: 'stage-1',
      courseName: 'Trig',
      page: 2,
    });
  });

  it('suggests revisiting a course whose last page was viewed', () => {
    expect(
      spaceNextStep(space({ lastStudied: progress({ courseName: 'Trig', reachedEnd: true }) })),
    ).toEqual({ kind: 'revisit', courseName: 'Trig' });
  });

  it('revisits when the stopped-at page no longer exists', () => {
    expect(
      spaceNextStep(space({ lastStudied: progress({ courseName: 'Trig', sceneIndex: null }) })),
    ).toEqual({ kind: 'revisit', courseName: 'Trig' });
  });

  it('starts the first course, or adds one to an empty space', () => {
    expect(spaceNextStep(space({}))).toEqual({ kind: 'start' });
    expect(spaceNextStep(space({ courseCount: 0 }))).toEqual({ kind: 'add-first' });
  });

  it('suggests nothing for an archived space', () => {
    expect(spaceNextStep(space({ status: 'archived' }))).toBeNull();
  });
});
