---
status: accepted
date: 2026-08-31
---

# Redesign product chrome without moving business state

ZHIYU will replace the product-facing visual chrome while preserving OpenMAIC's existing generation, orchestration, playback, Stage, Chat, storage, provider, editor, and schema ownership. Presentation components may wrap or rearrange already-computed state and callbacks, but generated learning content keeps its own styling and no handler or store is duplicated for visual convenience. This boundary prevents a broad UI project from silently becoming a behavior fork and keeps later upstream business updates independently mergeable.

## Consequences

- Standalone and hosted versions of a surface must be audited separately when they have different owners.
- Classic Chat and Workbench Conversation remain separate presentation subsystems.
- UI work may add selectors, pure view projections, CSS/tokens, and presentation wrappers, but any required business-state change is deferred to a separate proposal.
- Build and test configuration may be repaired as an explicit prerequisite, but it is not bundled into product behavior changes.
