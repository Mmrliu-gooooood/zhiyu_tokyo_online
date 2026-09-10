import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TTS_REQUEST_TIMEOUT_MS,
  resolveTTSRequestTimeoutMs,
} from '@/lib/audio/tts-providers';
import { externalCallDeadlineMs } from '@/lib/server/generation-pipeline/execution';

describe('TTS request budget', () => {
  it('allows a 31 second provider response and reserves outer commit time', () => {
    expect(DEFAULT_TTS_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(resolveTTSRequestTimeoutMs({})).toBe(120_000);
    expect(externalCallDeadlineMs('tts', {})).toBeGreaterThan(
      resolveTTSRequestTimeoutMs({}),
    );
  });
});
