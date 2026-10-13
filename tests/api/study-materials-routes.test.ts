/**
 * Study material and learning-task APIs (learning plan B02): hidden unless both
 * study switches are on, accounts only, owner from the session (never the
 * body), fixed error codes for library and task errors, validated input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const repo = vi.hoisted(() => ({
  listStudyMaterials: vi.fn(),
  getStudyMaterial: vi.fn(),
  linkStudySpaceMaterial: vi.fn(),
}));
const service = vi.hoisted(() => ({
  requestMaterialParse: vi.fn(),
  readStudyMaterialPage: vi.fn(),
}));
const tasks = vi.hoisted(() => ({ getLearningTask: vi.fn() }));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (ownerId: string, headers: Headers) => unknown) =>
    handler(owner.id, new Headers()),
}));
vi.mock('@/lib/server/stage-access', () => ({
  getOwnerBoundStageAccessDb: vi.fn(async () => ({ bound: true })),
}));
vi.mock('@/lib/server/study/materials/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/study/materials/repository')>()),
  ...repo,
}));
vi.mock('@/lib/server/study/materials/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/study/materials/service')>()),
  ...service,
}));
vi.mock('@/lib/server/learning-tasks/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/learning-tasks/repository')>()),
  ...tasks,
}));

import { StudyError } from '@/lib/server/study/spaces/repository';
import { LearningTaskError } from '@/lib/server/learning-tasks/contracts';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as listMaterials } from '@/app/api/study/materials/route';
import { GET as getMaterial } from '@/app/api/study/materials/[materialId]/route';
import { POST as parse } from '@/app/api/study/materials/[materialId]/versions/[versionId]/parse/route';
import { GET as reader } from '@/app/api/study/materials/[materialId]/versions/[versionId]/reader/route';
import { POST as linkMaterial } from '@/app/api/study/spaces/[spaceId]/materials/route';
import { GET as getTask } from '@/app/api/study/tasks/[taskId]/route';

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method = 'GET', body?: unknown, url = 'https://zhiyu.test/api/study/x') =>
  new Request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('study material routes', () => {
  it('report the capability and hide the family unless both switches are on', async () => {
    expect(await (await capabilities()).json()).toEqual({
      spaces: true,
      materials: true,
      qa: false,
      classmates: false,
      companionChat: false,
      memory: false,

      exams: false,
      extraction: false,
      grading: false,
    });
    vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '');
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
    });
    expect((await listMaterials(request())).status).toBe(404);
    expect((await getTask(request(), params({ taskId: 'x' }))).status).toBe(404);
    vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '1');
    vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '');
    expect((await listMaterials(request())).status).toBe(404);
    expect(repo.listStudyMaterials).not.toHaveBeenCalled();
  });

  it('refuses anonymous device owners and never caches', async () => {
    owner.id = 'anon:device-1';
    const response = await listMaterials(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'STUDY_ACCOUNT_REQUIRED' });
    owner.id = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    repo.listStudyMaterials.mockResolvedValue([]);
    const ok = await listMaterials(request());
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(repo.listStudyMaterials).toHaveBeenCalledWith({ bound: true }, owner.id, {});
  });

  it('maps library and task errors to fixed codes', async () => {
    repo.getStudyMaterial.mockRejectedValue(new StudyError('STUDY_MATERIAL_NOT_FOUND'));
    const missing = await getMaterial(request(), params({ materialId: 'smat-a' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'STUDY_MATERIAL_NOT_FOUND' });
    service.requestMaterialParse.mockRejectedValue(
      new LearningTaskError('LEARNING_TASK_OWNER_QUEUE_LIMIT'),
    );
    const limited = await parse(
      request('POST', {}),
      params({ materialId: 'smat-a', versionId: 'sver-a' }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'LEARNING_TASK_OWNER_QUEUE_LIMIT' });
    tasks.getLearningTask.mockResolvedValue(null);
    expect((await getTask(request(), params({ taskId: 'x' }))).status).toBe(404);
    repo.getStudyMaterial.mockRejectedValue(new Error('connection reset'));
    const broken = await getMaterial(request(), params({ materialId: 'smat-a' }));
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({ error: 'STUDY_UNAVAILABLE' });
  });

  it('validates ids, pages and parser names before touching storage', async () => {
    expect((await getMaterial(request(), params({ materialId: '../etc/passwd' }))).status).toBe(
      404,
    );
    const badPage = await reader(
      request('GET', undefined, 'https://zhiyu.test/x?page=0'),
      params({ materialId: 'smat-a', versionId: 'sver-a' }),
    );
    expect(badPage.status).toBe(400);
    const badParser = await parse(
      request('POST', { providerId: 'https://evil.test' }),
      params({ materialId: 'smat-a', versionId: 'sver-a' }),
    );
    expect(badParser.status).toBe(400);
    expect(service.readStudyMaterialPage).not.toHaveBeenCalled();
    expect(service.requestMaterialParse).not.toHaveBeenCalled();
  });

  it('takes the owner from the session, never from the body', async () => {
    repo.linkStudySpaceMaterial.mockResolvedValue({ created: true });
    const response = await linkMaterial(
      request('POST', {
        materialId: 'smat-a',
        ownerId: 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      params({ spaceId: 'space-a' }),
    );
    expect(response.status).toBe(201);
    expect(repo.linkStudySpaceMaterial).toHaveBeenCalledWith(
      { bound: true },
      owner.id,
      'space-a',
      'smat-a',
    );
  });
});
