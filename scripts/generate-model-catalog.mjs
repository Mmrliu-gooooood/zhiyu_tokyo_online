#!/usr/bin/env node
/**
 * Generate lib/model-gateway/catalog/generated/pi-models.json from the
 * installed @earendil-works/pi-ai provider data (plan P2-1).
 *
 *   node scripts/generate-model-catalog.mjs          # write the file
 *   node scripts/generate-model-catalog.mjs --check  # exit 1 when it is stale
 *
 * The output is a trimmed, isomorphic catalog for the settings UI: chat models
 * only, the fields the UI and capability derivation need, and for the large
 * aggregators only the CURATED short list below (everything else is reached by
 * model discovery or manual entry).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PI_DIR = path.join(ROOT, 'node_modules', '@earendil-works', 'pi-ai');
const DATA_DIR = path.join(PI_DIR, 'dist', 'providers', 'data');
const OUT_FILE = path.join(ROOT, 'lib', 'model-gateway', 'catalog', 'generated', 'pi-models.json');
const MAX_BYTES = 150 * 1024;

/** pi providers the application does not expose (no supported wire API). */
const EXCLUDED_PROVIDERS = new Set(['typesafe', 'radius']);

/** Wire APIs the gateway can call. */
const SUPPORTED_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
  'azure-openai-responses',
  'bedrock-converse-stream',
]);

/** compat fields the client catalog / thinking-capability derivation read. */
const COMPAT_FIELDS = ['thinkingFormat', 'supportsReasoningEffort'];

/**
 * Aggregators keep only these model ids (each must exist in pi, so a removed
 * upstream model fails generation instead of silently disappearing).
 */
const CURATED = {
  openrouter: [
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-haiku-4.5',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'google/gemini-2.5-flash',
    'moonshotai/kimi-k2.6',
    'qwen/qwen3.6-plus',
    'x-ai/grok-4.6',
    'z-ai/glm-5.2',
  ],
  'vercel-ai-gateway': [
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-haiku-4.5',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'google/gemini-3.5-flash',
    'alibaba/qwen3.7-plus',
  ],
  'amazon-bedrock': [
    'global.anthropic.claude-sonnet-5',
    'global.anthropic.claude-opus-5-5',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'amazon.nova-pro-v1:0',
    'amazon.nova-lite-v1:0',
    'deepseek.v3.2',
  ],
  huggingface: [
    'deepseek-ai/DeepSeek-V4-Pro',
    'deepseek-ai/DeepSeek-V4-Flash',
    'moonshotai/Kimi-K3',
    'Qwen/Qwen3.6-27B',
    'zai-org/GLM-5.2',
    'openai/gpt-oss-120b',
    'MiniMaxAI/MiniMax-M3',
  ],
  opencode: [
    'claude-sonnet-5-5',
    'claude-haiku-4-5',
    'gemini-3.5-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'glm-5.2',
    'kimi-k3',
    'gpt-5.5',
    'gpt-5.4-mini',
  ],
  // Azure deployments are user-named; these are only the suggested ids.
  'azure-openai-responses': [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o4-mini',
  ],
  'github-copilot': [
    'claude-sonnet-5.5',
    'claude-haiku-4.5',
    'gemini-3.5-flash',
    'gpt-5.5',
    'gpt-5.4-mini',
    'gpt-5.6-sol',
    'grok-4.6',
    'kimi-k3',
  ],
  'cloudflare-ai-gateway': [
    'claude-sonnet-5',
    'claude-haiku-4.5',
    'gpt-5.5',
    'gpt-5.4-mini',
    'workers-ai/@cf/zai-org/glm-5.2',
    'workers-ai/@cf/openai/gpt-oss-120b',
  ],
};

function readPiVersion() {
  return JSON.parse(readFileSync(path.join(PI_DIR, 'package.json'), 'utf8')).version;
}

function pick(model) {
  const out = {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: Boolean(model.reasoning),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
  if (model.thinkingLevelMap) out.thinkingLevelMap = model.thinkingLevelMap;
  const compat = {};
  for (const field of COMPAT_FIELDS) {
    if (model.compat?.[field] !== undefined) compat[field] = model.compat[field];
  }
  if (Object.keys(compat).length > 0) out.compat = compat;
  return out;
}

/** Store the most common api / baseUrl once per provider; models keep only overrides. */
function hoistDefaults(models) {
  const common = (field) => {
    const counts = new Map();
    for (const model of models) counts.set(model[field], (counts.get(model[field]) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const api = common('api');
  const baseUrl = common('baseUrl');
  return {
    api,
    baseUrl,
    models: models.map((model) => {
      const out = { ...model };
      if (out.api === api) delete out.api;
      if (out.baseUrl === baseUrl) delete out.baseUrl;
      return out;
    }),
  };
}

function buildCatalog() {
  const providers = {};
  const files = readdirSync(DATA_DIR)
    .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
    .sort();
  for (const file of files) {
    const providerId = file.slice(0, -'.json'.length);
    if (EXCLUDED_PROVIDERS.has(providerId)) continue;
    const byApi = JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8'));
    let models = [];
    for (const [api, entries] of Object.entries(byApi)) {
      if (!SUPPORTED_APIS.has(api)) continue;
      for (const model of Object.values(entries)) {
        if (model.type !== 'chat') continue;
        models.push(pick(model));
      }
    }
    const curated = CURATED[providerId];
    if (curated) {
      const byId = new Map(models.map((model) => [model.id, model]));
      const missing = curated.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new Error(`CURATED ${providerId} ids missing from pi: ${missing.join(', ')}`);
      }
      models = curated.map((id) => byId.get(id));
    } else {
      models.sort((a, b) => a.id.localeCompare(b.id));
    }
    if (models.length > 0) providers[providerId] = hoistDefaults(models);
  }
  const body = JSON.stringify(providers);
  return {
    piVersion: readPiVersion(),
    contentHash: createHash('sha256').update(body).digest('hex').slice(0, 16),
    providers,
  };
}

function serialize(catalog) {
  return `${JSON.stringify(catalog)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const text = serialize(buildCatalog());
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw new Error(`generated catalog is ${Buffer.byteLength(text)} bytes (limit ${MAX_BYTES})`);
  }
  if (check) {
    let current = '';
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== text) {
      console.error(
        'pi-models.json is stale for the installed pi-ai; run node scripts/generate-model-catalog.mjs',
      );
      process.exit(1);
    }
    console.log('pi-models.json is up to date');
    return;
  }
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, text);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} (${Buffer.byteLength(text)} bytes)`);
}

main();
