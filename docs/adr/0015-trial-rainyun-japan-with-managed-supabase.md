# Trial Rainyun Japan with managed Supabase for Asian users

## Status

Accepted trial direction on 2026-09-08. Supersedes the region and audience choices in ADR-0013 and ADR-0014. A long-term server purchase and capacity acceptance remain subject to trial evidence.

## Decision

The user provisionally selects a Rainyun Japan Linux server and plans to begin the trial in the next operating session, described as “明天”. The audience is students and teachers in China, Japan, Korea and other Asian countries and regions. Use the discussed Tokyo node, with a managed Supabase Pro project in Tokyo (`ap-northeast-1`) as the paired regional configuration.

One persistent Linux server hosts Next.js Web/API, the Pro Agent Runner and material processing. A separate Generation Worker container handles durable full-course jobs. Managed Supabase Pro hosts PostgreSQL, Auth and all persistent application files. Neither Vercel hosting nor self-hosted Supabase is part of this trial architecture.

Set up a real domain and trusted, renewable HTTPS, and run controlled end-to-end tests on the actual hosted environment. Preserve verified invited accounts, private ownership and explicit publication, cross-device state, test credits/BYOK, agreed quotas, empty initial cloud data, backups and local-data preservation. MP4 rendering and real payments remain deferred.

## Context and consequences

The discussed Rainyun offer is 4 vCPU / 8 GB, 30 GB disk, advertised 20 M upload / 30 M download and unlimited host traffic, with a screenshot price of CNY 651 for six months. These are purchase-page observations, not a completed purchase, renewal guarantee or performance measurement. The approximately 60 ms indicator is provider guidance, not an application benchmark. Trial with the actual node; around 60 GB disk is an engineering recommendation for later application-host headroom, not a user-approved paid expansion.

Keep runtime storage on managed services so replacing or ending the trial server does not require moving the database and file objects. Securely retain app encryption keys and deployment configuration outside the trial host, and verify database, object and key recovery separately.

Domain/TLS and network setup may proceed alongside independent code changes. Real-environment testing does not mean bypassing unfinished authentication or treating the existing application as already production-ready. Use dedicated test accounts/data and bounded paid API calls; do destructive resets and restores in isolated environments.

Test user-to-app, app-to-database, browser-to-Auth/Storage and app-to-model paths separately, including representative mainland, Japanese and Korean networks where available and at least one peak period. Record missing coverage, resource peaks, failures and recovery evidence before deciding to retain, expand or change the server.

## Implementation handoff

The authoritative instructions are [the deployment execution plan](../archive/investigations/zhiyu-deployment-execution-plan-2026-09-07.md), revised on 2026-09-08. This record and that plan describe authorized planning and intended execution, not resources already provisioned or tests already passed.
