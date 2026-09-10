# Share Home model selection and confirm Pro course proposals

## Status

Superseded by [ADR-0007](0007-fix-pro-model-binding-with-existing-generation.md) on 2026-09-05. The user withdrew mandatory consultation rounds and deferred the new proposal/assessment workflows. The decision below is historical and must not be applied as a requirement for the current bugfix.

## Context

Home exposes a model connection while the Pro agent currently requires a separate server-only `maic-agent-driver` route. Existing planning skills offer clarification and approval in prose, without establishing a persistent personalized-course contract.

## Decision

The user chose to share Home model configuration by default, with separate Pro selection only in advanced settings and a clear explanation when tool use is unsupported. Pro establishes goals, prior knowledge, and available time in one to three adaptive rounds, presents an editable course proposal, and generates after learner approval. Learners can skip further questions using recommended assumptions.

## Consequences

Both the agent driver and content-generation tools need one consistent configuration boundary that survives background execution; forwarding browser headers alone is insufficient. Existing server routing precedence must be reconciled explicitly rather than silently overriding the learner's choice. Course approval must remain associated with the proposal being generated across retries and later edits. These boundaries add configuration and workflow state, but make Pro behavior predictable.

Detailed evidence and implementation proposals: [solution document](../archive/investigations/pro-mode-model-config-and-personalized-course-solution-2026-09-05.md).
