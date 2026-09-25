# Hosted accounts — rollback

The live `openmaic-main` stack still uses unset `AUTH_MODE`. Do not roll a public site back to `PERSISTENCE_DEV_TOKEN` / anonymous shared owners.

1. Keep `AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE` unset on `generation-compose.ps1`. Signed-in sessions still isolate; unsigned traffic stays legacy. `docker-compose.hosted.yml` is optional and uses a different compose project name.
2. Database: accounts SQL on confirmed project `lzomhnjyymalupgvcato` is additive. Rolling back the app without dropping tables is the safe default. Do not drop `auth.users` or business tables. Do not delete reserved admin `2470034737@qq.com`. Do not promote ordinary users to admin.
3. Schema rollback of roles/tables is not required for the live classroom Docker database (course rows stay on `openmaic-main_openmaic-postgres`). Classroom accounts **v6** (`app_internal` / `app_accounts` / `app_profiles`) and **v7** (`ensure_account` role upsert) are additive and did **not** FORCE RLS on `document_stages`. Leaving those objects in place is the safe default; dropping them would revive `/api/auth/me` 503 until the skip path is used again. Hosted `app_accounts_self_select` is additive SELECT-only for `authenticated`; revoking it returns classroom admin copies to `role=user` on first ensure miss.

4. Files: `ASSET_LOCAL_ROOT` and `data/classrooms` are not in the database backup. Do not enable `ASSET_BYTE_BACKEND=local` on this stack as a rollback shortcut.
5. Admin: `pnpm accounts:remove-test-admin` is dry-run unless `--apply` and `CONFIRM_DELETE_TEST_ADMIN=YES`. Restart never recreates the admin.
6. If hosted Auth is half-configured (mode on, no URL/key, or hosted mode without `WORKER_DATABASE_URL`), generation/LISTEN fail closed rather than falling back to anonymous owners.
7. Hosted generation RLS skeleton on zhiyu is additive and empty of course rows. Rolling back the app does not require dropping those tables. LOGIN role passwords live only in gitignored `.env.hosted.local` / `.scratch/hosted-set-login-passwords.sql`; deleting those files does not drop the Postgres roles.
8. Site URL: keep `http://localhost:3000` until `zhiyulearn.online` is actually serving the app. Switching Site URL early breaks confirmation links.
9. Hosted v10 Agent/Pro tables are additive and empty after acceptance cleanup. Prefer rolling the application back while leaving v10 in place. If a destructive schema rollback is ever approved, first prove all eight tables are empty, revoke the two application roles, drop child tables (`agent_session_entries`, `agent_session_events`, `agent_session_materials`, `pro_model_connection_revisions`) before their parents, and remove the v10 migration stamp only in the same controlled transaction. Never run this against database `openmaic`.
