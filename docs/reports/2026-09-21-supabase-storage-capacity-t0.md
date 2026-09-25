# Supabase storage/capacity T0 baseline

Captured: 2026-09-21 (Asia/Shanghai)

This report records the non-destructive baseline for
`docs/plans/2026-09-20-supabase-storage-and-generation-capacity.md`. It does not
claim that T1-T9 or the protected regression matrix have passed.

## Protected product baseline

The migration must preserve and independently verify all five protected areas:

1. Foreground ordinary generation (`GENERATION_BACKGROUND_ENABLED=0`), including
   streamed progress, cancellation/error handling, persistence and classroom open.
2. Background ordinary generation (`GENERATION_BACKGROUND_ENABLED=1`), including
   queue/worker progress, close-and-return, cancellation/recovery and classroom open.
3. Pro generation, including workbench sessions/messages/events, materials/model
   configuration, confirmation/cancellation/recovery, media and classroom open.
4. The complete classroom surface: layout, scene navigation, playback/teaching,
   media, chat/whiteboard, exercises/feedback, and every currently enabled edit or
   export path.
5. Teach-back: selection, prepare, learner explanation, follow-up/feedback,
   citations/summary, pause/resume, retry, completion, classroom return, history,
   persisted `teach-back:*` runtime events and account isolation.

At T0, the code and automated tests for all five areas exist, but the stopped
container stack means none of the five is recorded as a new real-browser pass.
Historical reports also contain incomplete/failed Pro and teach-back checks, so
they are not reused as passing evidence.

## Worktree baseline

- Git HEAD: `3e8714f653ad11acd3f57510899900384572294d`
- Branch: `main`
- Tracked changes: 149 files (including one deletion)
- Untracked entries: 103
- The full dirty worktree, not Git HEAD, is the implementation baseline.
- No reset, stash, checkout, volume removal, or database overwrite was performed.

Non-sensitive enabled baseline flags include persistence, background generation,
Pro workbench/runtime, learning checks, guided learning and teach-back. The stopped
legacy deployment was configured for a site limit of 1, one worker and scene/LLM/
TTS/media concurrency of 2/3/2/1. These are baseline facts, not target values.

## Local source data snapshot

| Item | Count |
| --- | ---: |
| `document_stages` | 115 |
| anonymous stages | 115 |
| signed-in-user stages | 0 |
| active stage metadata | 51 |
| tombstones | 64 |
| scenes | 459 |
| asset entries | 1,484 |
| non-null asset byte rows | 1,484 |
| asset bytes | 511,178,031 |
| generation jobs | 56 |

The custom-format PostgreSQL dump was restored into a fresh PostgreSQL 16
container. Restored key counts matched 115 stages, 459 scenes, 1,484 asset entries,
1,484 asset blobs and 56 generation jobs. The source container was returned to its
original stopped state after the check.

## Backup set

Private backup directory (outside the repository):
`D:\ZZGG_Innovation_Project\OpenMAIC-main-backups\t0-20260921-095639`

| Artifact | SHA-256 |
| --- | --- |
| `repository.bundle` | `59BE49BB02C75E641E5C043DB826E777D37763314754C4745479E5658674F0E1` |
| `working-tree.patch` | `532E89865378EE63AB2885A0F4C120C8DAE317B9A2BA14567AB60A7E79D9AB95` |
| `workspace-files-v2.tar` | `D1E52E51D7E1CF8DE53EE6EBC0E512A4F6A15E81C91A5D0FDD8B6155BAEA48D4` |
| `local-postgres.dump` | `6A1F8CD8EFDF2F4BAABFA2C12D1F05322C376FC08D41D6A5775DF779AD0A7F43` |
| `postgres-volume.tar` | `7044AC7309BF33655E9DCCE009A3C219C62599FD808B8A6CFA0B81BB50D9CA0C` |
| `app-data-volume.tar` | `6E2C2584BE4BEA50EC619B14897760DCA9A40758F24DDFF989D4A652EE1B3F18` |

The workspace archive intentionally includes private ignored runtime configuration
and therefore must remain outside source control. No credential values are copied
into this report.

## Supabase preflight

- Project: `zhiyu` (`lzomhnjyymalupgvcato`), Singapore, healthy, PostgreSQL 17.6.
- `max_connections`: 60.
- `zhiyu_app_web` and `zhiyu_app_worker` are LOGIN roles without BYPASSRLS.
- Three active accounts exist; exactly one is an active admin. Its UUID is kept in
  the private migration manifest and is not selected from nickname or browser input.
- Hosted stages/scenes/assets and Storage objects were all zero at preflight.
- No Storage buckets existed at preflight.
- Accounts migrations through hosted v10 were present.

## Known T0 defects / non-passing items

- Hosted compose is an isolation proof stack (`:3001`), refuses jobs and forces the
  local byte backend; it is not the target cutover stack.
- Asset S3 configuration, MaterialByteStore S3, classroom snapshots/media, usage,
  render ownership and classroom jobs still have local-disk paths.
- Site admission only accepts 1/2, owner admission is fixed at 1, and several claim/
  fairness/slot/queue constants preserve the old capacity.
- The existing admin removal command is not a complete deletion lifecycle and must
  never target the real migration admin.
- `/api/auth/me` profile reads and the account-KV HTTP contract have hosted gaps.
- No T8/T9 protected real-browser or 4 -> 8 -> 16 evidence exists yet.

These are implementation inputs. None may be converted into a hidden feature,
disabled flag, weakened assertion or claim of completion.
