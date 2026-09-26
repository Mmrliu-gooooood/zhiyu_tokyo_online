# P1-1 托管鉴权重连修复与东京服务器读取基线

- **环境/日期/代码版本/镜像：** 2026-09-26（UTC+8）。东京生产服务器 `154.36.184.44`（雨云东京，Debian 12，4 vCPU / 7.8 GiB / 40 GB，出口 AS979 NetLab Global，无代理），经宝塔 Nginx 1.26.3 以 `https://zhiyulearn.online` 反代到 `127.0.0.1:3000`。东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`），Web 走 session pooler，池上限 5。镜像 Web `zhiyu-supabase-web:release-20260926`（`473537d1fd49`）、worker `zhiyu-supabase-worker:release-20260926`（`b5e6da9b309c`），基线 `a0484f3e` + 本轮未提交改动。Tier 4 / Background / 2 worker。测量期间 `REQUEST_TIMING_SAMPLE_RATE=1`、`REQUEST_TIMING_SERVER_HEADER=1`。服务器到 Supabase：TCP 11–33 ms、TLS 47–82 ms（`*.supabase.co`）；到 pooler TCP 11–33 ms。浏览器端数值来自用户本机（中国大陆家庭网络 → 东京），与服务器处理时间分开列出。
- **初始问题及复现步骤：** 见 [P1-1 本机基线](2026-09-26-p1-1-tokyo-read-latency-baseline.md) 第 1 条：托管模式每个已登录请求都调用东京库中不存在的 `app_internal.ensure_account`（classroom 注册表专用），42883 被代码吞掉，但 node-postgres 会销毁出错的池连接，紧接着的 `loadAccount` 只能新建连接；`loadAccount` 在 `app_web` RLS 下恒为 0 行。只读核对东京：`app_internal` 只有 `current_owner_id`、`session_is_active`，无 `ensure_account`；`app_web` 非 BYPASSRLS；`authenticated` 对 `app_accounts` 只有 `user_id, owner_id, role, status` 列权限。修复前 Postgres 日志 2026-09-25 16:00–18:00（UTC）共 967 条该错误。真实 PostgreSQL 复现：在与东京同构的临时库（生产 `session_is_active` 与 `app_accounts` DDL、`app_accounts_web_select` 策略原文，`app_web` 登录角色）上，用修复前代码连续 20 次托管请求，池 `remove` 事件 20 次（每请求销毁 1 条连接）。
- **修改范围与原因：**
  - `lib/auth/session.ts`：托管模式（`isHostedAuthEnabled()`）不再调用 `ensureAccountRow`/`loadAccount`；角色与状态继续来自用户 JWT 的 PostgREST 自查（`app_accounts_self_select`），每个请求仍执行 `app_internal.session_is_active` 撤销校验。双模式 classroom 路径（`AUTH_MODE` 未设）完全不变。
  - 为什么不影响撤销语义：托管模式下被跳过的 `loadAccount` 在 RLS 下永远读不到行，`session_valid_after` 检查此前本就不生效；唯一写 `session_valid_after` 的代码（`lib/server/accounts/deletion.ts`）同时把 `status` 置为 `deleting`，JWT 自查会拒绝（`ACCOUNT_DISABLED`）；会话撤销仍由 `session_is_active` 保证。未放宽任何 RLS/授权，未改 schema。
  - 测试：新增 `tests/auth/hosted-principal-registry.pg.test.ts`（真实 PostgreSQL/RLS，5 项），加入 `scripts/test-hosted-capacity.ps1` 的临时库清单；`tests/persistence/request-auth-reuse.test.ts` 新增 2 项（托管模式不查 classroom 注册表但仍查会话；关闭托管时保留原路径）。
- **延迟目标（用户授权按行业惯例制定，2026-09-26）：** 以东京服务器上的应用处理时间（`RequestTiming` 的 `totalMs`，含鉴权、SQL、Storage，不含用户网络）为验收口径；参考 Google RAIL（1 s 内保持操作连贯）与 Core Web Vitals（LCP ≤ 2.5 s 为“良好”）以及常见读取 API P95 数百毫秒的做法。

  | 接口类别 | 代表请求 | 服务器处理 P95 目标 | 大陆浏览器端参考目标 |
  | --- | --- | --- | --- |
  | 课程文档读取 | 文档 GET | ≤ 800 ms | ≤ 2.5 s |
  | 课程元信息 | `GET /api/stage-meta/[id]` | ≤ 300 ms | ≤ 1.5 s |
  | 单个媒体资产（≤ 500 KB） | 资产字节 GET | ≤ 1,000 ms | ≤ 4 s |
  | 学伴历史完整加载 | 1 列表 + N 记录 | 单请求 ≤ 500 ms | ≤ 3 s |
  | 聊天首轮恢复 | 1 列表 + N 记录 | 单请求 ≤ 500 ms | ≤ 3 s |
  | 连接池等待 | `db.checkout` | < 1 s（方案原值） | — |

- **前后指标（东京生产服务器，修复后；n=30 热读取/类，失败 0；浏览器 = 用户本机大陆网络；服务器 = 该请求 `Server-Timing` 的 `total`，历史类取每轮各请求中的最大值）：**

  | 类别 | 服务器 中位 / P95 / 最大（ms） | 浏览器 中位 / P95 / 最大（ms） | 大小 / 请求数 | 是否达标（服务器口径） |
  | --- | --- | --- | --- | --- |
  | 文档 GET（旧课） | 173 / 189 / 194 | 1,311 / 1,970 / 2,081 | 97.7 KB | 是 |
  | 文档 GET（新课） | 137 / 157 / 170 | 770 / 1,098 / 1,174 | 12.3 KB | 是 |
  | stage-meta（旧课） | 65 / 83 / 355 | 463 / 1,719 / 2,064 | 98 B | 是 |
  | stage-meta（新课） | 60 / 76 / 78 | 566 / 1,335 / 1,652 | 98 B | 是 |
  | 资产字节（图片） | 314 / 433 / 456 | 3,454 / 12,495 / 15,516 | 408 KB | 是（浏览器端未达参考） |
  | 资产字节（音频） | 209 / 328 / 406 | 1,763 / 3,983 / 6,216 | 105 KB | 是 |
  | 学伴历史完整加载 | 114 / 197 / 270 | 2,100 / 3,045 / 8,168 | 7 请求 | 是（浏览器端略超） |
  | 聊天首轮恢复 | 134 / 334 / 600 | 1,803 / 2,469 / 2,564 | 10 请求 | 是 |

  - 池等待：服务器全部 791 条计时记录中 `db.checkout` 单请求累计最大 64 ms，各类 P95 ≤ 0.4 ms。
  - 结构变化：`auth.ensure_account` 与 `auth.load_account` 阶段在 791 条记录中出现 0 次；文档 GET 由每请求 5 次 checkout / 17 条 SQL 降为 3 次 / 15 条。
  - Postgres 日志：2026-09-26 04:25–05:30 UTC（生产启动后，覆盖上述约 800 个已登录请求）`ensure_account` 错误 0 条、ERROR/FATAL 0 条；修复前一日同类错误 967 条。
  - 与本机基线对比：本机基线（[p1-1 本机报告](2026-09-26-p1-1-tokyo-read-latency-baseline.md)，修复前镜像）服务器处理中位数文档 11.3 s、stage-meta 6.8 s。两者既有网络位置差异（本机→东京 RTT 0.2–0.4 s，服务器→东京 ~1 ms）又有代码差异，**不能把差值全部归于本次修复**；修复前的 pre-fix 镜像已不在本机，未在服务器上做同环境 A/B。修复本身的因果证据是真实 PostgreSQL 测试（同一数据库、同一请求序列：修复前 20 次请求销毁 20 条连接，修复后 0 条）与东京日志中错误归零。
  - 浏览器端：大陆网络下图片 408 KB 的 P95 12.5 s，主要是跨境链路与服务器 20 Mbps 上行中转（服务器处理只占 0.43 s），属于 P1-3（媒体 redirect）范畴，本项未改。
- **自动测试命令及结果：**
  - `node node_modules/vitest/vitest.mjs run tests/auth tests/persistence --maxWorkers=2`：226 通过、7 跳过（首轮 1 项 `owner-scoped-surfaces` 冷启动超时，单独连续重跑 3 次均通过，属已知负载抖动）。
  - 真实 PostgreSQL（一次性 `postgres:16`，tmpfs，`127.0.0.1:55432`）：`tests/auth/hosted-principal-registry.pg.test.ts` 5/5 通过——classroom 路径 5 次请求销毁 5 条连接（基线对照）；托管路径 20 次请求 0 次新建/销毁连接、0 次 `ensure_account`/`app_accounts` 查询、20 次 `session_is_active`；未绑定 owner 的 `app_web` 读 `app_accounts` 为 0 行、绑定后仅见本人；会话被删除、他人会话 → `SESSION_REVOKED`；JWT 自查状态 `deleting`/`disabled` → `ACCOUNT_DISABLED`；无账号行 → `AUTH_UNAVAILABLE`；admin 角色保持。把 `session.ts` 临时还原为修复前代码重跑，托管用例失败（`expected 20 to be 0`），证明测试能捕获该缺陷；随后已恢复。`tests/server/hosted-capacity-rls.pg.test.ts` 同批 16 项通过。
  - `tsc --noEmit`、ESLint、Prettier（改动文件）通过；全量回归见[汇总报告](2026-09-26-supabase-post-launch-round2-summary.md)。
- **真实操作与课程/任务/会话 ID：** 课程 `94c0ee87-31af-4db5-af39-93f7eb414220`（旧）、`e48a0067-5d13-43fd-88db-041f30880af4`（新）；学习者为管理员；资产 `ast_hde6jh95vthpwtrxn77bwzp3a0`（图片）、`ast_1j3fx7mbt4fpx3n6p67gghmdgc`（音频）。全部只读，管理员由用户本人在生产域名登录。
- **权限与持久化检查：** 未改 RLS、授权或 schema；撤销、跨会话、禁用/删除中账号均由真实 PG 测试证明仍被拒绝；生产上管理员读取本人课程全部 200。
- **回退方式及是否验证：** 还原 `lib/auth/session.ts` 该分支即可（无数据迁移）；服务器可把 `ZHIYU_WEB_IMAGE` 指回上一 release 标签后 `scripts/supabase-compose.sh apply`。代码回退已在测试中演练（临时还原 → 测试失败 → 恢复）；镜像回退未演练。
- **结论：** 通过（修复有真实 PG/RLS 证据与生产日志佐证；东京服务器处理时间全部达到事先约定目标）。
- **剩余事项：**
  - 大陆浏览器端的媒体下载时间（图片 P95 12.5 s）未达参考目标，取决于跨境链路与服务器上行，建议按 P1-3 评估 redirect。
  - 学伴历史浏览器端 P95 3.0 s 略超参考目标，瓶颈是 7 次串行/有界 HTTP 往返的跨境 RTT；如需再降，可按方案候选项做批量读取（未实施）。
  - 冷启动样本未在服务器上单独测量（服务器新建连接开销约 TLS 50–80 ms 量级，远小于本机）。
