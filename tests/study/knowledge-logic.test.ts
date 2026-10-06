/**
 * Pure B03 logic: the retrieval mode, the model-answer reader (only
 * server-issued passage ids count as evidence), evidence budget, chunk
 * planning from stored artifacts (locators, tables, image descriptions,
 * unparsed scan pages) and question keywords.
 */
import { describe, expect, it } from 'vitest';

import { parseModelAnswer, selectEvidence } from '@/lib/server/study/knowledge/ask';
import { planStudyChunks } from '@/lib/server/study/knowledge/chunks';
import {
  STUDY_KEYWORD_SIGNATURE,
  resolveStudyRetrieval,
} from '@/lib/server/study/knowledge/config';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import type { StudySearchHit } from '@/lib/server/study/knowledge/repository';
import { STUDY_QA_LIMITS, citationReaderHref } from '@/lib/study/knowledge/contracts';
import { fixtureArtifact, loadStudyQaFixture } from '@/eval/study-qa/fixture';

const allowed = new Set(['E1', 'E2']);

describe('resolveStudyRetrieval', () => {
  it('is keyword-only without an embedding model', () => {
    expect(resolveStudyRetrieval({} as unknown as NodeJS.ProcessEnv)).toEqual({
      mode: 'keyword',
      signature: STUDY_KEYWORD_SIGNATURE,
      embedding: null,
    });
    expect(
      resolveStudyRetrieval({ STUDY_EMBEDDING_MODEL: '  ' } as unknown as NodeJS.ProcessEnv).mode,
    ).toBe('keyword');
  });

  it('reports a set but unusable embedding model instead of silently using keywords', () => {
    for (const env of [
      { STUDY_EMBEDDING_MODEL: 'no-separator' },
      { STUDY_EMBEDDING_MODEL: 'siliconflow:BAAI/bge-m3', STUDY_EMBEDDING_DIMENSIONS: '768' },
    ]) {
      expect(resolveStudyRetrieval(env as unknown as NodeJS.ProcessEnv)).toEqual({
        mode: 'misconfigured',
        signature: null,
        embedding: null,
      });
    }
  });
});

describe('parseModelAnswer', () => {
  it('keeps grounded segments only with accepted ids', () => {
    const parsed = parseModelAnswer(
      JSON.stringify({
        status: 'answered',
        segments: [
          { kind: 'grounded', text: 'A', citations: ['E1', 'E7', 'E1'] },
          { kind: 'grounded', text: 'B', citations: ['E9'] },
          { kind: 'supplement', text: 'C' },
          { kind: 'other', text: 'D' },
        ],
      }),
      allowed,
    );
    expect(parsed).toEqual({
      status: 'answered',
      segments: [
        { kind: 'grounded', text: 'A', citations: ['E1'] },
        { kind: 'supplement', text: 'B' },
        { kind: 'supplement', text: 'C' },
      ],
      notFoundNote: null,
      rejectedRefs: ['E7', 'E9'],
    });
  });

  it('turns "answered" without accepted evidence into not_found', () => {
    const parsed = parseModelAnswer(
      '```json\n{"status":"answered","segments":[{"kind":"grounded","text":"x","citations":[]}],"not_found_note":"缺少相关内容"}\n```',
      allowed,
    );
    expect(parsed).toMatchObject({ status: 'not_found', notFoundNote: '缺少相关内容' });
  });

  it('keeps evidence when the model said not_found but cited valid passages', () => {
    const parsed = parseModelAnswer(
      '{"status":"not_found","segments":[{"kind":"grounded","text":"x","citations":["E2"]}]}',
      allowed,
    );
    expect(parsed?.status).toBe('answered');
  });

  it('rejects non-JSON and malformed objects', () => {
    expect(parseModelAnswer('The answer is 42.', allowed)).toBeNull();
    expect(parseModelAnswer('{"status":"maybe","segments":[]}', allowed)).toBeNull();
    expect(parseModelAnswer('{"status":"answered"}', allowed)).toBeNull();
  });

  it('bounds segment count and length', () => {
    const parsed = parseModelAnswer(
      JSON.stringify({
        status: 'answered',
        segments: Array.from({ length: 30 }, () => ({
          kind: 'grounded',
          text: 'x'.repeat(5000),
          citations: ['E1'],
        })),
      }),
      allowed,
    );
    expect(parsed!.segments).toHaveLength(12);
    expect(parsed!.segments[0]!.text).toHaveLength(2000);
  });
});

