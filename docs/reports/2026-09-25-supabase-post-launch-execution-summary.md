# Supabase 上线后优化清单：本轮执行汇总（2026-09-25～26）

依据：[后置优化实施清单](../plans/2026-09-23-supabase-post-launch-improvements.md)。用户在本会话中授权：东京 Supabase 写入、生产服务器操作、付费模型调用和真实邮件发送可直接执行（仅限本会话）；每个工作项最多一门真实课程。本轮实际**没有**对东京 Supabase 做任何写入（只读 SQL、Advisor、日志查询，以及应用正常流程生成的一门课），没有登录生产服务器，没有发送邮件。未提交 git。

## 环境

- 本机 Windows 11 + Docker Desktop 29.7.2（VM 8 GiB / 20 核），中国大陆家庭网络，无代理。
- 东京 Supabase `zhiyu-tokyo` / `lvbtgwlsebzbtcvjwktq` / `ap-northeast-1`，PostgreSQL 17.6，`ACTIVE_HEALTHY`；未连接已删除的新加坡项目。
- 基线提交 `a0484f3e`；本轮改动未提交。测试用 Node v24.18.1（PATH 上的 v18.19.0 不满足 `>=22.13.0`）。
- 新本机镜像：Web `sha256:c7f92d1993a0bd37ff22b83f50bbb3f609eaed387d200e2d2e3e86090ee31467`，worker `sha256:80325b9721889e1e22a59fdaaa59d94d787cdf16c3aa9331c8bb1d4c605dcc87`。回滚标签 `zhiyu-supabase-{web,worker}:rollback-20260925-pre-postlaunch`（原镜像 `8618bed6…` / `811f548b…`）。
- 结束状态：Tier 4 / Background / 2 worker / 接收任务，请求计时关闭，readiness `ready=true`（账号 v19、生成 v4、worker 2/2、私有桶 3/3）。

## 各工作项结论

| 工作项 | 结论 | 报告 |
| --- | --- | --- |
| D0-0 统一 `TRUST_PROXY_HEADERS` | 通过 | [d0-0](2026-09-25-d0-0-trust-proxy-headers.md) |
| D0 生产环境最小验收 | 受外部条件限制（生产配置与脚本入库、本机镜像已构建；服务器/域名/Auth 回调未做） | [d0](2026-09-25-d0-production-config.md) |
| P1-0 请求分段计时 | 通过 | [p1-0](2026-09-25-p1-0-request-timing.md) |
| P1-1 读取延迟 | 受外部条件限制（本机→东京基线与分段完成；无延迟目标，不做优化；服务器基线待 D0） | [p1-1](2026-09-26-p1-1-tokyo-read-latency-baseline.md) |
| P1-2 完成标记与租约释放 | 通过（含一门真实前台课 `y53vN4sbqq`） | [p1-2](2026-09-26-p1-2-foreground-completion-lease.md) |
| P1-3 私有媒体 redirect | 未开工：缺 D0 第 7 步的服务器媒体中转基线与测试环境；未切换 `ASSET_BYTE_EGRESS` | — |
| P2-1 4→8→16 容量 | 受外部条件限制（第 2 步临时 PG 调度测试 42/42 通过） | [p2-1](2026-09-25-p2-1-capacity-scheduling-pg.md) |
| P2-2 课堂与学伴矩阵 | 受外部条件限制（按已有证据整理，东京浏览器实测待测） | [p2-2](2026-09-25-p2-2-classroom-matrix.md) |
| P2-3 观测与恢复 | 受外部条件限制（只读统计 + 生产日志轮转配置） | [p2-3](2026-09-25-p2-3-observability-recovery-readonly.md) |
| P3-1 编辑器配音标签 | 通过（真实样本 4 条“已配音”+1 条“无法确认”，0 条误报“未配音”） | [p3-1](2026-09-26-p3-1-editor-voiced-label.md) |
| P3-2 教学图片质量 | 未开工：缺正确性判定标准、样本集、费用上限 | — |

## 重要发现（需要用户决定）

1. **每个已登录请求都会销毁一条数据库连接（P1-1）。** 托管模式调用的 `app_internal.ensure_account` 在东京库不存在（它属于旧 classroom 注册表），代码把 42883 吞掉，但 node-postgres 会销毁出错的连接，下一条查询只能重连；本机每次约 2.9 s，Postgres 日志 80 分钟内该错误 795 次。另外 `loadAccount` 在 RLS 下恒为 0 行，托管模式的 `session_valid_after` 检查因此不生效（撤销依赖 `session_is_active`，仍有效）。这与方案对托管鉴权路径的描述不一致；按守则只报告，未改代码。建议作为下一项单独修复（需真实 RLS 证据）。
2. **方案 P1-2“Pro 课镜像恒为 false”只对部分 Pro 路径成立。** 验收用的 Pro 样本经 worker job 生成，镜像为 true。实现已对所有 `server-job` 课跳过补偿，不受影响。
3. **tmpfs 无上限：** 本机每个挂载默认约 3.8 GiB，共 6 个；8 GB 服务器上是风险（P2-3）。

## 测试命令与结果

