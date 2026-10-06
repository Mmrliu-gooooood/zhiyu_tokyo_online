/**
 * Classmate APIs (learning plan B04) end to end on PGlite: hidden unless the
 * switch is on, accounts only, owner from the session, validated bodies,
 * revision conflicts as 409 with the current template, owner-only avatars.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const database = vi.hoisted(() => ({ pg: null as unknown }));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (ownerId: string, headers: Headers) => unknown) =>
    handler(owner.id, new Headers()),
}));
vi.mock('@/lib/server/stage-access', async () => {
  const { createOwnerBoundQueryable } = await import('@/lib/db/request-queryable');
  return {
    getOwnerBoundStageAccessDb: vi.fn(async (ownerId: string) =>
      createOwnerBoundQueryable(
        {
          connect: async () => ({
            query: (text: string, params?: unknown[]) =>
              (database.pg as PGlite).query(text, params),
            release() {},
          }),
        } as never,
        ownerId,
      ),
    ),
  };
});

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as list, POST as create } from '@/app/api/study/classmates/route';
import { GET as getOne, PATCH as patch } from '@/app/api/study/classmates/[classmateId]/route';
import { POST as importRoles } from '@/app/api/study/classmates/import/route';
import { POST as uploadAvatar } from '@/app/api/study/classmates/avatars/route';
import { GET as readAvatar } from '@/app/api/study/classmates/avatars/[avatarId]/route';

const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const json = (method: string, body: unknown) =>
  new Request('https://zhiyu.test/api/study/classmates', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const body = {
  name: '小林',
  role: 'student',
  persona: '',
  learningStyle: 'peer',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: null,
  materialIds: [],
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pg = new PGlite();
  await ensureDocumentSchema(pg as never);
  await ensureStageMetaSchema(pg as never);
  await ensureStudySchema(pg as never);
  database.pg = pg;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await (database.pg as PGlite).close();
});

describe('classmate routes', () => {
  it('stay hidden unless the switch is on, and refuse anonymous owners', async () => {
    expect((await (await capabilities()).json()).classmates).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '');
    expect((await (await capabilities()).json()).classmates).toBe(false);
    expect((await list(new Request('https://zhiyu.test/x'))).status).toBe(404);
    vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '1');
    owner.id = 'anon:device-1';
    expect((await create(json('POST', body))).status).toBe(401);
  });

  it('creates, lists, edits with a revision and answers a stale edit with the current one', async () => {
    expect((await create(json('POST', { ...body, role: 'teacher' }))).status).toBe(400);
    const created = await create(json('POST', body));
    expect(created.status).toBe(201);
    const { classmate } = await created.json();
    expect(classmate).toMatchObject({ name: '小林', revision: 1 });

    const listed = await (await list(new Request('https://zhiyu.test/x?status=active'))).json();
    expect(listed.classmates.map((item: { id: string }) => item.id)).toEqual([classmate.id]);

    const id = params({ classmateId: classmate.id });
    expect((await patch(json('PATCH', { name: 'x' }), id)).status).toBe(400);
    const edited = await patch(json('PATCH', { revision: 1, speechPolicy: 'active' }), id);
    expect((await edited.json()).classmate).toMatchObject({ revision: 2, speechPolicy: 'active' });
    const stale = await patch(json('PATCH', { revision: 1, name: 'old tab' }), id);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'STUDY_REVISION_CONFLICT',
      current: { revision: 2 },
    });

    owner.id = OTHER;
    expect((await getOne(new Request('https://zhiyu.test/x'), id)).status).toBe(404);
    expect(
      (await getOne(new Request('https://zhiyu.test/x'), params({ classmateId: '../x' }))).status,
    ).toBe(404);
  });

  it('imports device roles once and validates every item', async () => {
    const items = [body, { ...body, name: '小周', role: 'assistant' }];
    const first = await (await importRoles(json('POST', { items }))).json();
    expect(first.created).toHaveLength(2);
    const again = await (await importRoles(json('POST', { items }))).json();
    expect(again).toMatchObject({ created: [], skipped: 2 });
    expect((await importRoles(json('POST', { items: [{ ...body, avatar: 'x' }] }))).status).toBe(
      400,
    );
    expect((await importRoles(json('POST', { items: [] }))).status).toBe(400);
  });

  it('serves an uploaded avatar to its owner only, with the sniffed type', async () => {
    const upload = (type: string, bytes: Uint8Array) =>
      uploadAvatar(
        new Request('https://zhiyu.test/api/study/classmates/avatars', {
          method: 'POST',
          headers: { 'content-type': type },
          body: bytes,
        }),
      );
    expect((await upload('image/svg+xml', new TextEncoder().encode('<svg/>'))).status).toBe(415);
    const saved = await upload('image/png', PNG);
    expect(saved.status).toBe(201);
    const { id, avatar } = await saved.json();
    expect(avatar).toBe(`/api/study/classmates/avatars/${id}`);
    const served = await readAvatar(
      new Request(`https://zhiyu.test${avatar}`),
      params({ avatarId: id }),
    );
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(served.headers.get('cache-control')).toBe('private, no-cache');
    const revalidated = await readAvatar(
      new Request(`https://zhiyu.test${avatar}`, {
        headers: { 'if-none-match': served.headers.get('etag')! },
      }),
      params({ avatarId: id }),
    );
    expect(revalidated.status).toBe(304);
    owner.id = OTHER;
    expect(
      (await readAvatar(new Request(`https://zhiyu.test${avatar}`), params({ avatarId: id })))
        .status,
    ).toBe(404);
  });
});
