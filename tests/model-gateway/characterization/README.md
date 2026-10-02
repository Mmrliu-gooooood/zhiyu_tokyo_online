# Legacy-stack characterization (P0-3)

Locks the behavior of the legacy text-model stack (`lib/ai/providers.ts` `getModel` +
`lib/ai/llm.ts` complete / stream helpers) before the model gateway replaces it.
See `docs/plans/2026-09-30-model-gateway-refactor.md` sections 5 (P0-3, P2-5, P3-6).

## Golden request payloads

`legacy-payloads.test.ts` (deleted with the legacy stack in P3-6) drove the legacy stack against
`lib/model-gateway/testing/fake-openai-server.ts` (every outbound request is rerouted to
it; the original host is kept) and records one golden entry per case in
`tests/fixtures/model-gateway/legacy-payloads/<provider>.json`:

- `input`: the case (provider, model, key shape, baseUrl/api overrides, ThinkingConfig,
  tools, stream, conversation kind, maxOutputTokens, env overrides). Inputs are
  self-contained so P2-5 can replay them through the gateway after `lib/ai` is deleted.
- `request`: host, path, query, auth-related headers (key replaced by `<api-key>`), and the
  full JSON body with keys sorted.

Matrix (`matrix.ts`): all 19 built-in providers × one catalog model per distinct thinking
capability (+ an unknown hand-typed model id, + an Azure deployment) × thinking variants
(unset, `mode:default`, disabled, enabled, every catalog effort, every level, budget
default/min/dynamic, `auto`, OpenRouter `excludeReasoningOutput`) × tools on/off ×
complete / stream. Extra cases per provider: reasoning replay and tool-call replay
(multi-turn with an assistant reasoning part, e.g. kimi-k3 / DeepSeek
`reasoning_content`), image input, `LLM_THINKING_DISABLED=true`; plus OpenAI custom
base URL (gateway `chat_template_kwargs`, Responses vs Chat selection, `api` overrides),
MiniMax `sk-cp-` Token Plan keys, and a `custom-*` OpenAI-compatible provider. Google and
Bedrock only need the captured request (the fake server answers them with 400).

```powershell
# replay the goldens through the gateway (the legacy recorder was deleted in P3-6;
# the goldens are now frozen fixtures)
pnpm exec vitest run tests/model-gateway/characterization
```

## Thinking equivalence (P1-4 → P2-5)

`thinking-p1.test.ts` replays the single-turn thinking matrix through `runtime/thinking.ts`
with temporary pi model objects; every difference must be in `thinking-allowlist.json` with a
reason (stale entries fail). P2-5 re-runs the whole golden set through real bindings with the
shared harness in `thinking-equivalence.ts`. Data the P2 overlays must carry (found here):
opt-in `xhigh`/`max`/`minimal` levels from the reviewed capability, `supportsReasoningEffort:false`
for non-effort capabilities on OpenAI-compatible formats, and GPT-5.6 (absent from pi 0.99).

## Golden replay through bindings (P2-5)

`golden-replay.test.ts` replays every golden case (1653) through the real path
`upgradeLegacyModelParams → resolveBinding → gateway → fake server` and compares a semantic
projection of each request: host, path, query, auth scheme, thinking fields (incl. Gemini
`thinkingConfig`, Bedrock request fields and the effective Claude 5 effort), max-tokens field and
value, tool names, `tool_choice`, `stream_options`, message roles, replayed reasoning / tool calls
and image count. Bindings are rerouted to the fake server with the original host recorded.
Bedrock is replayed as an operator binding (user Bedrock is rejected by design).

Every difference is claimed in `golden-allowlist.json` by exact case ids, the fields that may
differ and a rule with its reason (stale entries fail). Rules, in short:

