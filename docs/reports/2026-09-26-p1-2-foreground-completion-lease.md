# P1-2 前台完成标记与租约释放补偿

- **环境/日期/代码版本/镜像：** 2026-09-25～26（UTC+8）。本机应用连接东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`，session pooler）。Web `sha256:c7f92d19…`、worker `sha256:80325b97…`（基线 `a0484f3e` + 本轮未提交改动）。真实课程运行时 Web 临时切到 Foreground（`GENERATION_BACKGROUND_ENABLED=0`），worker 仍为后台；结束后已恢复 Tier 4 / Background / 接收任务，readiness `ready=true`。
- **初始问题及复现步骤：** 方案第 5 节所述事实与代码一致：`setGenerationComplete` 先保存文档再调完成 API，失败只 `log.warn` 不重试；重开页面在 `persistedComplete=true` 时不再调完成 API；完成路由的“标记”和“释放”是两条独立自动提交的语句。复现：把 HEAD 版本的 `foreground-root-client.ts` 临时复制出来跑测试，完成请求返回 500 时只发 1 次、session id 保留、之后无任何补救（1 passed，证实缺陷），复现文件已删除。东京只读统计（修复前）：未删除课程中前台 `client` 课“大纲完成但镜像 false”为 0 门，当时无有效前台占用槽。
- **修改范围与原因：**
  1. **镜像语义（按已决定方案）：** `lib/persistence/stage-meta.ts` 字段注释改为：非权威镜像，只由前台完成路由与后台 worker 写入；Pro 智能体课程工具 / PPTX 导入直接写的大纲不写它；完成状态以大纲为准。未为 Pro/导入补写入，未修历史数据。
  2. **有界重试：** `lib/generation/foreground-root-client.ts` 的 `completeForegroundGenerationRoot` 对网络错误和 5xx 按 1 s / 3 s / 8 s 退避，共 4 次；4xx 不重试。只有成功后才清除 session id。新增 `ForegroundCompletionError`（`status`、`terminal`）和 `hasPendingForegroundGenerationSession`。`lib/store/stage.ts` 在最终失败（404 除外）时 `toast.warning(generation.completionSyncFailed)`，12 种语言已补文案。不会整份覆盖文档，只发窄的完成请求。
  3. **重开补偿：** 新增 `lib/generation/foreground-completion-compensation.ts`，由 `app/classroom/[id]/page.tsx` 在 `fetchStageMeta` 返回 `found` 后调用。条件全部满足才发：本人课程（`isOwner === true`）；自愈后的 store `generationComplete === true`；`outlineProducer !== 'server-job'`；且镜像为 false **或**本标签页仍保留该课 session id。等待加载时的自愈保存（`awaitStageSelfHealSave`）成功后才发，发前复核仍是同一门课；每门课每个页面生命周期最多一次，不轮询，失败静默（404/403 为终态）。浏览器持久化未开启时不发。
  4. **同一事务（必做）：** `app/api/stages/[id]/generation-complete/route.ts` 改为在 `db.withTransaction` 内依次 `markStageGenerationComplete` 与 `releaseForegroundGenerationRoot(..., tx)`；任一失败整体回滚并返回 500。`lib/server/stage-access.ts` 的 `getOwnerBoundStageAccessDb` 返回类型补上 `withTransaction`（对象本来就有）。
- **前后指标：** 修复后真实课程完成即释放槽位（见下），而不是占用到 60 分钟过期。
- **自动测试命令及结果：**
  - `node node_modules/vitest/vitest.mjs run tests/generation/foreground-root-client.test.ts tests/generation/foreground-completion-retry.test.ts tests/generation/foreground-completion-compensation.test.ts tests/store/stage-generation-complete.test.ts tests/store/stage-generation-complete-faults.test.ts tests/agent-runtime/stage-meta-routes.test.ts tests/agent-runtime/persistence-routes-gate.test.ts --maxWorkers=2`：全部通过。
  - 四个受控故障位置（`tests/store/stage-generation-complete-faults.test.ts`）：①最终保存失败 → 不发完成请求、不提示；②保存成功但完成请求耗尽重试 → 可见提示，重开后补偿发出；③请求成功但响应丢失 → 客户端用同一 session 重发，重开时凭保留的 session 再补一次，且不重写文档；④刷新重开 → 旧课自愈先保存后补偿；另外 server-job 课与未完成课都不会被补偿。
  - 重试（`foreground-completion-retry.test.ts`）：5xx/网络错误重试并清除 session；耗尽后保留 session；403/404 不重试；丢失响应后重发同一 session；无 session 时不带头。补偿（`foreground-completion-compensation.test.ts`）：资格矩阵（访客、未完成、server-job、换课）、每页一次、404 终态静默、持久化关闭、自愈失败、等待后换课。路由（`stage-meta-routes.test.ts`）：同一事务 BEGIN/COMMIT、释放失败时 ROLLBACK + 500、无 session 只标记、已删除课 404 不释放、外来 owner 403。
  - **真实 PostgreSQL**（一次性 `postgres:16` 容器，步骤同 `scripts/test-hosted-capacity.ps1`，详见 [P2-1 报告](2026-09-25-p2-1-capacity-scheduling-pg.md)）：`tests/server/hosted-capacity-rls.pg.test.ts` 新增 4 项全部通过——托管模式（`app_internal.release_heavy_task_foreground_lease`，`app_web` 登录角色 + 真实 RLS）释放失败时标记被回滚、槽位仍在，成功时两者同时生效、重试幂等；另一 owner 在 RLS 下既不能标记也不能释放；非托管模式（`DELETE FROM generation_provider_slots`）同样回滚/提交；已删除课程不会被标记。同批 42 项全部通过。
  - `tsc --noEmit`、ESLint 通过；全量回归见[汇总报告](2026-09-25-supabase-post-launch-execution-summary.md)。
- **真实操作与课程/任务/会话 ID（第 1.1 节第 3 条预授权的一门课）：**
  - 普通前台课程 **`y53vN4sbqq`**，提示词“P1-2 前台完成验收：用两页中文简单介绍同分母分数相加（1/5 + 2/5 = 3/5），不联网搜索。”，模型为页面默认“ZHIYU 默认模型 / DeepSeek V4.1 Flash”。01:19:10 开始，01:33:52 完成路由记录“Stage generation marked complete”，**耗时约 14 分 42 秒**，一次成功，未重试。
  - 生成中只读核对：该管理员 `heavy-task:sync-owner:` 组 1 个槽被持有，剩余 60 分钟。
  - 完成后只读核对：`stage_meta.generation_complete=true`、大纲 `generationComplete=true`、producer `client`、3 个大纲 / 3 个场景、`is_public=false`、owner 为管理员；**有效前台槽 0**（立即释放）；18 条 MP3（2,985,192 字节）均在私有桶；浏览器 `sessionStorage` 中无该课的前台 session 键。
  - 刷新重开：只发 stage-meta，没有再发完成请求（镜像已为 true 且无残留 session，符合条件）。
- **权限与持久化检查：** 路由仍先做 owner 校验（403/404），事务在 owner 绑定连接内执行；真实 RLS 测试证明外来 owner 无法标记或释放。课程保持私有。
- **与方案“事实”的差异（已报告，不影响实现）：** 验收报告中的 Pro 样本 `e48a0067-…` 实际经 worker job 生成，大纲为 `producerKind=course-worker`，镜像为 true；“Pro 课镜像恒为 false”只适用于智能体课程工具 / PPTX 导入直接写大纲的课，东京库当前没有这类课程。补偿对所有 `server-job` 一律跳过，因此不受影响。
- **回退方式及是否验证：** 还原上述代码与测试文件即可；数据层没有迁移或批量修改。本机镜像可用 `*:rollback-20260925-pre-postlaunch` 标签回退（未演练）。
- **结论：** 通过。
- **剩余事项：** 真实环境只覆盖了“正常完成”这一条路径；故障路径由单元测试与真实 PG 事务测试覆盖，未在浏览器中人为断网注入。关闭标签页后的租约仍只能等 60 分钟过期（按设计）。
