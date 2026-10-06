/**
 * Development-only fake model server for browser smoke tests of the model
 * gateway (plan P5-5 / P7). Wraps lib/model-gateway/testing/fake-openai-server
 * with canned, schema-valid replies for the classroom generation stages
 * (outlines, slide content, slide actions, agent profiles) so a whole lesson
 * can be generated without any real provider. Every other prompt gets "OK".
 *
 *   node_modules/.bin/tsx scripts/dev-fake-model-server.ts   # FAKE_MODEL_PORT=18787
 *
 * Point a provider at it with a temporary server-providers.yml entry
 * (`baseUrl: http://127.0.0.1:18787/v1`) or a custom provider in settings
 * (needs ALLOW_LOCAL_NETWORKS=true). It logs one line per request: protocol
 * path, model, detected stage and whether an Authorization / x-api-key header
 * was present (never its value).
 */
import {
  startFakeModelServer,
  type FakeHandler,
  type FakeRequest,
} from '../lib/model-gateway/testing/fake-openai-server';
import { fakeEmbedding } from '../eval/study-qa/fixture';

type Stage = 'outlines' | 'slide-content' | 'slide-actions' | 'agent-profiles' | 'other';

const STAGE_MARKERS: ReadonlyArray<[Stage, string]> = [
  ['outlines', '# Scene Outline Generator'],
  ['slide-content', '# Slide Content Generator'],
  ['slide-actions', '# Slide Action Generator'],
  ['agent-profiles', 'Generate agent profiles for a multi-agent classroom'],
];

function stageOf(request: FakeRequest): Stage {
  return STAGE_MARKERS.find(([, marker]) => request.rawBody.includes(marker))?.[0] ?? 'other';
}

/** First JSON string captured by `pattern` in the prompt (JSON-escaped body). */
function promptValues(request: FakeRequest, pattern: RegExp, limit: number): string[] {
  const values: string[] = [];
  for (const match of request.rawBody.matchAll(pattern)) {
    if (values.length >= limit) break;
    if (match[1]) values.push(match[1]);
  }
  return values;
}

const OUTLINES = {
  languageDirective: '用中文授课，面向初学者',
  courseTitle: '模型网关冒烟课',
  outlines: [
    {
      id: 'scene_1',
      type: 'slide',
      title: '什么是模型网关',
      description: '介绍统一模型网关在业务与模型之间的位置。',
      keyPoints: ['统一入口', '目录驱动', '密钥隔离'],
      order: 1,
    },
    {
      id: 'scene_2',
      type: 'slide',
      title: '一次调用的旅程',
      description: '从选择模型到收到回复的十个阶段。',
      keyPoints: ['解析绑定', '配额与凭据', '用量记录'],
      order: 2,
    },
  ],
};

function slideContent(): unknown {
  return {
    background: { type: 'solid', color: '#ffffff' },
    elements: [
      {
        id: 'title_text',
        type: 'text',
        left: 60,
        top: 60,
        width: 880,
        height: 76,
        content: '<p style="font-size: 28px;"><strong>模型网关冒烟测试</strong></p>',
        defaultFontName: '',
        defaultColor: '#333333',
      },
      {
        id: 'body_text',
        type: 'text',
        left: 60,
        top: 180,
        width: 880,
        height: 200,
        content:
          '<p style="font-size: 20px;">• 本页由本地假模型服务器生成</p><p style="font-size: 20px;">• 请求经过网关管线</p>',
        defaultFontName: '',
        defaultColor: '#333333',
      },
    ],
  };
}

const SLIDE_ACTIONS = [
  { type: 'text', content: '同学们好，这一页由本地假模型服务器生成，用来验证模型网关。' },
  { type: 'action', name: 'spotlight', params: { elementId: 'body_text' } },
  { type: 'text', content: '请注意这里列出的两个要点。' },
];

