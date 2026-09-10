# Use Supabase Free and local persistent files for the small trial

## Status

Planning decision on 2026-09-08, following the user's deployment interview answers. Supersedes ADR-0015's mandatory Supabase Pro subscription and hosted file storage. Keeps the Tokyo region, application host, account/privacy requirements and deferred features. Infrastructure provisioning and implementation are not completed by this record.

## Context

The user will first invite about five classmates; later participation is unknown. Workload is mainly text, images and speech, with occasional video and queued heavy tasks. The infrastructure budget target is CNY 350/month, with CNY 500/month available when necessary, excluding model API charges; starting costs should be lower where practical. The user accepts daily off-host backups and approximately one-day data-loss/recovery objectives, subject to restore drills, and explicitly wants to start with Free if feasible.

Supabase Free currently includes 500 MB database capacity, 1 GB file storage, and separate 5 GB uncached/cached monthly egress allowances. Low-activity projects may pause. It does not supply the managed daily backup capability assumed by the earlier Pro plan. Database queries and logical backup exports also consume egress. User count alone cannot establish sufficient capacity.

## Decision

- Keep managed Supabase Free in Tokyo for Auth and structured business data, including courses, learning state, private chats, file ownership, queues and credits.
- Keep file bytes on the Rainyun application host, accessed through authenticated application APIs. Ship built-in logos/fonts with the application. Do not use PostgreSQL BYTEA or Supabase Storage for primary media in this phase.
- Prefer the existing 30 GB system disk plus a separate 20 GB NVMe data disk, subject to available purchase increments and capacity verification. The user-supplied NVMe quote makes the addition approximately CNY 8/month. Do not pre-purchase capacity for an assumed fifty users.
- Web and Generation Worker share one explicitly mounted persistent volume. Implement a local asset backend: leaving the existing S3 bucket unset currently selects PostgreSQL bytes, not filesystem storage. Missing mounts must fail closed.
- Start with one global heavy task; raise to two only after combined-load validation. Keep user and site file quotas, bounded queues, actual free-space protection and per-request file authorization.
- Use custom SMTP and scheduled encrypted off-host database/file backups with at least seven daily restore points. Verify Auth/user-ID recovery, files, business data and keys together before inviting classmates. Host snapshots alone are insufficient.
- Do not deploy another PostgreSQL, a complete Supabase stack, MinIO, Redis or Kubernetes for this small trial. Preserve existing S3 seams for an explicit later migration.

## Consequences and upgrade criteria

The design removes the mandatory Pro subscription while retaining managed identity and database operations. It transfers file durability, bandwidth and restore responsibility to the project. Host replacement now requires moving and verifying files; cloud metadata alone is insufficient. Free remains a trial choice, not a high-availability promise.

Use measured database size/growth, cloud egress including backups, disk headroom, query performance, queue delays and network utilization to trigger review. Warn at about 70% of Free quotas and forecast exhaustion. Do not drop valid data, omit backups or generate artificial activity to preserve Free. If upgrading to Pro, first compare using its included file storage with keeping local files; migrate through copy/verify/cutover and rollback, never by only changing a bucket variable.

Detailed tasks, budgets, proposed environment variables, thresholds and verification are in the [execution plan](../archive/investigations/zhiyu-deployment-execution-plan-2026-09-07.md), which is authoritative for implementation. Paid changes require actual order/budget review; this document does not purchase resources.

## Sources

- [Supabase pricing](https://supabase.com/pricing)
- [Free availability and production considerations](https://supabase.com/docs/guides/deployment/going-into-prod)
- [Database backups](https://supabase.com/docs/guides/platform/backups)
- [Egress, including pooler and backups](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

Provider disk prices are supplied by the user, not independently confirmed for the selected Tokyo instance. No purchase, live deployment, migration or restore test was performed during this documentation revision.
