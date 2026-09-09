import { describe, expect, it } from 'vitest';
import { generationAccepting } from '@/lib/server/generation-jobs/runtime';

describe('generation worker readiness gate', () => {
  it('does not accept jobs when the database is ready but no compatible worker is live', () => {
    expect(generationAccepting(true, { database: true, schema: true, worker: false })).toBe(false);
    expect(generationAccepting(true, { database: true, schema: true, worker: true })).toBe(true);
  });
});
