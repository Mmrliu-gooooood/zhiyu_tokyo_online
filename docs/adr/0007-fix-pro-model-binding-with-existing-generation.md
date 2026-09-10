# Fix Pro model binding with existing generation

## Status

Accepted scope on 2026-09-05; implementation pending. Supersedes ADR-0005 for the current release.

## Decision

The current work is limited to fixing Pro messages and course generation when the learner has configured the model in Home. Reuse the existing shared `@openmaic/generation` functions and preserve Pro conversation, skill selection, per-page generation, and editing. The learner may invoke a skill for deeper questioning; no mandatory one-to-three-round consultation, new proposal workflow, or assessment subsystem is required for this fix.

## Consequences

The driver and content/actions calls must receive a durable owner-scoped Home connection fallback, with existing explicit administrator routes kept authoritative. ADR-0006's encrypted credential boundary remains applicable, implemented only to the extent needed for this fix. Dynamic assessments, Lesson plans, checkpoints, question sets, assessment attempts, reports, and advice loops are deferred independent work, not completion criteria for the model-configuration bug.

Implementation proposal: [bugfix plan](../archive/investigations/pro-home-model-config-bugfix-plan-2026-09-05.md).
