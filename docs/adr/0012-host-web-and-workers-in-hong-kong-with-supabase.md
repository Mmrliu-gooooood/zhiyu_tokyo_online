# Host Web and background execution in Hong Kong with Supabase

## Status

Accepted architecture on 2026-09-07 through answers Q16, Q18, and Q19. The Hong Kong server location is superseded by [ADR-0013](0013-launch-in-singapore-with-colocated-managed-services.md); the hosting, storage, and recovery boundaries remain accepted. Exact server product, domain, and provisioning values are implementation-time inputs.

## Decision

Host the Next.js Web/API application and its durable background execution on a Hong Kong Linux server. Use managed Supabase PostgreSQL and Auth, and put persistent application files in private Supabase Storage. Server disk is for temporary processing and rebuildable caches. Vercel is not part of the first-release hosting path; preserve a documented future integration option rather than provisioning a redundant Web tier now.

The initial recovery objective is daily backups, at most approximately one day of lost updates, and restoration within one day. Database records, stored file objects, and encryption secrets require separate recoverable backups. A completed recovery rehearsal is necessary evidence, not an assumed property of a managed database.

## Context and consequences

The existing code has persistent Agent and material-processing runners, a separate generation worker, PostgreSQL notification listeners, and several local-file storage paths. Keeping Web and background execution on a persistent host avoids a Vercel-specific process split. Existing file writers and readers still need migration to the chosen cloud file layer. Default private ownership and account-based authorization must cover both database and file access.

The user named DeepSeek and Qwen among the intended text-model providers and asked to preserve the codebase's broader image/video/audio provider support. This is not a decision to enable every provider without credentials, pricing, or availability checks. First-release server sizing does not include hosting GPU inference stacks or the deferred MP4 render service.

New cloud data starts empty; local data is retained. This decision avoids an anonymous-history migration but does not permit wiping any local data or existing volumes. The user subsequently confirmed the final consensus including a Singapore Supabase Pro project, then selected Singapore for the application server as recorded in ADR-0013.
