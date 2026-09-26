# D0-0 统一 `TRUST_PROXY_HEADERS` 取值

- **环境/日期/代码版本/镜像：** 2026-09-25（UTC+8），本机 Windows 11 + Docker Desktop 29.7.2；基线提交 `a0484f3e`，改动未提交。只做代码与单元测试，未连接东京 Supabase，未构建或替换镜像。测试用 Node v24.18.1（PATH 上的 v18.19.0 低于 `package.json` 要求的 `>=22.13.0`，未使用）。
- **初始问题及复现步骤：** `lib/auth/rate-limit.ts` 只认 `'1'`，`app/api/export-video/render/route.ts` 只认 `'true'`，与方案第 2.1 节“事实”一致。复现：新增的路由用例在原路由代码上运行，`TRUST_PROXY_HEADERS=1` 时导出身份仍为 `direct`，用例失败（1 failed / 14 passed），换回新代码后通过。
- **修改范围与原因：**
  - 新增 `lib/auth/trust-proxy.ts`：`trustProxyHeaders(env = process.env)`，去除首尾空白、不区分大小写，只接受 `1` / `true`。
  - `lib/auth/rate-limit.ts`、`app/api/export-video/render/route.ts` 两处读取点改为调用该函数，其余逻辑不变（未启用时限流仍回落 `untrusted-client`，导出仍回落 `direct`）。
  - `.env.example`、`render-service/README.md` 改为“`1` 或 `true` 均可”，示例统一为 `1`。
- **前后指标：** 不涉及性能。
- **自动测试命令及结果：**
  - `node node_modules/vitest/vitest.mjs run tests/auth/security-boundaries.test.ts tests/auth/trust-proxy.test.ts --maxWorkers=2`：2 个文件、17 项通过。
  - 新增 `tests/auth/trust-proxy.test.ts`：`1`、`true`、`TRUE`、` 1 `、` True ` 为 true；未设置、空串、`0`、`false`、`yes`、`on`、`2` 为 false；导出路由在 `1` 与 `true` 下都采信 `x-forwarded-for` 首段，未设置时为 `direct`。
  - `tests/auth/security-boundaries.test.ts` 原有 `'1'` 用例保持通过，另补 `'true'`。
  - `tsc --noEmit` 通过；ESLint 通过。全量回归见 [汇总报告](2026-09-25-supabase-post-launch-execution-summary.md)。
- **真实操作与课程/任务/会话 ID：** 无。
- **权限与持久化检查：** 默认（未设置）行为与修改前完全相同，不会因本项改动开始信任转发头。
- **回退方式及是否验证：** 还原上述 4 个文件并删除新增的 2 个文件即可。未单独演练回退（纯代码，无数据变化）。
- **结论：** 通过。
- **剩余事项：** 生产环境是否设 `TRUST_PROXY_HEADERS=1`，要等 D0 现场确认 Web 只绑定 `127.0.0.1` 且反向代理会覆盖转发头；生产覆盖文件目前默认 `0`。
