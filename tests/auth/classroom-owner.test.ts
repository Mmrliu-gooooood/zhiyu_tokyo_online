import { describe, expect, it } from 'vitest';

import { classroomMediaAllows, classroomOwnerAllows, type PersistedClassroomData } from '@/lib/server/classroom-storage';

const base = {
  id: 'c1',
  stage: { id: 's1' },
  scenes: [],
  createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as PersistedClassroomData;

describe('classroom owner isolation', () => {
  it('allows a matching hosted owner and rejects a foreign owner', () => {
    const owned = { ...base, ownerId: 'user:11111111-1111-4111-8111-111111111111' };
    expect(classroomOwnerAllows(owned, owned.ownerId)).toBe(true);
    expect(classroomOwnerAllows(owned, 'user:22222222-2222-4222-8222-222222222222')).toBe(false);
  });

  it('hides user-owned snapshots from unsigned media while keeping legacy files', () => {
    const owned = { ...base, ownerId: 'user:11111111-1111-4111-8111-111111111111' };
    expect(classroomMediaAllows(owned, undefined)).toBe(false);
    expect(classroomMediaAllows(owned, 'user:22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(classroomMediaAllows(owned, owned.ownerId)).toBe(true);
    expect(classroomMediaAllows(null, undefined)).toBe(true);
    expect(classroomMediaAllows(base, undefined)).toBe(true);
    expect(classroomOwnerAllows(base, owned.ownerId)).toBe(false);
    expect(classroomMediaAllows(base, owned.ownerId)).toBe(false);
    expect(classroomMediaAllows(null, owned.ownerId)).toBe(false);
  });
});
