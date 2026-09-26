# P1-1 课程与学习记录读取延迟：东京基线与分段定位（本机）

- **环境/日期/代码版本/镜像：** 2026-09-26 00:00–01:10（UTC+8）。**本机**应用（Windows 11 + Docker Desktop，中国大陆家庭网络，无代理）连接东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`）；Web 用 session pooler `aws-0-ap-northeast-1.pooler.supabase.com:5432`，池上限 5。Web 镜像 `sha256:c7f92d19…`（含 P1-0 埋点，`REQUEST_TIMING_SAMPLE_RATE=1`、`REQUEST_TIMING_SERVER_HEADER=1`）。Tier 4 / Background / 2 worker。**这不是东京生产服务器的基线**；服务器部署后须按同一方法重测，两者分开记录。
- **网络参考（容器内实测）：** 到 pooler：DNS 332 ms，TCP 建连 210–430 ms（5 次）；到 `*.supabase.co:443`：DNS 255 ms，TCP 221–773 ms，TLS 800 ms。容器内直接测：**新建一条 DB 连接 2,947 ms**；复用连接 `SELECT 1` 239–446 ms。
- **测量方法：** 用已登录管理员的浏览器页面，按客户端实际请求形状串行发起：课程文档 GET（旧课 `94c0ee87-31af-4db5-af39-93f7eb414220`、新课 `e48a0067-5d13-43fd-88db-041f30880af4`）、`GET /api/stage-meta/{id}`（两门）、资产字节 GET（带描述符 `Accept`，图片 `ast_hde6jh95…` 408 KB、音频 `ast_1j3fx7mb…` 105 KB）、学伴历史完整加载（旧课，1 次会话列表 + 6 个会话记录，4 路并发，同 `lib/learning/teach-back/runtime.ts`）、聊天首轮恢复（旧课，1 次列表 + 9 个会话记录，不设上限全并发，同 `lib/utils/chat-storage.ts`）。每类先丢弃 1 次预热，再取 30 次热读；冷启动样本在空闲 >60 秒（池空闲回收）后单独测。30 次只作初步定位，不是 SLA。
- **延迟目标：** 方案第 4 节目标表**未由用户填写**。按第 1.1 节第 5 条只做第 1–2 步，**不实施代码优化**。

## 热读取基线（浏览器端，毫秒，n=30/类，失败 0）

| 类别 | 中位数 | P95 | 最大 | 最小 | 响应大小 / 请求数 |
| --- | ---: | ---: | ---: | ---: | --- |
| 文档 GET（旧课） | 11,791 | 15,766 | 17,945 | 7,945 | 97.7 KB |
| 文档 GET（新课） | 10,634 | 12,835 | 14,556 | 8,771 | 12.3 KB |
| stage-meta（旧课） | 6,564 | 8,604 | 9,194 | 5,661 | 98 B |
| stage-meta（新课） | 7,070 | 8,100 | 8,157 | 5,770 | 98 B |
| 资产字节（图片） | 11,234 | 19,364 | 22,858 | 9,160 | 408 KB |
| 资产字节（音频） | 10,568 | 12,488 | 12,499 | 7,416 | 105 KB |
| 学伴历史完整加载 | 20,246 | 22,218 | 22,345 | 17,738 | 7 个 HTTP 请求 |
| 聊天首轮恢复 | 20,411 | 28,409 | 30,050 | 18,301 | 10 个 HTTP 请求 |

冷启动样本：见文末“冷启动”。

## 服务端分段（P1-0 日志，同一时段全部 200 请求，毫秒）

| 路由（n） | 总计中位 / P95 | account_self | ensure_account | load_account | session_active | db.checkout（次数） | db.query（条数） | Storage 首字节 / 全量 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 文档（128） | 11,296 / 17,257 | 1,456 | 313 | 3,315 | 296 | 3,086（5）P95 7,481 | 6,802（17） | — |
| stage-meta（62） | 6,786 / 8,148 | 1,533 | 296 | 3,240 | 292 | 2,914（4）P95 4,050 | 2,349（7） | — |
| runtime（527） | 8,370 / 13,329 | 1,368 | 506 | 2,967 | 313 | 3,353（5）P95 7,197 | 3,665（11） | — |
| 资产（70） | 10,833 / 15,607 | 1,507 | 290 | 3,120 | 255 | 2,745（4） | 2,521（8） | 1,700 / 4,060 |

`auth.claims` 中位 1–2 ms：`@supabase/auth-js` 2.116 把 JWKS 按 storageKey 在进程级缓存 10 分钟（`GLOBAL_JWKS`），每请求新建客户端不会重复拉 JWKS。本轮 `auth.retry_wait` 未出现（无瞬时错误重试）。

## 分段结论（按占比）

1. **每个已登录请求都会丢弃一条池连接并重连（新发现，占约 3 s）。** 托管模式下 `lib/auth/session.ts` 调用的 `app_internal.ensure_account` 在东京库中**不存在**（该函数属于旧本地 classroom 注册表 v6/v7；托管 schema 不创建它，代码有意把 42883 当作“注册表不存在”吞掉，`tests/persistence/request-auth-reuse.test.ts` 也按此模拟）。但 `pool.query` 出错时 node-postgres 会把该连接**销毁**（pg-pool `_release(client, …, err)`），紧接着的 `load_account` 只能新建连接，本机实测新建一条约 2.9 s，与 `load_account` 中位 3.1–3.3 s 吻合。东京 Postgres 日志 80 分钟内该错误 795 次，Supavisor 记录 1,502 次客户端认证。服务器与数据库同在东京时每次重连仍需 TLS + SCRAM 多次往返，并持续制造 Postgres ERROR 日志和 Supavisor 连接抖动。
2. **`load_account` 在托管模式下必然返回 0 行。** 它用未绑定 owner 的 `app_web` 连接查 `app_accounts`，而 `app_accounts_web_select` 要求 `owner_id = current_owner_id()`；角色/状态实际来自 `account_self`（PostgREST + JWT）。它的 `session_valid_after` 撤销检查因此在托管模式下不起作用，撤销实际依赖 `session_is_active`（该函数存在且有效）。
3. **owner 绑定查询的往返放大。** 文档 GET 每次 17 条语句、5 次 checkout；每条业务 SQL 伴随 `BEGIN`/`set_config`/`COMMIT`。本机单条往返约 0.25–0.4 s，所以语句数直接决定耗时（文档 ~6.8 s）。
4. **PostgREST 账号自查**（HTTPS 到 `*.supabase.co`）约 1.4–1.5 s/请求。
5. **聊天首轮全并发**：9 个会话记录请求同时打到上限 5 的池，`db.checkout` P95 达 7.2 s（runtime 路由），聊天恢复 P95 28 s，高于学伴的 4 路有界并发（P95 22 s）。
6. **媒体**：S3 首字节中位 1.7 s、整对象 4.1 s，其余是同样的鉴权与 SQL 开销；图片 P95 19 s。

这些都是“本机 → 东京”约 0.3 s RTT 下的放大结果，不能直接推断服务器上的数值；但第 1 条的“每请求销毁一条连接”与网络位置无关，在服务器上同样发生。

## 与方案“代码现状”不一致之处（按守则报告）

方案第 4 节写“正常托管路径共 5 次串行往返：`getClaims`、PostgREST 自查、`ensure_account`（`loadAccount` 在其成功路径内部调用）、`session_is_active`”。实际托管路径中 `ensure_account` **每次都失败**（函数不存在），所以 `loadAccount` 走的是外层兜底，并且因上一步出错而新建连接；`loadAccount` 在 RLS 下恒为 0 行。往返次数仍是 5 次，但成本结构与文中假设不同。本项未据此修改代码。

## 候选优化（未实施，待用户确认目标后按一次一项进行）

- 托管模式下不再调用 classroom 专用的 `ensure_account`/`loadAccount`（或进程内记住“函数不存在”后不再调用）；至少避免让 42883 走会销毁连接的 `pool.query` 路径。须保留每请求的 `session_is_active` 撤销校验，并用真实 PostgreSQL/RLS 证明托管角色/状态与撤销语义不变（参见方案中已撤回的反证）。
- 聊天首轮每会话读取改为有界并发（对齐学伴 4 路），或批量接口。
- 同一请求的多条 owner 绑定 SQL 合并进一次 `withTransaction`。
- 以上都要在同一环境、同一数据集复测，并与东京服务器基线分开统计。

## 冷启动（每次前空闲 70 秒，n=3/类，失败 0）

| 类别 | 样本（ms） | 分段特征 |
| --- | --- | --- |
| 文档 GET（旧课） | 17,307 / 18,703 / 13,678 | `ensure_account` 3.1–3.5 s、`load_account` 2.9–3.9 s（两次都新建连接），checkout 5.7–6.5 s |
| stage-meta（新课） | 10,660 / 9,519 / 9,524 | 同上，checkout 5.3–6.5 s |
| 资产字节（音频） | 22,551 / 13,574 / 14,172 | 另有 Storage 首字节 1.4–4.8 s |

冷启动比热读取多约一次新建连接（~3 s）：池空闲 60 秒后回收，`ensure_account` 也要新建，随后它的出错又让 `load_account` 再建一次。首个冷样本 `auth.claims` 650 ms，其后约 1 ms（JWKS 缓存）。

- **自动测试命令及结果：** 本项未改代码；埋点测试见 [P1-0 报告](2026-09-25-p1-0-request-timing.md)。
- **真实操作与课程/任务/会话 ID：** 课程 `94c0ee87-31af-4db5-af39-93f7eb414220`、`e48a0067-5d13-43fd-88db-041f30880af4`；学习者 `user:64b61f8a-…`（管理员）；资产 `ast_hde6jh95vthpwtrxn77bwzp3a0`、`ast_1j3fx7mbt4fpx3n6p67gghmdgc`。全部只读。
- **权限与持久化检查：** 只读请求，全部 200；未修改数据库、RLS 或池参数。东京 `max_connections=60`、当时 23 个后端（见 [P2-1 报告](2026-09-25-p2-1-capacity-scheduling-pg.md)），池参数未调整。
- **回退方式及是否验证：** 无代码改动；测量结束后已把计时开关恢复为关闭。
- **结论：** 受外部条件限制（东京本机基线与分段定位完成；延迟目标未提供，未做代码优化；服务器基线待 D0）。
- **剩余事项：** 用户填写第 4 节目标表；D0 部署后在服务器上用同一脚本复测；确认是否把第 1 条作为下一项单独修复。
