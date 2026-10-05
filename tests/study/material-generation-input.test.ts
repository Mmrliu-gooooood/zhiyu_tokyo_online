// @vitest-environment jsdom
/**
 * Course generation from library materials (learning plan B02 follow-up): the
 * stored parse text and images are bundled like a fresh upload, images are
 * chosen in the bundle's priority order up to the cap, read from the artifact
 * the text came from, and an unreadable image is left out instead of failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ text: vi.fn() }));

vi.mock('@/lib/study/materials/client', () => ({
  materialsApi: {
    text: api.text,
    imageUrl: (materialId: string, versionId: string, imageId: string, artifactId?: string) =>
      `/api/study/materials/${materialId}/versions/${versionId}/images/${imageId}${
        artifactId ? `?artifact=${artifactId}` : ''
      }`,
  },
}));

import { studyMaterialsGenerationInput } from '@/lib/study/materials/generation';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let fetched: string[];

function textView(versionId: string, imageCount: number, artifactId: string) {
  return {
    materialId: `mat-${versionId}`,
    versionId,
    versionNo: 1,
    name: `${versionId}.pdf`,
    title: versionId,
    artifactId,
    pageCount: imageCount,
    text: `Text of ${versionId}`,
    truncated: false,
    images: Array.from({ length: imageCount }, (_, index) => ({
      id: `img_${index + 1}`,
      mimeType: 'image/png',
      pageNumber: index + 1,
      width: 100,
      height: 100,
    })),
  };
}

beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes('/images/img_2?')) return new Response('gone', { status: 404 });
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('library materials as generation input', () => {
  it('bundles text and images like an upload, pinned to the parsed artifact', async () => {
    api.text.mockImplementation(async (_materialId: string, versionId: string) =>
      versionId === 'v1' ? textView('v1', 3, 'art-1') : textView('v2', 1, 'art-2'),
    );
    const input = await studyMaterialsGenerationInput([
      { materialId: 'mat-v1', versionId: 'v1', title: 'One' },
      { materialId: 'mat-v2', versionId: 'v2', title: 'Two' },
    ]);
    expect(input.text).toContain('Text of v1');
    expect(input.text).toContain('Text of v2');
    expect(input.totalImageCount).toBe(4);
    // img_2 of v1 could not be read: left out, the rest keep their bundle ids.
    expect(
      input.images.map((image) => [image.id, image.originalId, image.sourceDocumentId]),
    ).toEqual([
      ['img_1', 'img_1', 'v1'],
      ['img_3', 'img_3', 'v1'],
      ['img_4', 'img_1', 'v2'],
    ]);
    expect(input.images.every((image) => image.src.startsWith('data:image/png;base64,'))).toBe(
      true,
    );
    expect(input.images.every((image) => image.visionPriority > 0)).toBe(true);
    expect(fetched).toContain(
      '/api/study/materials/mat-v2/versions/v2/images/img_1?artifact=art-2',
    );
  });

  it('takes at most the cap, each document first, and fetches nothing beyond it', async () => {
    api.text.mockImplementation(async (_materialId: string, versionId: string) =>
      versionId === 'v1' ? textView('v1', 5, 'art-1') : textView('v2', 5, 'art-2'),
    );
    const input = await studyMaterialsGenerationInput(
      [
        { materialId: 'mat-v1', versionId: 'v1', title: 'One' },
        { materialId: 'mat-v2', versionId: 'v2', title: 'Two' },
      ],
      { maxImages: 2 },
    );
    expect(fetched).toHaveLength(2);
    expect(input.images.map((image) => [image.sourceDocumentId, image.originalId])).toEqual([
      ['v1', 'img_1'],
      ['v2', 'img_1'],
    ]);
  });

  it('stays text-only for a parse without images', async () => {
    api.text.mockResolvedValue(textView('v1', 0, 'art-1'));
    const input = await studyMaterialsGenerationInput([
      { materialId: 'mat-v1', versionId: 'v1', title: 'One' },
    ]);
    expect(input.images).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
