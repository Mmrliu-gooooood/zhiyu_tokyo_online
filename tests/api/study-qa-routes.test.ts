/**
 * Retrieval and answer APIs (learning plan B03): hidden unless the QA switch
 * and the material library are on, accounts only, owner from the session,
 * validated question/pins/targets, readiness errors as fixed codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const service = vi.hoisted(() => ({
  spaceKnowledgeStatus: vi.fn(),
  buildSpaceIndexes: vi.fn(),
  answerQuestion: vi.fn(),
  searchQuestion: vi.fn(),
}));
const repo = vi.hoisted(() => ({
  listStudyAnswers: vi.fn(),
  deleteStudyAnswer: vi.fn(),
  deleteStudyVersionIndexes: vi.fn(),
  knowledgeStorageReady: vi.fn(async () => true),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (ownerId: string, headers: Headers) => unknown) =>
    handler(owner.id, new Headers()),
}));
vi.mock('@/lib/server/stage-access', () => ({
  getOwnerBoundStageAccessDb: vi.fn(async () => ({
    bound: true,
    withTransaction: async (body: (tx: unknown) => unknown) =>
      body({ query: async () => ({ rows: [{ '?column?': 1 }] }) }),
  })),
}));
vi.mock('@/lib/server/study/knowledge/service', () => service);
vi.mock('@/lib/server/study/knowledge/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/study/knowledge/repository')>()),
  ...repo,
}));

import { StudyError } from '@/lib/server/study/spaces/repository';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import {
  GET as knowledgeStatus,
  POST as buildIndexes,
} from '@/app/api/study/spaces/[spaceId]/knowledge/route';
import { GET as listAnswers, POST as ask } from '@/app/api/study/spaces/[spaceId]/ask/route';
import { POST as search } from '@/app/api/study/spaces/[spaceId]/search/route';
import { DELETE as deleteIndex } from '@/app/api/study/materials/[materialId]/versions/[versionId]/index/route';

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method = 'GET', body?: unknown) =>
  new Request('https://zhiyu.test/api/study/x', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_QA_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  service.answerQuestion.mockResolvedValue(Response.json({ answer: {} }, { status: 201 }));
  service.searchQuestion.mockResolvedValue(Response.json({ hits: [] }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('study QA routes', () => {
  it('report the capability and stay hidden unless QA and materials are on', async () => {
    expect(await (await capabilities()).json()).toEqual({
      spaces: true,
      materials: true,
      qa: true,
      classmates: false,
    });
    vi.stubEnv('ZHIYU_STUDY_QA_ENABLED', '');
    expect((await (await capabilities()).json()).qa).toBe(false);
    expect((await ask(request('POST', { question: 'q' }), params({ spaceId: 's1' }))).status).toBe(
      404,
    );
    vi.stubEnv('ZHIYU_STUDY_QA_ENABLED', '1');
    vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '');
    expect((await knowledgeStatus(request(), params({ spaceId: 's1' }))).status).toBe(404);
    expect(service.spaceKnowledgeStatus).not.toHaveBeenCalled();
    expect(service.answerQuestion).not.toHaveBeenCalled();
  });

  it('refuses anonymous owners', async () => {
    owner.id = 'anon:device-1';
    const response = await ask(request('POST', { question: 'q' }), params({ spaceId: 's1' }));
    expect(response.status).toBe(401);
    expect(service.answerQuestion).not.toHaveBeenCalled();
  });

  it('validates the question and version pins before any work', async () => {
    const space = params({ spaceId: 's1' });
    for (const body of [
      {},
      { question: '   ' },
      { question: 'x'.repeat(501) },
      { question: 'q', versionIds: 'v1' },
      { question: 'q', versionIds: ['../etc'] },
      { question: 'q', versionIds: Array.from({ length: 21 }, (_, i) => `v${i}`) },
    ]) {
      const response = await ask(request('POST', body), space);
      expect(response.status).toBe(400);
    }
    expect((await ask(request('POST', '{not json'), space)).status).toBe(400);
    expect(service.answerQuestion).not.toHaveBeenCalled();
    expect((await search(request('POST', { question: '' }), space)).status).toBe(400);
  });

  it('passes the session owner and normalized input, never body identity', async () => {
    await ask(
      request('POST', {
        question: '  导数   的定义？ ',
        versionIds: ['sver_1', 'sver_1'],
        ownerId: 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      params({ spaceId: 'space_1' }),
    );
    const [, , ownerId, input] = service.answerQuestion.mock.calls[0]!;
    expect(ownerId).toBe(owner.id);
    expect(input).toMatchObject({
      spaceId: 'space_1',
      question: '导数 的定义？',
      pinnedVersionIds: ['sver_1'],
    });
  });

  it('validates index build targets and maps readiness errors', async () => {
    const space = params({ spaceId: 's1' });
    expect((await buildIndexes(request('POST', { targets: [] }), space)).status).toBe(400);
    expect(
      (await buildIndexes(request('POST', { targets: [{ materialId: 'm' }] }), space)).status,
    ).toBe(400);
    service.buildSpaceIndexes.mockRejectedValueOnce(new StudyError('STUDY_QA_UNAVAILABLE'));
    const response = await buildIndexes(
      request('POST', { targets: [{ materialId: 'm1', versionId: 'v1' }] }),
      space,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'STUDY_QA_UNAVAILABLE' });
  });

  it('lists answers and deletes indexes through owner-bound calls', async () => {
    repo.listStudyAnswers.mockResolvedValue([{ answerId: 'a1' }]);
    const listed = await listAnswers(request(), params({ spaceId: 's1' }));
    expect(await listed.json()).toEqual({ answers: [{ answerId: 'a1' }] });
    expect(repo.listStudyAnswers.mock.calls[0]![1]).toBe(owner.id);
    repo.deleteStudyVersionIndexes.mockResolvedValue(1);
    const removed = await deleteIndex(
      request('DELETE'),
      params({ materialId: 'm1', versionId: 'v1' }),
    );
    expect(await removed.json()).toEqual({ removed: 1 });
    expect(repo.deleteStudyVersionIndexes.mock.calls[0]!.slice(1)).toEqual([owner.id, 'm1', 'v1']);
  });
});
