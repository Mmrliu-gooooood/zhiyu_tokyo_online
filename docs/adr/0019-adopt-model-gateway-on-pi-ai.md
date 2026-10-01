---
status: accepted
date: 2026-10-01
---

# Adopt a model gateway on pi-ai as the single text-model runtime

## Context

Text-model access grew as patches on the Vercel AI SDK: a 2400-line `lib/ai/providers.ts` that mixes the client catalog, vendor thinking parameters, fetch/SSE rewriting and the model factory; thinking configuration carried through `providerOptions`, request-body rewriting and an AsyncLocalStorage side channel; quota enforced by proxying SDK internals; error handling that matches strings; three persisted model schemas; and a PRO Agent path that converts pi messages to AI SDK and back. New providers, Token/Coding Plans and subscription sign-in cannot be expressed without adding more patches. An earlier proposal ([pi-ai model access migration](../plans/2026-09-30-pi-ai-model-access-migration.md)) put pi-ai under the AI SDK as another provider with long-lived dual transports; it is superseded.

The executable plan is [the model gateway refactor](../plans/2026-09-30-model-gateway-refactor.md).

## Decision

- **D1** pi-ai 0.99.1 is the only text-model runtime. All text LLM calls move to it in one cut-over (no per-provider dual stack, **D15**); the AI SDK text-call layer is then deleted.
- **D2** `lib/model-gateway` is the only boundary between business code and models. ESLint forbids business code from importing pi-ai runtime values, `generateText`/`streamText` or `@ai-sdk/*` outside a short allowlist.
- **D3** The canonical message format is pi's `Message` / `AssistantMessage` / event protocol, re-exported only from `lib/model-gateway/types.ts`.
- **D4** Application provider ids (`glm`, `kimi`, `grok`, …) stay stable; the catalog maps them to pi providers or custom descriptors.
- **D5** Vendor differences are data (descriptors, pi `compat`, a few declarative payload patches), not fetch wrappers.
- **D6** Provider instances are cached per process; each call gets a lightweight `Models` view with a sealed `AuthContext`, so pi never reads `process.env` (operator-managed Bedrock/Vertex excepted, prefix-scoped).
- **D7** Errors are classified from a per-request fetch side channel (status, `retry-after`, network codes, request sent, output observed) rather than pi's flattened error strings.
- **D8** Revocation fence, entitlement, quota, credentials, transport, retry, usage and settlement run in a fixed gateway pipeline.
- **D9** The Zhiyu default model is a `source: 'platform'` binding and every call carries a `FundingSource`, as required by [ADR-0011](0011-isolate-published-learning-and-meter-platform-calls.md); charging later means implementing an `EntitlementPolicy`, not changing call sites.
- **D10** Credential handles never appear in enumerable `ModelBinding` fields, logs or snapshots.
- **D11** Generation snapshots and PRO connection revisions are upgraded to a single `ModelSelection` (read old, write new, pure upgraders).
- **D12** pi-agent-core stays at 0.78.0 with its own nested pi-ai 0.78; interop types derive from agent-core and its pi-ai instance is loaded through one adapter. Upgrading the agent kernel is a separate migration.
- **D13** Claude web search and ASR keep their AI SDK calls; they are not text-gateway traffic.
- **D14** Only subscription sign-in (OAuth) is off by default and enabled per provider by an operator allowlist; API-key access is always available.
- **D16** API keys keep their current storage this round; the credential vault is used for OAuth only.

Delivery is two releases: R1 (gateway cut-over and new API-key / Token Plan / Coding Plan providers) and R2 (credential vault and subscription sign-in).

## Consequences

- Before any business code changes, the legacy behavior is locked by golden request payloads for all 19 providers and a performance baseline; the gateway must match them or carry an explicit, reasoned allowlist of differences.
- The one-shot cut-over is protected by characterization tests, draining generation jobs before release, and image rollback. Rolling back after v3 snapshots exist requires draining jobs first, because older code cannot read them; a v2→v1 read-compatibility hotfix branch for PRO connections is prepared before R1.
- Google Generative AI rejects a custom fetch in pi, so Google is limited to official endpoints and its errors are classified by message patterns (a documented limitation).
- Whether a provider's subscription terms permit use on a hosted product is a product-owner decision per provider; no OAuth provider is enabled by default.