function agentProfiles(request: FakeRequest): unknown {
  const avatars = promptValues(request, /\\"path\\":\\"([^"\\]+)\\"/g, 3);
  const colors = promptValues(request, /(#[0-9a-fA-F]{6})/g, 3);
  const agent = (name: string, role: string, priority: number, index: number) => ({
    name,
    role,
    persona: `${name}是一位耐心的${role === 'teacher' ? '老师' : '学生'}。喜欢一步一步地讲清楚。`,
    voiceDesign: { identity: 'adult speaker', texture: 'warm clear', delivery: 'calm steady' },
    avatar: avatars[index] ?? avatars[0] ?? '/avatars/teacher.png',
    color: colors[index] ?? ['#3b82f6', '#10b981', '#f59e0b'][index],
    priority,
  });
  return {
    agents: [
      agent('王老师', 'teacher', 10, 0),
      agent('小林', 'student', 5, 1),
      agent('小周', 'student', 4, 2),
    ],
  };
}

/**
 * OpenAI-compatible `/embeddings` (study retrieval, learning plan B03):
 * deterministic hashing vectors, so indexing and search run end to end.
 */
function embeddings(request: FakeRequest) {
  const body = (request.body ?? {}) as { input?: unknown; dimensions?: unknown };
  const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
  const width = typeof body.dimensions === 'number' ? body.dimensions : 1024;
  return {
    object: 'list',
    data: inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: fakeEmbedding(text, width),
    })),
    usage: { prompt_tokens: inputs.reduce((sum, text) => sum + text.length, 0) },
  };
}

/**
 * Study QA (B03): cite the passages that share the most character pairs with
 * the question, or answer "not found" when none shares at least three.
 */
function studyAnswer(request: FakeRequest): unknown {
  const messages = ((request.body ?? {}) as { messages?: Array<{ content?: unknown }> }).messages;
  const content = messages?.at(-1)?.content;
  const user =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as { text?: unknown }).text ?? '')).join('')
        : '';
  const question = /问题：(.*)/.exec(user)?.[1] ?? '';
  const pairs = new Set(
    [...question].slice(0, -1).map((char, index) => `${char}${question[index + 1]}`),
  );
  const passages = [...user.matchAll(/\[(E\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[E\d+\]|$)/g)]
    .map((match) => ({
      ref: match[1]!,
      text: match[2]!,
      score: [...pairs].filter((pair) => match[2]!.includes(pair)).length,
    }))
    .sort((a, b) => b.score - a.score);
  const best = passages.filter((passage) => passage.score >= 3).slice(0, 2);
  if (best.length === 0) {
    return {
      status: 'not_found',
      segments: [
        { kind: 'supplement', text: '（假模型）资料中没有，这是基于通用知识的补充说明。' },
      ],
      not_found_note: '资料片段中没有与问题对应的内容。',
    };
  }
  return {
    status: 'answered',
    segments: [
      {
        kind: 'grounded',
        text: `根据资料：${best[0]!.text.replace(/\s+/g, ' ').slice(0, 80)}…`,
        citations: best.map((passage) => passage.ref),
      },
      { kind: 'supplement', text: '（假模型）这是一条补充说明，不来自资料。' },
    ],
  };
}

const handler: FakeHandler = (request) => {
  if (request.path.endsWith('/embeddings')) {
    console.log(`[fake-model] ${request.method} ${request.path} stage=embeddings`);
    return {
      kind: 'raw',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(embeddings(request)),
    };
  }
  if (request.rawBody.includes('学习平台的资料答疑助手')) {
    console.log(`[fake-model] ${request.method} ${request.path} stage=study-qa`);
    return { kind: 'auto', text: JSON.stringify(studyAnswer(request)) };
  }
  const stage = stageOf(request);
  const body = (request.body ?? {}) as { model?: unknown };
  const auth = request.headers.authorization || request.headers['x-api-key'] ? 'auth' : 'no-auth';
  console.log(
    `[fake-model] ${request.method} ${request.path} model=${String(body.model ?? '-')} stage=${stage} ${auth}`,
  );
  switch (stage) {
    case 'outlines':
      return { kind: 'auto', text: JSON.stringify(OUTLINES), textChunks: 6, chunkDelayMs: 40 };
    case 'slide-content':
      return { kind: 'auto', text: JSON.stringify(slideContent()) };
    case 'slide-actions':
      return { kind: 'auto', text: JSON.stringify(SLIDE_ACTIONS) };
    case 'agent-profiles':
      return { kind: 'auto', text: JSON.stringify(agentProfiles(request)) };
    default:
      return { kind: 'auto', text: 'OK' };
  }
};

async function main() {
  const port = Number(process.env.FAKE_MODEL_PORT ?? 18787);
  const server = await startFakeModelServer(handler, { port });
  console.log(`[fake-model] listening on ${server.origin}`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
