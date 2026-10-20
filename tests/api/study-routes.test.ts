/**
 * Study API guard (learning plan B01): hidden unless enabled, accounts only,
 * never cached, fixed error codes, validated input, and the request owner —
 * never a body field — passed to every repository call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const repo = vi.hoisted(() => ({
  listStudySpaces: vi.fn(),
  createStudySpace: vi.fn(),
  getStudySpace: vi.fn(),
  updateStudySpace: vi.fn(),
  deleteStudySpace: vi.fn(),
  linkStudySpaceCourse: vi.fn(),
  unlinkStudySpaceCourse: vi.fn(),
  listLinkableCourses: vi.fn(),
  getCourseProgress: vi.fn(),
  writeCourseProgress: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (ownerId: string, headers: Headers) => unknown) =>
    handler(owner.id, new Headers()),
}));
vi.mock('@/lib/server/stage-access', () => ({
  getOwnerBoundStageAccessDb: vi.fn(async () => ({ bound: true })),
}));
vi.mock('@/lib/server/study/spaces/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/study/spaces/repository')>()),
  ...repo,
}));

import { StudyError } from '@/lib/server/study/spaces/repository';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as listSpaces, POST as createSpace } from '@/app/api/study/spaces/route';
import { PATCH as patchSpace } from '@/app/api/study/spaces/[spaceId]/route';
import { POST as linkCourse } from '@/app/api/study/spaces/[spaceId]/courses/route';
import { GET as getProgress, PUT as putProgress } from '@/app/api/study/progress/[stageId]/route';

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method = 'GET', body?: unknown) =>
  new Request('https://zhiyu.test/api/study/x', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('study routes', () => {
  it('report the capability and hide the family when it is off', async () => {
    expect(await (await capabilities()).json()).toEqual({
      spaces: true,
      materials: false,
      qa: false,
      classmates: false,
      companionChat: false,
      memory: false,

      exams: false,
      extraction: false,
      grading: false,
      wrongbook: false,
      practice: false,
      review: false,
    });
    vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '');
    expect(await (await capabilities()).json()).toEqual({
      spaces: false,
      materials: false,
      qa: false,
      classmates: false,
      companionChat: false,
      memory: false,

      exams: false,
      extraction: false,
      grading: false,
      wrongbook: false,
      practice: false,
      review: false,
    });
    const hidden = await listSpaces(request());
    expect(hidden.status).toBe(404);
    expect(repo.listStudySpaces).not.toHaveBeenCalled();
    // A database is required too.
    vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
    vi.stubEnv('DATABASE_URL', '');
    expect((await listSpaces(request())).status).toBe(404);
  });

  it('refuse anonymous device owners: study data belongs to accounts', async () => {
    owner.id = 'anon:device-1';
    const response = await listSpaces(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'STUDY_ACCOUNT_REQUIRED' });
    expect(repo.listStudySpaces).not.toHaveBeenCalled();
  });

  it('serve the owner’s data uncached and ignore identity fields in bodies', async () => {
    repo.listStudySpaces.mockResolvedValue([]);
    const listed = await listSpaces(request());
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('private, no-store');
    expect(repo.listStudySpaces).toHaveBeenCalledWith({ bound: true }, owner.id);

    repo.createStudySpace.mockResolvedValue({ id: 'space-1' });
    const created = await createSpace(
      request('POST', { name: '高数', ownerId: 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    );
    expect(created.status).toBe(201);
    expect(repo.createStudySpace.mock.calls[0]?.[1]).toBe(owner.id);
    expect(repo.createStudySpace.mock.calls[0]?.[2]).not.toHaveProperty('ownerId');
  });

  it('validate input with a field name and never call the repository', async () => {
    const bad = await createSpace(request('POST', { name: '' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'STUDY_INVALID_INPUT', field: 'name' });
    const noRevision = await patchSpace(
      request('PATCH', { name: 'x' }),
      params({ spaceId: 'space-1' }),
    );
    expect(await noRevision.json()).toEqual({ error: 'STUDY_INVALID_INPUT', field: 'revision' });
    const badLink = await linkCourse(
      request('POST', { stageId: '' }),
      params({ spaceId: 'space-1' }),
    );
    expect(badLink.status).toBe(400);
    const badProgress = await putProgress(
      request('PUT', { sceneId: 's1', actionIndex: 1.5, observedAt: new Date().toISOString() }),
      params({ stageId: 'stage-1' }),
    );
    expect(await badProgress.json()).toEqual({
      error: 'STUDY_INVALID_INPUT',
      field: 'actionIndex',
    });
    expect(repo.createStudySpace).not.toHaveBeenCalled();
    expect(repo.updateStudySpace).not.toHaveBeenCalled();
    expect(repo.linkStudySpaceCourse).not.toHaveBeenCalled();
    expect(repo.writeCourseProgress).not.toHaveBeenCalled();
  });

  it('map study errors to their status with recovery data, and hide unexpected ones', async () => {
    repo.writeCourseProgress.mockRejectedValueOnce(
      new StudyError('STUDY_REVISION_CONFLICT', { current: { revision: 3 } }),
    );
    const conflict = await putProgress(
      request('PUT', {
        sceneId: 's1',
        actionIndex: 1,
        baseRevision: 2,
        observedAt: new Date().toISOString(),
      }),
      params({ stageId: 'stage-1' }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'STUDY_REVISION_CONFLICT',
      current: { revision: 3 },
    });

    repo.getCourseProgress.mockRejectedValueOnce(new StudyError('STUDY_COURSE_NOT_FOUND'));
    const missing = await getProgress(request(), params({ stageId: 'stage-x' }));
    expect(missing.status).toBe(404);

    repo.linkStudySpaceCourse.mockResolvedValueOnce({ created: false });
    const again = await linkCourse(
      request('POST', { stageId: 'stage-1' }),
      params({ spaceId: 'space-1' }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ created: false });

    repo.listStudySpaces.mockRejectedValueOnce(
      Object.assign(new Error('connect to postgres://secret@host failed'), {
        code: 'ECONNREFUSED',
      }),
    );
    const broken = await listSpaces(request());
    expect(broken.status).toBe(503);
    expect(await broken.text()).not.toContain('secret');
  });
});
