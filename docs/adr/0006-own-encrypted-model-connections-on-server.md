# Own encrypted model connections on the server

## Status

Accepted boundary on 2026-09-05; implementation pending. Under [ADR-0007](0007-fix-pro-model-binding-with-existing-generation.md), implement only the connection persistence and isolation needed for the Pro model-binding bugfix; a general connection-management platform is not required.

## Context

The user requires Pro to reuse Home model configuration across refreshes and background execution. Browser settings and request headers cannot provide durable credentials to a later agent run. The existing generation-job input explicitly excludes browser-supplied credentials.

## Decision

Save model credentials encrypted on the server, isolated to the current owner, with a settings action to delete them. Background tasks reference a connection version rather than embedding plaintext credentials in their inputs or transcripts. The user explicitly selected this over temporary session-only credentials.

## Consequences

This introduces a persistent secret-storage boundary: encryption-key lifecycle, owner authentication, deletion/revocation, and configuration-version resolution become implementation requirements. Existing anonymous ownership must be reviewed before extending it to credentials; a client-supplied unsigned owner identifier cannot authorize access to saved keys. This decision does not introduce an account system or cross-device identity. The encryption format, API paths, and migrations in the solution document remain engineering proposals.

Implementation proposal: [bugfix plan](../archive/investigations/pro-home-model-config-bugfix-plan-2026-09-05.md).
