import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mocks = vi.hoisted(() => ({ identify: vi.fn(), resolve: vi.fn() }));

vi.mock('@/lib/auth/api', () => ({
  requirePrincipalIfHosted: async () => ({ ownerId: OWNER }),
}));
vi.mock('@/lib/auth/mode', () => ({ isHostedAuthEnabled: () => true }));
vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/unused',
  isValidClassroomId: () => true,
  readClassroom: async () => ({ id: 'class-a', ownerId: OWNER }),
  classroomMediaAllows: (classroom: { ownerId: string }, ownerId: string) =>
    classroom.ownerId === ownerId,
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  identifyHostedClassroomMediaObject: mocks.identify,
  resolveHostedClassroomMediaObject: mocks.resolve,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GET } from '@/app/api/classroom-media/[classroomId]/[...path]/route';

function get(range?: string) {
  const request = new Request('http://localhost/api/classroom-media/class-a/media/clip.mp4', {
    headers: range ? { Range: range } : {},
  });
  return GET(request as unknown as NextRequest, {
    params: Promise.resolve({ classroomId: 'class-a', path: ['media', 'clip.mp4'] }),
  });
}

describe('hosted classroom media ranges', () => {
  beforeEach(() => {
    mocks.identify.mockReset();
    mocks.resolve.mockReset();
    mocks.identify.mockResolvedValue({
      assetId: 'asset-a',
      contentHash: 'sha256-a',
      mime: 'video/mp4',
      byteSize: 10,
    });
    mocks.resolve.mockResolvedValue({
      bytes: new TextEncoder().encode('0123456789'),
      mime: 'video/mp4',
      byteSize: 10,
    });
  });

  it('owner-checks the mapping and serves the requested byte range', async () => {
    mocks.resolve.mockResolvedValueOnce({
      bytes: new TextEncoder().encode('3456'),
      mime: 'video/mp4',
      byteSize: 10,
    });
    const response = await get('bytes=3-6');
    expect(mocks.identify).toHaveBeenCalledWith({
      ownerId: OWNER,
      classroomId: 'class-a',
      legacyPath: 'media/clip.mp4',
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER,
        classroomId: 'class-a',
        legacyPath: 'media/clip.mp4',
        range: { kind: 'range', start: 3, end: 6 },
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('3456');
  });

  it('returns a non-cacheable 416 without reading a local file', async () => {
    const response = await get('bytes=99-');
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects extra legacy path segments before storage resolution', async () => {
    const request = new Request(
      'http://localhost/api/classroom-media/class-a/media/nested/clip.mp4',
    );
    const response = await GET(request as unknown as NextRequest, {
      params: Promise.resolve({
        classroomId: 'class-a',
        path: ['media', 'nested', 'clip.mp4'],
      }),
    });
    expect(response.status).toBe(404);
    expect(mocks.identify).not.toHaveBeenCalled();
  });
});