| Rule | Meaning |
| --- | --- |
| STREAMS | pi always streams (no non-streaming `:generateContent` / `/converse`; `stream_options` present) |
| GROK_RESPONSES | grok moves to the OpenAI Responses API (plan 3.6); effort still compared |
| ANTHROPIC_BETA / PI_DEFERRED_TOOL / CLAUDE5_EFFORT_CONTROL | pi's Anthropic beta endpoint, hidden cache placeholder tool and mid-conversation effort entry (effective effort verified) |
| ANTHROPIC_CAP | uncapped Anthropic calls send the catalog maximum (unknown models 8192) instead of SDK defaults |
| TOOL_RESULT_TURN | tool result and next user text as two user turns |
| REPLAY_REASONING | reasoning replayed in `reasoning_content` on later turns of the same model (plan 3.11) |
| NON_VISION | images dropped for reviewed non-vision models (plan 3.4) |
| MODE_DEFAULT / ANTHROPIC_DISABLED | P1 decisions (`mode:'default'` = provider default; explicit Anthropic disable) |
| ENABLED_NOT_OFF / BUDGET_ZERO_OFF / MINIMAX_ENABLE | legacy bugs fixed: "enabled" sent effort `none`; budget 0 sent "enable + 0"; MiniMax "enabled" sent nothing |
| OPENROUTER_EFFORT / GOOGLE_DYNAMIC | same API semantics in pi's wire form (`reasoning.effort`; omitted Gemini budget = dynamic) |

Real differences found and fixed instead of allowlisted: `max_tokens` / `system` role / no
`store` for OpenAI-compatible endpoints, Xiaomi and OpenRouter compat, unknown-model templates
(main protocol, dialect-only compat, 8192 cap), reviewed effort/levels not clamped by pi's map,
budget-only SiliconFlow models, Lemonade default thinking, Azure endpoint normalization and
explicit Azure options, Hunyuan "enabled", Google/Bedrock cap and budget stripping, and the
Claude 5 mid-conversation effort entry overriding the requested effort (a P1 gap).

`GOLDEN_REPLAY_REPORT=<file>` dumps all mismatches for review.

## Behavior checklist from legacy unit tests

Tick an ID (☐ → ☑) once it is covered by a gateway-era test (or explicitly waived with a reason)
before its source test is deleted in P3-6. "Golden" means the request-shape part is
already locked by the payload goldens above; the owner phase still needs a new-stack
assertion (P2-5 replays the goldens through the gateway).

### Request payload (thinking / max tokens / routing)

| ID | Behavior | Source | Golden | Owner |
| --- | --- | --- | --- | --- |
| ☑ RQ-01 | OpenAI-compatible providers get vendor thinking fields injected for disabled / enabled independently | `tests/ai/openai-provider.test.ts:98` | yes | P1-4 / P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-02 | GPT-5.5 / 5.6 / pro / codex use the Responses API; others use Chat | `openai-provider.test.ts:197` | yes | P2-2 descriptor + P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-03 | Custom OpenAI base URL keeps Responses for Responses models by default | `openai-provider.test.ts:209` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-04 | Custom OpenAI base URL + `OPENAI_COMPAT_USE_STREAMING_CHAT` → Chat (variable retired, plan 3.15) | `openai-provider.test.ts:225` | n/a | waive in P3-6 (pi always streams) — waived in P3-6: the variable is retired and pi always streams |
| ☑ RQ-05 | Non-streaming calls through the streaming-chat compat buffer SSE into JSON (incl. preamble fields, missing finish reason) | `openai-provider.test.ts:265, 378` | n/a | waive in P3-6 (pi always streams) — waived in P3-6: pi always streams, so there is no SSE→JSON buffer |
| ☑ RQ-06 | Azure: deployment name as model; full inference endpoints and classic resource endpoints normalized | `openai-provider.test.ts:423, 446, 460` | yes (one endpoint form) | P2-2 descriptor test — covered by `legacy-checklist.test.ts` (four portal forms + Foundry) and `golden-replay.test.ts` |
| ☑ RQ-07 | Gateway model `deepseek-v4-flash-vision-exp` sends `chat_template_kwargs.thinking` | `openai-provider.test.ts:695`, `openai-sdk-integration.test.ts:10` | yes | P2-2 overlay + P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-08 | SiliconFlow omits a zero thinking budget when thinking is disabled | `openai-provider.test.ts:746` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-09 | Lemonade disables thinking by default (catalog and manual model ids) | `openai-provider.test.ts:755, 763, 771` | yes (catalog + unknown id) | P1-4 / P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-10 | Lemonade strips `stream_options` while keeping thinking overrides | `openai-provider.test.ts:779` | yes | P2-2 compat (`supportsUsageInStreaming:false`) — covered by `golden-replay.test.ts` |
| ☑ RQ-11 | GPT-5.6 `max` effort reaches OpenAI (Responses) incl. the Sol alias | `llm-thinking-options.test.ts:44, 69`, `openai-sdk-integration.test.ts:78` | yes (canonical id) | P2-5 + alias test in P2-2 — covered by `legacy-checklist.test.ts` (Sol alias → canonical, `max` kept) and `golden-replay.test.ts` |
| ☑ RQ-12 | Claude Haiku 4.5 sends a thinking budget without effort | `llm-thinking-options.test.ts:281` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-13 | MiniMax M3 thinking disablement via Anthropic-compatible endpoint; none for fixed-thinking models | `llm-thinking-options.test.ts:310`, `minimax-provider.test.ts:64, 109` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-14 | Claude Fable 5: disabled thinking coerces to the lowest supported effort | `llm-thinking-options.test.ts:335` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-15 | Claude 5 models accept `xhigh` effort | `llm-thinking-options.test.ts:361` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-16 | MiniMax `sk-cp-` Token Plan keys use Bearer auth; default endpoint is `/anthropic/v1` | `minimax-provider.test.ts:11, 20` | yes | P2-2 descriptor + P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-17 | Atlas Cloud uses its base URL and the DeepSeek reasoning adapter for DeepSeek models | `atlascloud-provider.test.ts:122, 139` | yes | P2-5 — covered by `golden-replay.test.ts` |
| ☑ RQ-18 | Bedrock: keyless built-in using the AWS credential chain; bearer token when a key is set; whitespace `BEDROCK_REGION` ignored; provider-type conflicts rejected | `bedrock-provider.test.ts:37, 66, 81, 93, 134` | bearer only | P1-2 (ambient AuthContext) + P2-4 — covered by `legacy-checklist.test.ts` (user Bedrock refused), `env-poisoning.test.ts` (operator region / ambient AWS chain) and `selection/resolve-binding.test.ts` (provider-type conflicts) |
| ☑ RQ-19 | Kimi K3 replays `reasoning_content` on assistant messages, including across tool continuations | `reasoning-sse.test.ts:157`, `openai-sdk-integration.test.ts:188` | yes (replay cases) | P2-5 (pi `requiresReasoningContentOnAssistantMessages`) — covered by `golden-replay.test.ts` |
| ☑ RQ-20 | Direct thinking-option resolution keeps the compatible provider identity | `openai-sdk-integration.test.ts:168` | n/a | waive in P3-6 (no providerOptions layer) — waived in P3-6: there is no providerOptions layer; the binding carries the provider id |

