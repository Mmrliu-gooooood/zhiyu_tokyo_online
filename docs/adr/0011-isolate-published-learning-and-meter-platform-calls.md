# Isolate published learning and meter platform-funded calls

## Status

Accepted beta product boundaries on 2026-09-07. Detailed schema, tariffs, and provider choice remain to be specified.

## Decision

Teachers and students use the same individual-account permissions in the first beta; no class management or differentiated teacher dashboard is required. An owner may publish a course for link-based viewing, while conversations, source materials, credentials, and each learner's records remain private. A viewer's AI interactions use that viewer's own platform credits or saved API connection, never the course creator's balance or secret configuration.

Deduct model credits only for actual platform-funded API calls. A user-provided text-model API does not make platform TTS or image calls free: each call's resolved funding source determines whether it consumes credits. BYOK calls consume no model credits but remain subject to infrastructure quotas.

Initial heavy-task concurrency is one per user and two globally, with queuing. File limits are 50 MB per file and 1 GB total user files per account. These are beta limits accepted by the user, not measurements or guarantees of machine capacity.

## Consequences

All entry points, including ordinary chat/generation, Pro tools, media, parsing, retries, and background jobs, need consistent authorization and funding attribution. Shared courses must not expose their creator's private source material or credential references. Admission control must coordinate task families rather than setting each independent runner to two slots and accidentally exceeding the global limit. Credit amounts, rounding, failed-call settlement, and test-credit grants must be explicitly defined in the implementation plan.
