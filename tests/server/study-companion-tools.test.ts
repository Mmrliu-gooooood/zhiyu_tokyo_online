/**
 * The after-class chat toolset (learning plan B05): material scope is
 * re-resolved on every call (a material revoked mid-run is not searched or
 * read again), only authorised materials are returned, course pages are
 * limited to the chat's courses, and inviting classmates is capped.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedIndex, StudySearchHit } from '@/lib/server/study/knowledge/repository';
import {
  buildCompanionTools,
  type CompanionScopeSnapshot,
  type CompanionToolDeps,
} from '@/lib/server/study/companion/tools';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';
import type { CompanionExcerpt, CompanionInviteDetails } from '@/lib/study/companion/contracts';

const index = (materialId: string): ScopedIndex => ({
  indexId: `idx-${materialId}`,
  materialId,
  title: materialId === 'mat-a' ? '教材A' : '教材B',
  versionId: `${materialId}-v1`,
  versionNo: 1,
  isCurrent: true,
  artifactId: `${materialId}-art`,
});

const hit = (materialId: string, text: string): StudySearchHit => ({
  index: index(materialId),
  chunkId: `${materialId}-c1`,
  blockId: 'b2',
  pageNumber: 2,
  heading: null,
  blockType: 'text',
  text,
  contentHash: 'h',
  method: 'lexical',
  vectorRank: null,
  lexicalRank: 1,
  vectorDistance: null,
  lexicalScore: 1,
  fusedScore: 1,
});

function harness(overrides: Partial<CompanionToolDeps> = {}) {
  let scope: CompanionScopeSnapshot = {
    allowedMaterialIds: new Set(['mat-a', 'mat-b']),
    scope: [index('mat-a'), index('mat-b')],
    retrieval: 'keyword',
  };
  let ref = 0;
  const known = new Map<string, CompanionExcerpt>();
  const search = vi.fn(async (current: readonly ScopedIndex[]) =>
    current.map((entry) => hit(entry.materialId, `${entry.materialId} 换元法`)),
  );
  const document: StoredArtifactDocument = {
    version: 1,
    transform: 'study-artifact-v1',
    extractorId: 'unpdf',
    extractorVersion: '1',
    mimeType: 'application/pdf',
    pageCount: 3,
    paged: true,
    blocks: [
      { id: 'b1', type: 'text', pageNumber: 2, text: '第一段' },
      { id: 'b2', type: 'text', pageNumber: 2, text: '第二段' },
      { id: 'b3', type: 'text', pageNumber: 3, text: '第三页' },
    ],
    images: [],
    diagnostics: [],
  } as unknown as StoredArtifactDocument;
  const deps: CompanionToolDeps = {
    resolveScope: vi.fn(async () => scope),
    search,
    readArtifact: vi.fn(async () => document),
    knownExcerpt: (key) => known.get(key),
    nextRef: () => `M${++ref}`,
    remember: (excerpt) => known.set(excerpt.ref, excerpt),
    courses: async () => [{ stageId: 'stage-1', title: '积分', origin: true }],
    readCourse: async (_stageId, sceneId) =>
      sceneId
        ? { kind: 'scene', title: '积分', sceneTitle: '换元', text: '老师：先换元' }
        : { kind: 'outline', title: '积分', scenes: [{ id: 'scene-1', title: '换元' }] },
    ...overrides,
  };
  const tools = buildCompanionTools(deps);
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
    };
  };
  return {
    tools,
    tool,
    search,
    deps,
    revoke: (materialId: string) => {
      scope = {
        ...scope,
        allowedMaterialIds: new Set(
          [...scope.allowedMaterialIds].filter((id) => id !== materialId),
        ),
        scope: scope.scope.filter((entry) => entry.materialId !== materialId),
      };
    },
  };
}

describe('companion toolset', () => {
  it('registers only read tools unless the student invited classmates', () => {
    const names = harness().tools.map((tool) => tool.name);
    expect(names).toEqual([
      'search_materials',
      'read_material',
      'list_space_courses',
      'read_course_page',
    ]);
  });

  it('re-resolves the scope on every search, so a revoked material drops out mid-run', async () => {
    const h = harness();
    const first = await h.tool('search_materials').execute('t1', { query: '换元' });
    expect(first.content[0]!.text).toContain('mat-b 换元法');
    h.revoke('mat-b');
    const second = await h.tool('search_materials').execute('t2', { query: '换元' });
    expect(second.content[0]!.text).not.toContain('mat-b');
    expect(h.search).toHaveBeenLastCalledWith([index('mat-a')], expect.any(Array), 6);
    // Refs keep counting across calls in one conversation.
    expect(second.content[0]!.text).toContain('[M3]');
  });

  it('refuses to read a material that is not (or no longer) authorised', async () => {
    const h = harness();
    await h.tool('search_materials').execute('t1', { query: '换元' });
    const allowed = await h.tool('read_material').execute('t2', { ref: 'M1' });
    expect(allowed.content[0]!.text).toContain('第一段');
    h.revoke('mat-a');
    const refused = await h.tool('read_material').execute('t3', { ref: 'M1' });
    expect(refused.content[0]!.text).toContain('不在你当前的授权范围内');
    const foreign = await h.tool('read_material').execute('t4', { materialId: 'mat-z', page: 1 });
    expect(foreign.content[0]!.text).toContain('不在你当前的授权范围内');
  });

  it('explains when the classmate has no authorised materials or retrieval is off', async () => {
    const none = harness({
      resolveScope: async () => ({
        allowedMaterialIds: new Set(),
        scope: [],
        retrieval: 'keyword',
      }),
    });
    const result = await none.tool('search_materials').execute('t1', { query: '换元' });
    expect(result.content[0]!.text).toContain('没有被授权');
    expect(none.search).not.toHaveBeenCalled();
    const off = harness({
      resolveScope: async () => ({
        allowedMaterialIds: new Set(['mat-a']),
        scope: [],
        retrieval: 'unavailable',
      }),
    });
    expect(
      (await off.tool('search_materials').execute('t1', { query: '换元' })).content[0]!.text,
    ).toContain('不可用');
  });

  it('reads only the chat’s courses', async () => {
    const h = harness();
    const outline = await h.tool('read_course_page').execute('t1', { stageId: 'stage-1' });
    expect(outline.content[0]!.text).toContain('scene-1');
    const page = await h
      .tool('read_course_page')
      .execute('t2', { stageId: 'stage-1', sceneId: 'scene-1' });
    expect(page.content[0]!.text).toContain('老师：先换元');
    const other = await h.tool('read_course_page').execute('t3', { stageId: 'stage-x' });
    expect(other.details).toEqual({ error: 'COURSE_NOT_ALLOWED' });
  });

  it('lets the classmate invite each chosen classmate once, within the turn cap', async () => {
    const run = vi.fn(
      async (classmateId: string): Promise<CompanionInviteDetails> => ({
        kind: 'study-companion-invite',
        classmateId,
        revision: 1,
        name: classmateId,
        avatar: '/a.png',
        color: '#000000',
        reply: '补充',
        excerpts: [],
      }),
    );
    const h = harness({
      invite: {
        candidates: [
          { classmateId: 'cm-1111111111111111', name: '小周' },
          { classmateId: 'cm-2222222222222222', name: '小吴' },
        ],
        maxCalls: 1,
        run,
      },
    });
    expect(h.tools.map((tool) => tool.name)).toContain('invite_classmate');
    const invite = h.tool('invite_classmate');
    const first = await invite.execute('t1', {
      classmateId: 'cm-1111111111111111',
      request: '补充',
    });
    expect(first.content[0]!.text).toContain('补充');
    const again = await invite.execute('t2', {
      classmateId: 'cm-1111111111111111',
      request: '再说',
    });
    expect(again.details).toEqual({ error: 'ALREADY_INVITED' });
    const over = await invite.execute('t3', {
      classmateId: 'cm-2222222222222222',
      request: '你呢',
    });
    expect(over.details).toEqual({ error: 'TURN_LIMIT' });
    const stranger = await invite.execute('t4', {
      classmateId: 'cm-3333333333333333',
      request: 'x',
    });
    expect(stranger.details).toEqual({ error: 'NOT_INVITED' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