### Response / stream parsing

| ID | Behavior | Source | Owner |
| --- | --- | --- | --- |
| ☑ RS-01 | `reasoning_content` deltas become reasoning (open/close rules across content, tool call, finish, mixed chunks; no double close; empty deltas ignored) | `reasoning-sse.test.ts:41-112`, `stream-fn.test.ts:35-145` | P1-5 (pi native reasoning fields) — covered by `legacy-checklist.test.ts` (pi native `reasoning_content` → reasoning block) |
| ☑ RS-02 | SSE framing survives `data:` lines split across reads; body-less responses pass through | `reasoning-sse.test.ts:132, 150` | P1-5 (fake server chunking) — covered by `legacy-checklist.test.ts` (fake server chunking) |
| ☑ RS-03 | Non-streaming responses recover `reasoning_content` | `reasoning-sse.test.ts:198` | P1-5 (pi streams only; covered by RS-01) — covered by `legacy-checklist.test.ts` (`complete()` aggregates the stream) |
| ☑ RS-04 | Custom gateway stream yields reasoning and clean text | `openai-provider.test.ts:710`, `openai-sdk-integration.test.ts:10` | P1-5 — covered by `legacy-checklist.test.ts` |
| ☑ RS-05 | SSE error frames in a 200 stream surface as errors | `openai-sdk-integration.test.ts:125` | P1-5 error matrix — covered by `legacy-checklist.test.ts` (classified `GatewayError`) |
| ☑ RS-06 | Inline `<think>` text (Ollama, some SiliconFlow models) splits into reasoning | `lib/ai/providers.ts` `extractReasoningMiddleware` | P1-5 `think-tag-splitter` — `tests/model-gateway/splitter-toolloop-images.test.ts` |

### Usage accounting

