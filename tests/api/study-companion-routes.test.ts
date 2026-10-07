/**
 * After-class chat APIs (learning plan B05) end to end on PGlite with the
 * real agent-session store: hidden unless the switch is on; opening a chat
 * binds it to the classmate and space before the opening message queues it;
 * a foreign or archived classmate / space / course is refused; later
 * messages go through the study API (the generic one refuses chats); chats
 * stay out of the Pro session list; the hourly cap holds.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const database = vi.hoisted(() => ({ pg: null as unknown, store: null as unknown }));

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
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => database.store),
}));

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import {
  GET as listChats,
  POST as openChat,
} from '@/app/api/study/classmates/[classmateId]/chats/route';
import { GET as chatHeader } from '@/app/api/study/companion-chats/[sessionId]/route';
import { POST as postMessage } from '@/app/api/study/companion-chats/[sessionId]/messages/route';
import { POST as genericMessage } from '@/app/api/agent/sessions/[id]/messages/route';
import { GET as listSessions } from '@/app/api/agent/sessions/route';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CM = 'cm-0123456789abcdef';
const CM_OTHER = 'cm-fedcba9876543210';
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const json = (body: unknown, url = 'https://zhiyu.test/api/study/x') =>
  new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;

async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO study_spaces (id, owner_id, name) VALUES
       ('space-a', $1, '高数'), ('space-arch', $1, '旧科'), ('space-b', $2, '物理')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `UPDATE study_spaces SET status = 'archived', archived_at = clock_timestamp() WHERE id = 'space-arch'`,
  );
  for (const [id, ownerId, status] of [
    [CM, OWNER, 'active'],
    [CM_OTHER, OTHER, 'active'],
    ['cm-1111111111111111', OWNER, 'archived'],
  ]) {
    await pg.query(
      `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar,
         color, status, archived_at)
       VALUES ($1, $2, '小林', 'student', 'peer', 'active', '/avatars/curious.png', '#10b981', $3,
         CASE WHEN $3 = 'archived' THEN clock_timestamp() END)`,
      [id, ownerId, status],
    );
  }
  await pg.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
     VALUES ('stage-a', '积分', 0, 0, $1, '{"id":"stage-a"}'), ('stage-b', '力学', 0, 0, $2, '{"id":"stage-b"}')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-a', $1), ('stage-b', $2)`,
    [OWNER, OTHER],
  );
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_COMPANION_CHAT_ENABLED', '1');
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
  vi.stubEnv('AGENT_RUNTIME_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  const pg = new PGlite();
  await ensureDocumentSchema(pg as never);
  await ensureStageMetaSchema(pg as never);
  await ensureStudySchema(pg as never);
  await ensureAgentSessionSchema(pg as never);
  database.pg = pg;
  database.store = new PgAgentSessionStore(pg as never, {
    withTransaction: (body) => pg.transaction((tx) => body(tx as unknown as Queryable)),
  });
  await seed(pg);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await (database.pg as PGlite).close();
});

async function open(body: Record<string, unknown>, classmateId = CM) {
  return openChat(json(body), params({ classmateId }));
}

describe('after-class chat routes', () => {
  it('stay hidden unless the switch is on', async () => {
    const enabled = (await (await capabilities()).json()).companionChat;
    vi.stubEnv('ZHIYU_STUDY_COMPANION_CHAT_ENABLED', '');
    expect((await (await capabilities()).json()).companionChat).toBe(false);
    expect((await open({ spaceId: 'space-a', question: '为什么？' })).status).toBe(404);
    // With the switch on the capability follows the agent runtime being configured.
    expect(typeof enabled).toBe('boolean');
  });

  it('opens a chat bound to the classmate and space, with the question queued', async () => {
    const response = await open({
      spaceId: 'space-a',
      question: '为什么要换元？',
      discuss: [],
      origin: { stageId: 'stage-a', sceneId: 'scene-1', agentId: `${CM}-r1`, excerpt: '课堂原话' },
    });
    expect(response.status).toBe(202);
    const { sessionId } = await response.json();
    const pg = database.pg as PGlite;
    const binding = await pg.query(
      'SELECT owner_id, space_id, classmate_id, purpose, origin FROM study_companion_chats WHERE session_id = $1',
      [sessionId],
    );
    expect(binding.rows).toEqual([
      {
        owner_id: OWNER,
        space_id: 'space-a',
        classmate_id: CM,
        purpose: 'after_class_qa',
        origin: {
          stageId: 'stage-a',
          sceneId: 'scene-1',
          agentId: `${CM}-r1`,
          excerpt: '课堂原话',
        },
      },
    ]);
    const session = await pg.query('SELECT status, prompt FROM agent_sessions WHERE id = $1', [
      sessionId,
    ]);
    expect(session.rows[0]).toEqual({ status: 'queued', prompt: '为什么要换元？' });

    const header = await (
      await chatHeader(new Request('https://zhiyu.test/x'), params({ sessionId }))
    ).json();
    expect(header).toMatchObject({
      chat: { spaceId: 'space-a', classmateId: CM },
      space: { name: '高数' },
      classmate: { id: CM, modelPolicy: { mode: 'inherit' } },
      originCourse: { stageId: 'stage-a', title: '积分' },
      materials: [],
    });

    const listed = await (
      await listChats(
        new NextRequest('https://zhiyu.test/x?spaceId=space-a'),
        params({ classmateId: CM }),
      )
    ).json();
    expect(listed.chats.map((chat: { sessionId: string }) => chat.sessionId)).toEqual([sessionId]);

    // Pro lists never show it; the generic message API refuses it.
    const pro = await (await listSessions(new NextRequest('https://zhiyu.test/x'))).json();
    expect(pro.map((item: { id: string }) => item.id)).not.toContain(sessionId);
    const generic = await genericMessage(json({ text: '绕过' }), params({ id: sessionId }));
    expect(generic.status).toBe(409);
  });

  it('refuses foreign or archived classmates, spaces and courses', async () => {
    expect((await open({ spaceId: 'space-b', question: 'q' })).status).toBe(404);
    expect((await open({ spaceId: 'space-a', question: 'q' }, CM_OTHER)).status).toBe(404);
    const archivedSpace = await open({ spaceId: 'space-arch', question: 'q' });
    expect(archivedSpace.status).toBe(409);
    expect((await archivedSpace.json()).error).toBe('STUDY_SPACE_ARCHIVED');
    const archivedClassmate = await open(
      { spaceId: 'space-a', question: 'q' },
      'cm-1111111111111111',
    );
    expect((await archivedClassmate.json()).error).toBe('STUDY_CLASSMATE_ARCHIVED');
    const foreignCourse = await open({
      spaceId: 'space-a',
      question: 'q',
      origin: { stageId: 'stage-b' },
    });
    expect(foreignCourse.status).toBe(404);
    const wrongAgent = await open({
      spaceId: 'space-a',
      question: 'q',
      origin: { stageId: 'stage-a', agentId: `${CM_OTHER}-r1` },
    });
    expect(wrongAgent.status).toBe(404);
    expect((await open({ spaceId: 'space-a', question: '' })).status).toBe(400);
    expect((await open({ spaceId: 'space-a', question: 'q', discuss: ['x'] })).status).toBe(400);
    expect(
      (await (database.pg as PGlite).query('SELECT count(*)::int AS n FROM agent_sessions')).rows,
    ).toEqual([{ n: 0 }]);
  });

  it('posts later questions through the study API and enforces the hourly cap', async () => {
    const { sessionId } = await (await open({ spaceId: 'space-a', question: '第一问' })).json();
    const posted = await postMessage(
      json({ text: '第二问', discuss: [CM_OTHER] }),
      params({ sessionId }),
    );
    expect(posted.status).toBe(202);
    const events = await (database.pg as PGlite).query(
      `SELECT data->>'text' AS text FROM agent_session_events
        WHERE session_id = $1 AND type = 'user_message' ORDER BY seq`,
      [sessionId],
    );
    expect(events.rows.map((row) => (row as { text: string }).text)).toEqual([
      '第一问',
      `第二问\n\n[[companion-options {"discuss":["${CM_OTHER}"]}]]`,
    ]);

    owner.id = OTHER;
    expect((await postMessage(json({ text: 'x' }), params({ sessionId }))).status).toBe(404);
    owner.id = OWNER;

    await (database.pg as PGlite).query(
      `INSERT INTO agent_session_events (session_id, seq, ts, attempt, type, data)
       SELECT $1, 100 + g, $2, 0, 'user_message', '{"text":"x"}'::jsonb FROM generate_series(1, 60) g`,
      [sessionId, Date.now()],
    );
    const capped = await postMessage(json({ text: '再问' }), params({ sessionId }));
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toBe('STUDY_COMPANION_RATE_LIMITED');
  });

  it('stops new questions when the classmate is archived later, keeping the history', async () => {
    const { sessionId } = await (await open({ spaceId: 'space-a', question: '第一问' })).json();
    await (database.pg as PGlite).query(
      `UPDATE study_classmates SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1`,
      [CM],
    );
    const refused = await postMessage(json({ text: '还能问吗' }), params({ sessionId }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('STUDY_CLASSMATE_ARCHIVED');
    const header = await chatHeader(new Request('https://zhiyu.test/x'), params({ sessionId }));
    expect(header.status).toBe(200);
  });
});
