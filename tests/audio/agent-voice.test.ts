import { describe, it, expect, vi, beforeEach } from 'vitest';

// agent-voice pulls browser-only deps transitively (IndexedDB, settings store);
// stub them so we can unit-test the pure narrator-selection logic in node.
vi.mock('@/lib/audio/voxcpm-voices', () => ({ getVoxCPMProviderOptions: vi.fn() }));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({}) } }));

import { pickNarratorAgent, resolveAgentVoiceOptions } from '@/lib/audio/agent-voice';
import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import { DEFAULT_AGENTS } from '@/lib/orchestration/registry/defaults';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const mockGetOptions = getVoxCPMProviderOptions as unknown as ReturnType<typeof vi.fn>;

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return {
    id: partial.id ?? 'a',
    name: partial.name ?? 'A',
    role: partial.role ?? 'student',
    persona: '',
    avatar: '',
    color: '',
    allowedActions: [],
    priority: 5,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    ...partial,
  };
}

const DESIGN = { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' };

describe('pickNarratorAgent', () => {
  it('prefers the teacher WITH a voiceDesign over a default teacher (the registry-seeding bug)', () => {
    // Registry is always seeded with DEFAULT_AGENTS first, so the default teacher
    // (no voiceDesign) precedes the generated one. Narration must pick the latter.
    const agents = [
      agent({ id: 'default-1', role: 'teacher', isDefault: true }), // no voiceDesign
      agent({ id: 'gen-1', role: 'teacher', voiceDesign: DESIGN, isGenerated: true }),
    ];
    expect(pickNarratorAgent(agents)?.id).toBe('gen-1');
  });

  it('still prefers the voiceDesign teacher regardless of array order', () => {
    const agents = [
      agent({ id: 'gen-1', role: 'teacher', voiceDesign: DESIGN }),
      agent({ id: 'default-1', role: 'teacher', isDefault: true }),
    ];
    expect(pickNarratorAgent(agents)?.id).toBe('gen-1');
  });

  it('falls back to any teacher when none has a voiceDesign', () => {
    const agents = [agent({ id: 'default-1', role: 'teacher', isDefault: true })];
    expect(pickNarratorAgent(agents)?.id).toBe('default-1');
  });

  it('returns undefined when there is no teacher', () => {
    expect(pickNarratorAgent([agent({ role: 'student' })])).toBeUndefined();
    expect(pickNarratorAgent([])).toBeUndefined();
  });
});

describe('resolveAgentVoiceOptions — voice-design source', () => {
  beforeEach(() => {
    mockGetOptions.mockReset();
    mockGetOptions.mockResolvedValue({});
  });
  const opts = { providerId: 'voxcpm-tts', voiceId: 'voxcpm:auto', providerConfig: {} };

  it('uses the real voiceDesign when the agent has one (generated agents)', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', voiceDesign: DESIGN }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toEqual(DESIGN);
  });

  it('falls back to the persona as the descriptor when there is no voiceDesign (preset agents)', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', persona: 'patient mentor' }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toEqual({
      identity: 'patient mentor',
      texture: '',
      delivery: '',
    });
  });

  it('has no descriptor when the agent has neither voiceDesign nor persona', async () => {
    await resolveAgentVoiceOptions(agent({ role: 'teacher', persona: '' }), opts);
    expect(mockGetOptions.mock.calls[0][1].voiceDesign).toBeUndefined();
  });

  it('changes only agentName in VoxCPM inputs when the six preset roles are renamed', async () => {
    const legacyNames: Record<string, string> = {
      'default-1': 'AI teacher',
      'default-2': 'AI助教',
      'default-3': '显眼包',
      'default-4': '好奇宝宝',
      'default-5': '笔记员',
      'default-6': '思考者',
    };

    for (const preset of Object.values(DEFAULT_AGENTS)) {
      await resolveAgentVoiceOptions({ ...preset, name: legacyNames[preset.id] }, opts);
      const legacyInput = mockGetOptions.mock.calls.at(-1)?.[1];
      await resolveAgentVoiceOptions(preset, opts);
      const renamedInput = mockGetOptions.mock.calls.at(-1)?.[1];

      expect(renamedInput.agentName).toBe(preset.name);
      expect({ ...renamedInput, agentName: legacyInput.agentName }).toEqual(legacyInput);
      expect(renamedInput.voiceDesign).toEqual({
        identity: preset.persona,
        texture: '',
        delivery: '',
      });
    }
  });

  it('preserves selected-voice resolution and provider configuration across every rename', async () => {
    const selected = {
      providerId: 'voxcpm-tts',
      voiceId: 'voxcpm-profile:learner-selected',
      providerConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://voice.test/v1',
        modelId: 'voxcpm-stable',
        providerOptions: { backend: 'voxcpm', temperature: 0.42 },
      },
      language: 'zh-CN',
    };
    mockGetOptions.mockImplementation(async (voiceId: string) => ({
      voiceMode: 'prompt',
      selectedVoiceId: voiceId,
    }));

    for (const preset of Object.values(DEFAULT_AGENTS)) {
      const legacy = { ...preset, name: `legacy-${preset.id}` };
      const before = await resolveAgentVoiceOptions(legacy, selected);
      const after = await resolveAgentVoiceOptions(preset, selected);

      expect(after).toEqual(before);
      expect(mockGetOptions.mock.calls.at(-1)?.[0]).toBe(selected.voiceId);
      expect(mockGetOptions.mock.calls.at(-1)?.[2]).toEqual({
        ttsApiKey: selected.providerConfig.apiKey,
        ttsBaseUrl: selected.providerConfig.baseUrl,
        ttsModelId: selected.providerConfig.modelId,
      });
      expect(after).toMatchObject(selected.providerConfig.providerOptions);
    }
  });

  it('preserves automatic voice prompt and registered-id inputs across every rename', async () => {
    mockGetOptions.mockImplementation(async (_voiceId: string, context) => ({
      voiceMode: 'auto',
      voicePrompt: JSON.stringify(context.voiceDesign),
      registeredVoiceId: `registered:${JSON.stringify(context.voiceDesign)}`,
    }));
    const automatic = {
      providerId: 'voxcpm-tts',
      voiceId: 'voxcpm:auto',
      providerConfig: {
        apiKey: 'test-key',
        customDefaultBaseUrl: 'https://voice.test/v1',
        modelId: 'voxcpm-stable',
        providerOptions: { backend: 'vllm-omni', speed: 1.05 },
      },
      language: 'zh-CN',
    };

    for (const preset of Object.values(DEFAULT_AGENTS)) {
      const legacy = { ...preset, name: `legacy-${preset.id}` };
      const before = await resolveAgentVoiceOptions(legacy, automatic);
      const beforeContext = mockGetOptions.mock.calls.at(-1)?.[1];
      const after = await resolveAgentVoiceOptions(preset, automatic);
      const afterContext = mockGetOptions.mock.calls.at(-1)?.[1];

      expect(after).toEqual(before);
      expect(afterContext.voiceDesign).toEqual(beforeContext.voiceDesign);
      expect(afterContext.persona).toBe(beforeContext.persona);
      expect(afterContext.role).toBe(beforeContext.role);
      expect(afterContext.agentName).toBe(preset.name);
    }
  });
});
