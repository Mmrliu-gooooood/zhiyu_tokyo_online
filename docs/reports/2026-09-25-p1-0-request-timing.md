# P1-0 请求分段计时埋点

- **环境/日期/代码版本/镜像：** 2026-09-25～26（UTC+8）。本机 Windows 11 + Docker Desktop，本机应用连接东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`），Web 走 session pooler `aws-0-ap-northeast-1.pooler.supabase.com:5432`，未经代理。镜像 Web `sha256:c7f92d19…`、worker `sha256:80325b97…`（基线 `a0484f3e` + 本轮未提交改动）。
- **初始问题：** 方案第 3 节：生产代码路径没有 Server-Timing、连接池等待统计或请求级分段计时。已核对与代码一致（`waitingCount` 等只出现在测试里）。
- **修改范围与原因：**
  - 新增 `lib/server/request-timing.ts`：基于 `AsyncLocalStorage` 的请求上下文。`REQUEST_TIMING_SAMPLE_RATE`（0～1，未设或非法 = 关闭）按比例抽样；抽中的请求输出一行 `RequestTiming` 日志：`requestId`（不合规则替换为 `invalid`）、固定路由类别、状态码、总毫秒、各阶段 `{count, ms}`。阶段名是固定白名单：`auth.claims`、`auth.account_self`（PostgREST 账号自查）、`auth.ensure_account`、`auth.load_account`、`auth.session_active`、`auth.retry_wait`（瞬时错误重试的退避）、`db.checkout`（池等待）、`db.query`（SQL 次数与总耗时，含 `BEGIN`/`set_config`/`COMMIT`）、`storage.first_byte`（S3 GetObject 响应头）、`storage.read`（整个对象）。`REQUEST_TIMING_SERVER_HEADER=1` 时另设同名 `Server-Timing` 头。不写 cookie、token、连接串、owner、对象键、签名 URL 或错误原文。
  - 埋点位置：`lib/auth/session.ts` 五个鉴权步骤与重试退避；`lib/db/pool-registry.ts` 在**开关开启时**才给池挂钩子（关闭时池完全不变）；`lib/persistence/asset-byte-store.ts` 的 S3 读取；`packages/@openmaic/storage/src/asset/s3-bytes.ts` 的 `loadS3AssetByteStore` 增加可选 `wrapClient` 参数（向后兼容，关闭时调用形状与原来一致）；持久化路由 `app/api/persistence/[...path]/handler.ts` 与 `app/api/stage-meta/[stageId]/route.ts` 外包一层计时。
  - `docker-compose.supabase.yml` 的显式环境白名单加入两个变量（默认空 = 关闭），`.env.example` 补说明。
- **前后指标：**
  - 埋点自身开销（本机微基准，3 轮）：关闭时每个阶段调用多约 0.05 µs、每个请求多约 0.7 µs；开启时每个阶段约 0.4–0.5 µs、每个请求约 2.2–2.7 µs（不含写日志）。相对毫秒到秒级的网络耗时可以忽略。
  - 实测：同一请求能给出完整分段，例如一次课程文档 GET：`auth.claims` 1 ms、`auth.account_self` ~1.3 s、`auth.ensure_account` ~0.3 s、`auth.load_account` ~3.5 s、`auth.session_active` ~0.3 s、`db.checkout` 5 次共 ~3.4 s、`db.query` 17 条共 ~6.9 s（数值为本机样本中位数，详见 P1-1 报告）。匿名请求只有 `auth.claims`，响应 401。
- **自动测试命令及结果：**
  - `node node_modules/vitest/vitest.mjs run tests/server/request-timing.test.ts`：18 项通过。覆盖：采样率解析；关闭时不输出日志/不加头、辅助函数直通；超出采样不输出；记录字段白名单与阶段名白名单；非法 requestId 被替换；失败路径状态为 `error`、日志不含连接串或 owner 等原始错误内容且原错误照常抛出；`Server-Timing` 只含阶段名；并发请求互不串；池钩子在回调与 Promise 两种形式下计数、幂等、上下文外不计数；S3 只对 GetObject 计首字节。
  - 相关回归：`tests/persistence`、`tests/auth`、`tests/agent-runtime/stage-meta-routes.test.ts`、`tests/packages`、`tests/persistence/asset-s3-config.test.ts`（原调用形状）、`tests/providers/provider-neutrality-guard.test.ts`（厂商词预算）均通过。`tsc --noEmit`、ESLint 通过。全量见[汇总报告](2026-09-25-supabase-post-launch-execution-summary.md)。
- **真实操作与课程/任务/会话 ID：** 用于分段验证的请求来自 P1-1 基线（课程 `94c0ee87-31af-4db5-af39-93f7eb414220`、`e48a0067-5d13-43fd-88db-041f30880af4`）。
- **权限与持久化检查（安全审查）：** 日志与响应头只含白名单阶段名、固定路由类别和数字；路由类别不含任何 id；请求 id 沿用 handler 已有的安全正则。开关只读取环境变量，不改变鉴权、owner 绑定或 RLS 行为。
- **回退方式及是否验证：** 运行时：把 `REQUEST_TIMING_SAMPLE_RATE` 置空后 `-Action Apply` 即关闭（本轮测量结束后已这样恢复）。代码：还原上述文件。
- **结论：** 通过。
- **剩余事项：** 只覆盖持久化与 stage-meta 路由；聊天 SSE、生成路由等如需分段，要另行扩展。生产默认关闭；需要时建议低采样（如 0.05）。
