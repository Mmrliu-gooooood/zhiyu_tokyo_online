// Isolated diagnosis: four desired-behavior assertions are intentionally RED
// until the proposed fixes are implemented. No database or external API is used.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGenerationJobTools } from '@/lib/server/agent-runtime/generation-job-tools';
import { mapBounded } from '@/lib/server/generation-pipeline/execution';
import { generateTTS, TTSProviderTerminalError } from '@/lib/audio/tts-providers';

const teacher = {
  id: 'teacher',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teaches mathematics.',
};
const outline = {
  id: 'p1',
  order: 1,
  title: 'Elimination',
  type: 'slide',
  description: 'Explain elimination.',
  keyPoints: ['Eliminate one variable'],
};
const lectureConstraints = JSON.parse(
  readFileSync('skills/agent-runtime/lecture-style/outline-constraints.json', 'utf8'),
);
function fixture() {
  const createJob = vi.fn(async () => ({
    jobId: 'diagnostic-job',
    status: 'queued',
    phase: 'agents',
    readyScenes: 0,
    totalScenes: 1,
  }));
  const tools = buildGenerationJobTools({
    ownerId: 'diagnostic-owner',
    sessionId: 'diagnostic-session',
    repository: {
      createJob,
      getJob: vi.fn(),
      getJobBySession: vi.fn(async () => null),
      cancel: vi.fn(),
    },
    // Same selection rule as runner.ts: installed skills without constraints are dropped.
    resolveSkillConstraints: async (ids) =>
      ids.flatMap((id) =>
        id === 'lecture-style' ? [{ id, constraints: lectureConstraints }] : [],
      ),
  });
  return {
    createJob,
    submit: tools.find((t) => t.name === 'submit_course_generation'),
    status: tools.find((t) => t.name === 'get_course_generation_status'),
  };
}
afterEach(() => vi.restoreAllMocks());

describe('Historical submission path (expected current observations)', () => {
  it('rejects stage-design mixed with lecture-style before creating a job', async () => {
    const f = fixture();
    expect(
      await f.submit.execute('mixed', {
        requirement: 'Course',
        skillIds: ['stage-design', 'lecture-style'],
        outlines: [outline],
      }),
    ).toMatchObject({ isError: true, details: { code: 'INVALID_GENERATION_SKILL' } });
    expect(f.createJob).not.toHaveBeenCalled();
  });
  it('accepts lecture-style alone at the submission seam', async () => {
    const f = fixture();
    await f.submit.execute('lecture', {
      requirement: 'Course',
      skillIds: ['lecture-style'],
      outlines: [outline],
    });
    expect(f.createJob).toHaveBeenCalledTimes(1);
    // Worker validation of the full lecture page mix is a separate boundary.
  });
  it('rejects the observed voice string but accepts the same roster without voice', async () => {
    const f = fixture();
    expect(
      await f.submit.execute('voice', {
        requirement: 'Course',
        agents: [
          { ...teacher, voice: 'platform::zhiyu-default-tts::Chinese (Mandarin)_Gentleman' },
        ],
      }),
    ).toMatchObject({ isError: true, details: { code: 'INVALID_AGENTS' } });
    expect(f.createJob).not.toHaveBeenCalled();
    await f.submit.execute('without-voice', { requirement: 'Course', agents: [teacher] });
    expect(f.createJob).toHaveBeenCalledTimes(1);
  });
  it('returns no job after rejected submissions', async () => {
    const f = fixture();
    expect(await f.status.execute('status', {})).toMatchObject({
      isError: true,
      details: { found: false },
    });
  });
});

describe('Proposed regression contracts (expected RED before implementation)', () => {
  it('exposes the custom roster fields in the model-visible schema', () => {
    expect(fixture().submit.parameters.properties.agents.items.properties ?? {}).toHaveProperty(
      'voiceConfig',
    );
  });
  it('reports INVALID_OUTLINE when a valid roster accompanies an invalid outline', async () => {
    const f = fixture();
    const result = await f.submit.execute('bad-outline', {
      requirement: 'Course',
      agents: [teacher],
      outlines: [{ ...outline, order: 'bad' }],
    });
    expect(result.details.code).toBe('INVALID_OUTLINE');
  });
  it('keeps the first failure when concurrent work subsequently aborts', async () => {
    const primary = new Error('TTS_PROVIDER_TERMINAL_FAILURE');
    const secondary = new Error('EXTERNAL_CALL_CANCELLED');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const result = mapBounded([0, 1], 2, async (n) => {
      if (n === 0) {
        queueMicrotask(release);
        throw primary;
      }
      await gate;
      await Promise.resolve();
      throw secondary;
    }).catch((error) => error);
    expect(await result).toBe(primary);
  });
  it('preserves a MiniMax business error code separately from HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1002, status_msg: 'diagnostic provider rejection' },
          trace_id: 'diagnostic-trace',
          data: null,
        }),
        { status: 200 },
      ),
    );
    const error = await generateTTS(
      {
        providerId: 'minimax-tts',
        apiKey: 'diagnostic-fake',
        baseUrl: 'https://tts.example.test',
        voice: 'diagnostic-voice',
      },
      'Diagnostic text',
    ).catch((error) => error);
    expect(error).toBeInstanceOf(TTSProviderTerminalError);
    // This fixture does NOT assert that the historical incident had code 1002.
    expect(error.providerCode).toBe(1002);
  });
});