describe('selectEvidence', () => {
  const hit = (chars: number) => ({ text: 'x'.repeat(chars) }) as StudySearchHit;
  it('stops at the passage count and character budget', () => {
    expect(selectEvidence(Array.from({ length: 20 }, () => hit(10)))).toHaveLength(
      STUDY_QA_LIMITS.evidenceChunks,
    );
    expect(selectEvidence([hit(5000), hit(5000), hit(10)])).toHaveLength(1);
    // A single oversized passage is still used.
    expect(selectEvidence([hit(9000)])).toHaveLength(1);
  });
});

describe('planStudyChunks', () => {
  const fixture = loadStudyQaFixture();
  const calc = fixture.materials.find((material) => material.key === 'calc')!;
  const plan = planStudyChunks(fixtureArtifact(calc.versions[0]!), {
    ownerId: 'user:a',
    materialId: 'smat_calc',
    versionId: 'sver_calc_1',
    artifactId: 'sart_calc_1',
    title: calc.title,
    sha256: 'f'.repeat(64),
  });

  it('keeps page and block locators, tables and image descriptions', () => {
    const table = plan.chunks.find((chunk) => chunk.locator.blockId === 'table_4_1')!;
    expect(table.locator.pageNumber).toBe(4);
    expect(table.text).toContain('arctan x\t1 / (1 + x²)');
    const image = plan.chunks.find((chunk) => chunk.locator.blockId === 'block_img_1')!;
    expect(image.text).toContain('导数的几何意义');
    expect(image.locator.pageNumber).toBe(3);
    expect(plan.chunks.every((chunk) => chunk.workspaceId === 'user:a')).toBe(true);
  });

  it('reports pages without text as unparsed and is deterministic', () => {
    expect(plan.unparsedPages).toEqual([5]);
    const again = planStudyChunks(fixtureArtifact(calc.versions[0]!), {
      ownerId: 'user:a',
      materialId: 'smat_calc',
      versionId: 'sver_calc_1',
      artifactId: 'sart_calc_1',
      title: calc.title,
      sha256: 'f'.repeat(64),
    });
    expect(again.chunks.map((chunk) => chunk.id)).toEqual(plan.chunks.map((chunk) => chunk.id));
    expect(new Set(plan.chunks.map((chunk) => chunk.id)).size).toBe(plan.chunks.length);
  });
});

describe('questionTerms', () => {
  it('segments Chinese, drops question words and keeps formula tokens', () => {
    const terms = questionTerms('用邻接表存储时 DFS 和 BFS 的时间复杂度是多少？');
    expect(terms).toEqual(expect.arrayContaining(['邻接', '存储', 'dfs', 'bfs', '时间']));
    expect(terms).not.toContain('多少');
    expect(terms).not.toContain('的');
    expect(questionTerms('a^x 的导数')).toEqual(expect.arrayContaining(['a', 'x', '导数']));
  });

  it('caps the number of terms', () => {
    expect(questionTerms(Array.from({ length: 40 }, (_, i) => `词${i}项`).join(' ')).length).toBe(
      16,
    );
  });
});

describe('citationReaderHref', () => {
  it('opens the exact version, parse, page and block', () => {
    expect(
      citationReaderHref({
        materialId: 'smat_1',
        versionId: 'sver_2',
        artifactId: 'sart_3',
        pageNumber: 4,
        blockId: 'page_4',
      }),
    ).toBe('/study/materials/smat_1/read?version=sver_2&page=4&artifact=sart_3&block=page_4');
  });
});