| ID | Behavior | Source | Owner |
| --- | --- | --- | --- |
| ☑ US-01 | Usage is attributed to the canonical model id (alias → canonical) | `llm-thinking-options.test.ts:95` | P1-5 usage — covered by `legacy-checklist.test.ts` (fixed in P3-6: the pipeline records the canonical id) |
| ☑ US-02 | Bedrock usage is attributed to the `bedrock` app provider id | `llm-thinking-options.test.ts:124` | P1-5 usage — covered by `legacy-checklist.test.ts` |
| ☑ US-03 | Multi-step tool runs record every step's usage | `llm-thinking-options.test.ts:153` | P1-6 tool-loop — `splitter-toolloop-images.test.ts` |
| ☑ US-04 | Every validation-retry attempt is recorded; the last attempt is recorded even when all fail | `llm-thinking-options.test.ts:181, 225` | P1-5 `complete()` validate — `gateway-faux.test.ts` |
| ☑ US-05 | Falls back to single-step usage when no aggregate exists | `llm-thinking-options.test.ts:256` | P1-5 usage — waived in P3-6: pi reports usage on every assistant message, so there is no aggregate / step split |
| ☑ US-06 | Agent StreamFn writes token usage into the completed pi assistant message | `stream-fn-usage.test.ts:12` | P3-4 agent-stream-fn — covered by `adapters/agent-stream-fn.test.ts` |

### Agent StreamFn (`lib/agent/runtime/stream-fn.ts` → `adapters/agent-stream-fn.ts`)

| ID | Behavior | Source | Owner |
| --- | --- | --- | --- |
| ☑ AG-01 | Thinking start/delta/end events; thinking and text are separate blocks in order; second thinking block when reasoning resumes; finalize closes open blocks | `stream-fn.test.ts:35-145` | P3-4 — covered by `adapters/agent-stream-fn.test.ts` |
| ☑ AG-02 | Assistant thinking is replayed; tool calls keep provider metadata (signatures); tool results map to tool messages; failed results encode as errors | `stream-fn.test.ts:156, 187, 228, 252` | P3-4 (pi-native signatures) — covered by `adapters/agent-stream-fn.test.ts` (signed thinking replay across two tool turns; tool results are pi-agent-core native) |
| ☑ AG-03 | Only the top-level finish is authoritative; missing terminal fails closed; abort/error map to the pi error channel; setup failure still yields a protocol stream | `stream-fn-contract.test.ts:151, 161, 169, 182` | P3-4 — covered by `adapters/agent-stream-fn.test.ts` (abort on the error channel; setup failure yields a protocol error) |
| ☑ AG-04 | DNS retries: at most two, never after output started, not for non-DNS failures, interruptible by abort | `stream-fn-contract.test.ts:253, 277, 301, 319` | P1-5 retry table + P3-4 — `errors-retry.test.ts` (DNS ×2 in both modes, none after output, abort not retried) — the adapter uses the gateway retry table |
| ☑ AG-05 | A captured provider finish / error wins over a late abort | `stream-fn-contract.test.ts:409, 425` | P3-4 — covered by `adapters/agent-stream-fn.test.ts` |
| ☑ AG-06 | Outer abort variants (`it.each`) settle exactly once | `stream-fn-contract.test.ts:345` | P3-4 — covered by `adapters/agent-stream-fn.test.ts` |

### Catalog content (move to `client-catalog` tests in P2-2)

All ☑: `catalog/legacy-parity.test.ts` compares the client catalog field by field with
`tests/fixtures/model-gateway/legacy-catalog.json`, a frozen snapshot of the 19 legacy
providers (models, windows, endpoints) and 108 reviewed thinking capabilities taken before
`lib/ai/providers.ts` was deleted.

| ID | Behavior | Source |
| --- | --- | --- |
| ☑ CT-01 | Claude 5 models listed first with current token windows | `anthropic-provider.test.ts:6` |
| ☑ CT-02 | Atlas Cloud registered as OpenAI-compatible with live-verified models | `atlascloud-provider.test.ts:91, 102` |
| ☑ CT-03 | GPT-5.6 Sol resolves through the canonical entry; GPT-5.5 present | `openai-provider.test.ts:174, 178` |
| ☑ CT-04 | Latest GLM / Kimi / Doubao Seed / Grok models with explicit output limits | `openai-provider.test.ts:476, 523, 570` |
| ☑ CT-05 | MiniMax model list matches the official Anthropic-compatible list | `minimax-provider.test.ts:15` |
| ☑ CT-06 | Xiaomi pay-as-you-go and Token Plan endpoints; MiMo catalog; MiMo reasoning models are configurable | `xiaomi-provider.test.ts:7, 28, 40` |
