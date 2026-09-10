# Launch in Singapore with managed data services in the same region

## Status

Accepted on 2026-09-07 after the user's final architecture confirmation and explicit answer: “改为新加坡首发，应用与数据库同地区（建议）”. Supersedes only the Hong Kong application-server location in ADR-0012.

## Context

The user initially preferred Hong Kong to improve access from mainland China, then clarified that Singapore was also acceptable. Initial invited users primarily live in Asia-Pacific. The application performs frequent PostgreSQL queries, persistent runner coordination, and event polling; Supabase Singapore is the selected managed-data region. Server geography alone does not guarantee mainland reachability or stable streaming and media delivery.

## Decision

Use a persistent Singapore Linux server for Next.js Web/API, the Pro and material runners, and a separate Generation Worker container. Use Supabase Pro in Singapore (`ap-southeast-1`) for PostgreSQL, email/password Auth, and private persistent Storage. Evaluate 2 vCPU / 4 GB RAM as the starting size; actual vendor, pricing, and capacity acceptance remain procurement and load-test inputs.

Keep all previously accepted account, privacy, BYOK/test-credit, quota, empty-cloud-data, and backup boundaries. MP4 rendering, real payments, and Vercel hosting remain deferred. Retain non-MP4 exports, including existing project ZIP and subtitle exports.

## Consequences

Keeping application and data services in the same region reduces avoidable cross-region database round trips and suits the initial audience. These remain separately operated services connected with verified TLS; same-region hosting does not imply a shared private network.

Acceptance includes real mainland and overseas checks of login, uploads, streaming, and media playback. A later move to Hong Kong is conditional on measured connectivity and provider availability; database, accounts, and objects can remain in Singapore. A CPU server does not include a hosted GPU inference stack or sufficient reserved capacity for the deferred MP4 renderer.

The implementation handoff is [the final deployment plan](../archive/investigations/zhiyu-deployment-execution-plan-2026-09-07.md). This ADR records an approved plan, not a completed deployment.
