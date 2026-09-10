# Prioritize mainland users and reassess hosting

## Status

Historical audience change accepted after the user explicitly stated “用户改为国内”. Superseded by [ADR-0015](0015-trial-rainyun-japan-with-managed-supabase.md) on 2026-09-08: the trial now targets China, Japan, Korea and other Asian markets, using Rainyun Japan with managed Supabase Pro. Alternatives below remain historical assessments, not selected services.

## Decision

The first invited release now prioritizes mainland China users instead of overseas Asia-Pacific users. Reassess the previously selected Singapore hosting and Supabase Pro arrangement before implementation. The user is considering a domestic 4 vCPU / 8 GB / 5 Mbps Lighthouse instance and has asked whether TencentDB for PostgreSQL can replace Supabase.

Keep previously accepted functional requirements: verified invited email/password accounts, cross-device state, private ownership and explicit publication, platform test credits and BYOK, initial quotas, an empty production database with preserved local data, daily recoverability, and deferred MP4/real payments/Vercel.

## Technical assessment — proposals, not accepted selections

- TencentDB for PostgreSQL can replace the PostgreSQL database component. Existing pg pools, SQL/JSONB, migrations and LISTEN/NOTIFY must be verified against the selected instance, roles and connection path. It does not supply end-user authentication or object storage by itself.
- A candidate domestic stack is Lighthouse + same-region TencentDB PostgreSQL + COS + an application authentication library such as Better Auth, with transactional email. Invitations and business authorization remain application responsibilities.
- Lighthouse private networking is not automatically connected to the database VPC merely because both are Tencent products in one region. Configure and verify supported private interconnection, routes and security groups; include any networking charges in procurement.
- CloudBase for Supabase is a separate integrated alternative. Official documentation describes PostgreSQL, Auth and Storage but does not promise full Supabase API compatibility. Its direct database access, supported DDL/migration path, roles, persistent LISTEN sessions and storage behavior require a proof of compatibility before selection. Documentation describes restrictions on direct CREATE TABLE for cloudbase_postgres, with structural DDL routed through ExecutePGSql.
- Running plain PostgreSQL on the application host is a lower-service-count option but adds resource contention and shared-host recovery duties. It is different from self-hosting the entire Supabase stack, and neither choice is accepted yet.

## Consequences

The old execution plan is historical for region/provider-specific tasks. Before issuing a replacement handoff, settle domestic region, database/Auth/file services, recurring total cost, domain/filing prerequisites, connectivity and restore acceptance. A cheap application-server promotion does not determine the cost of the complete stack.

## Evidence

- [TencentDB PostgreSQL](https://cloud.tencent.cn/product/postgres)
- [Lighthouse private interconnection](https://intl.cloud.tencent.com/zh/document/product/1103/41396)
- [COS signed object URLs](https://cloud.tencent.cn/document/product/436/35651)
- [Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql) and [verified email/password](https://better-auth.com/docs/authentication/email-password)
- [CloudBase for Supabase product scope](https://cloud.tencent.com/product/tcbs), [PostgreSQL connections](https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql), and [PG identity/role restrictions](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)