- 第 12 节分组（D0-0、认证与读取、完成状态、媒体出口、配音标签、`tests/config`）及本轮新增测试：31 个文件 337 项通过；修正后相关目录（auth/config/generation/store/agent-runtime/persistence/audio/media/edit/providers/learning/classroom/api 等）360 个文件 3,415 项通过、13 跳过。
- 真实 PostgreSQL（一次性容器）：`generation-jobs.pg`、`generation-worker-pipeline.pg`、`hosted-capacity-rls.pg`、`account-deletion-lifecycle`：42/42 通过。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。ESLint（全部改动文件）：通过。改动文件在 HEAD 已符合 Prettier 的，改后仍符合；`lib/auth/session.ts` 与 `tests/auth/security-boundaries.test.ts` 在 HEAD 就不符合 Prettier，未整体重排以免无关 diff。
- 全量 `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=15000`（最后一次）：835 个文件，8,616 项中 **8,487 通过、2 失败、127 跳过**。2 个失败是 `tests/components/chat/guided-mode-toggle.test.ts` 与 `tests/components/stage/classroom-complete-title.test.ts`，报错为本机缺少 Playwright 的 `chromium_headless_shell-1208`（`C:\Users\Lenovo\AppData\Local\ms-playwright` 不存在）。这两项在迁移时的全量运行中通过，且不涉及本轮改动；安装浏览器需要下载，未经确认未执行。跳过数比迁移时多 57 项，差异来自 `tests/video-export/cover-card-layout.browser.test.ts`（53 项，同样依赖浏览器）和 `hosted-capacity-rls.pg`（未设临时库时跳过，含本轮新增 4 项）。
- 第一次全量时另有 2 项失败并已修正：`provider-neutrality-guard`（新增辅助函数名含 `S3` 超出厂商词预算，已改为中性名称）与 `persistence-routes-gate`（mock 缺 `withTransaction`，已补）。

## 改动清单（未提交，供确认）

**新增**
- `lib/auth/trust-proxy.ts`（D0-0）
- `docker-compose.production.yml`、`scripts/supabase-compose.sh`（D0）
- `lib/server/request-timing.ts`（P1-0）
- `lib/generation/foreground-completion-compensation.ts`（P1-2）
- 测试：`tests/auth/trust-proxy.test.ts`、`tests/config/production-compose-contract.test.ts`、`tests/server/request-timing.test.ts`、`tests/generation/foreground-completion-retry.test.ts`、`tests/generation/foreground-completion-compensation.test.ts`、`tests/store/stage-generation-complete-faults.test.ts`、`tests/edit/speech-tts-bar-status.test.ts`
- 报告：`docs/reports/2026-09-25-*`（d0-0、d0、p1-0、p2-1、p2-2、p2-3、本汇总）、`docs/reports/2026-09-26-*`（p1-1、p1-2、p3-1）

**修改**
- D0-0：`lib/auth/rate-limit.ts`、`app/api/export-video/render/route.ts`、`.env.example`、`render-service/README.md`、`tests/auth/security-boundaries.test.ts`
- P1-0：`lib/auth/session.ts`、`lib/db/pool-registry.ts`、`lib/persistence/asset-byte-store.ts`、`packages/@openmaic/storage/src/asset/s3-bytes.ts`（可选 `wrapClient`，向后兼容）、`app/api/persistence/[...path]/handler.ts`、`app/api/stage-meta/[stageId]/route.ts`、`docker-compose.supabase.yml`（两个默认空的计时变量）、`.env.example`
- P1-2：`lib/generation/foreground-root-client.ts`、`lib/store/stage.ts`、`app/classroom/[id]/page.tsx`、`app/api/stages/[id]/generation-complete/route.ts`、`lib/server/stage-access.ts`、`lib/persistence/stage-meta.ts`（注释）、12 个 `lib/i18n/locales/*.json`（`generation.completionSyncFailed`）、`tests/agent-runtime/stage-meta-routes.test.ts`、`tests/agent-runtime/persistence-routes-gate.test.ts`、`tests/server/hosted-capacity-rls.pg.test.ts`
- P3-1：`lib/audio/regenerate-speech-tts.ts`、`components/edit/ActionsBar/ActionsBar.tsx`、12 个语言文件（`edit.tts.statusChecking/statusMissing/statusUnknown`）、`tests/audio/regenerate-speech-tts.test.ts`

**不属于本轮：** `docs/plans/2026-09-23-supabase-post-launch-improvements.md` 的改动（删除文末接续提示词）在会话开始前就存在，未触碰。

**仓库外 / 被忽略的产物：** `packages/@openmaic/storage/dist/`、`dist-worker/`（本地重建，git 忽略）；Docker 镜像与回滚标签（见“环境”）。

## 需要用户提供的输入

- D0：服务器 SSH 与可操作范围、域名 DNS/HTTPS 现状、东京 Auth Site URL/回调修改授权、专用测试账号。
- P1-1：第 4 节五类接口的 P95 目标；是否把“连接销毁”作为下一项修复。
- P1-3：D0 第 7 步的媒体中转基线与测试环境。
- P2-1：≥8 个测试 owner、模型/图片/TTS 配额、费用上限、成功率门槛。
- P2-2：三种模式新生成的费用授权（超出每项一门的预授权）。
- P2-3：隔离恢复环境、告警渠道。
- P3-2：图片正确性标准、样本集、费用上限。
- 可选：是否允许下载 Playwright Chromium 以恢复 2 个布局测试。
