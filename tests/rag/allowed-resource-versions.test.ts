/**
 * KnowledgeIndex contract (learning plan B03): `allowedResourceVersionIds`
 * restricts candidates before ranking, so the best match of a version that is
 * not allowed can neither appear nor push allowed hits out of topK.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryLexicalIndex, type KnowledgeChunk } from '@/lib/rag';

const lineage = {
  sourceHash: 'sha256:source',
  extractor: { id: 'plain-text', version: '1.0.0' },
  transforms: [],
  chunkPolicy: { id: 'document-block', version: '1.1.0' },
} as const;

function chunk(id: string, version: string, text: string): KnowledgeChunk {
  return {
    id,
    resourceId: 'material-1',
    resourceVersionId: version,
    workspaceId: 'user:a',
    ordinal: 0,
    text,
    contentHash: `hash-${id}`,
    locator: { kind: 'document', blockId: id, pageNumber: 1 },
    lineage,
    metadata: {},
  };
}

async function index() {
  const knowledge = new InMemoryLexicalIndex();
  // Two resources so both versions stay (replacement is per resource).
  await knowledge.replaceResourceVersion({
    workspaceId: 'user:a',
    resourceId: 'material-1',
    resourceVersionId: 'v1',
    chunks: [chunk('old', 'v1', 'derivative definition')],
  });
  await knowledge.replaceResourceVersion({
    workspaceId: 'user:a',
    resourceId: 'material-2',
    resourceVersionId: 'v2',
    chunks: [
      {
        ...chunk('new', 'v2', 'a derivative among many other unrelated words here'),
        resourceId: 'material-2',
      },
    ],
  });
  return knowledge;
}

describe('allowedResourceVersionIds', () => {
  it('advertises the filter', () => {
    expect(new InMemoryLexicalIndex().capabilities.resourceVersionFilter).toBe(true);
  });

  it('keeps only allowed versions as candidates, before topK', async () => {
    const knowledge = await index();
    const all = await knowledge.query({
      workspaceId: 'user:a',
      courseScope: 'all',
      text: 'derivative definition',
      topK: 1,
    });
    expect(all.map((hit) => hit.chunk.id)).toEqual(['old']);
    const allowed = await knowledge.query({
      workspaceId: 'user:a',
      courseScope: 'all',
      text: 'derivative definition',
      topK: 1,
      allowedResourceVersionIds: ['v2'],
    });
    expect(allowed.map((hit) => [hit.chunk.id, hit.method])).toEqual([['new', 'lexical']]);
  });

  it('matches nothing for an empty allow-list', async () => {
    const knowledge = await index();
    expect(
      await knowledge.query({
        workspaceId: 'user:a',
        courseScope: 'all',
        text: 'derivative definition',
        topK: 5,
        allowedResourceVersionIds: [],
      }),
    ).toEqual([]);
  });
});
