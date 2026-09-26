# Supabase 上线后优化：第二轮执行汇总（2026-09-26）

依据：[后置优化实施清单](../plans/2026-09-23-supabase-post-launch-improvements.md) 与[第一轮汇总](2026-09-25-supabase-post-launch-execution-summary.md)。本轮用户输入（2026-09-26）：把“托管鉴权每请求销毁连接”作为下一项修复；允许下载 Playwright Chromium；D0 提供服务器 SSH、域名 DNS 现状、东京 Auth Site URL/回调修改授权、测试账号 `lzg0724aaa@163.com`；P1-1 延迟目标按行业惯例由执行者制定；P2-1 仅有现有 3 个账号、每账号费用上限 ¥15；P3-2 费用上限 ¥50、判定标准由执行者制定；本地通过后部署到服务器。东京写入、生产服务器操作、付费模型与真实邮件在本会话内预授权。未提交 git。

## 环境

- 本机：Windows 11 + Docker Desktop；测试用 Node v24.18.1。
- 生产：雨云东京 `154.36.184.44`（Debian 12，4 vCPU / 7.8 GiB / 40 GB），宝塔 Nginx 反代 `https://zhiyulearn.online` → `127.0.0.1:3000`；Docker 29.8.1 / Compose 5.5.1；`/opt/zhiyu`。
- 东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`）；未连接已删除的新加坡项目。
- 当前生产镜像：`zhiyu-supabase-web:release-20260926c`（`993573537d83`）、`zhiyu-supabase-worker:release-20260926c`（`86aed857f4f4`）；服务器保留 `release-20260926`、`release-20260926b` 可回退。Tier 4 / Background / 2 worker / 接收任务；请求计时关闭；readiness `ready=true`。
- 本机栈已停止（容器保留），避免与生产同时运行两组 worker。

## 各工作项结论

| 工作项 | 结论 | 报告 |
| --- | --- | --- |
| P1-1 托管鉴权重连修复 + 东京服务器基线 | 通过 | [p1-1 修复](2026-09-26-p1-1-hosted-auth-reconnect-fix-and-tokyo-server-baseline.md) |
| Playwright Chromium 与布局测试 | 通过（2 个布局测试恢复，另 53 项浏览器测试不再跳过） | 本文“测试” |
| D0 东京生产部署 | 受外部条件限制（部署、HTTPS、Auth、重建读回、生成、流式已通过；测试账号登录/邮件点击/另一设备/他人越权需用户本人） | [d0](2026-09-26-d0-tokyo-production-deployment.md) |
| P3-2 教学图片细节 | 未通过（图片模型基线 2/30 → 原生元素绘制后 6/10；钟面、拿走一块、交互页等分仍错） | [p3-2](2026-09-26-p3-2-teaching-image-accuracy.md) |
| P2-1 容量 | 未开工真实负载：需多个账号同时在线提交任务，执行者不能在生产域名代输密码 | 本文“需要用户配合” |
| P1-3 / P2-2 / P2-3 | 本轮未推进（P1-3 的服务器中转数据已在 P1-1 报告中给出，可作排序依据） | — |

## 关键结果

1. **连接销毁已修复（P1-1）：** 托管模式不再调用东京不存在的 `app_internal.ensure_account` 和 RLS 下恒为 0 行的 `loadAccount`；撤销仍由每请求 `session_is_active` 保证。真实 PostgreSQL：修复前 20 次请求销毁 20 条连接，修复后 0 条。生产启动后约 800 个已登录请求，Postgres `ensure_account` 错误 0 条（修复前一日 967 条）。
2. **东京服务器读取全部达标：** 服务器处理 P95——文档 157–189 ms、stage-meta 76–83 ms、图片/音频 433/328 ms、学伴/聊天单请求 197/334 ms；池等待最大 64 ms。大陆浏览器端媒体与多请求历史仍受跨境链路影响（图片 P95 12.5 s），属 P1-3 范畴。
3. **正式上线：** `https://zhiyulearn.online`（HTTPS、www 与 http 跳转、SSE 不缓冲），Tokyo Auth Site URL/回调已改；容器重建读回一致；后台生成一门带配音课 2 分 23 秒（本机 14.7 分钟）。
4. **教学图片（P3-2）：** 图片模型对精确教学图基线 2/30；改为原生元素后 6/10（有配方的全部正确），钟面、“拿走一块”、交互页等分仍错，结论未通过。
5. **新发现：** 后台任务的 TTS 用量不写 `usage_events`（前台会写），已单独建议为独立任务，未在本轮修改。

## 测试命令与结果

- 全量：`node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=15000`（Node 24.18.1，Playwright Chromium 1208 已安装）——836 个文件，**8,544 通过、0 失败、79 跳过**。上一轮失败的 `guided-mode-toggle`、`classroom-complete-title` 两个布局测试通过；`cover-card-layout.browser` 53 项此前跳过、现在运行并通过（单独运行 3 个文件 57/57）。该次全量在 P3-2 数轴细化之前运行；细化只改提示模板与 2 个快照，之后重跑了生成包测试与根目录 `tests/generation`、`tests/prompts`。
- 真实 PostgreSQL（一次性 `postgres:16`）：`tests/auth/hosted-principal-registry.pg.test.ts` 5/5；`tests/server/hosted-capacity-rls.pg.test.ts` 16/16。
- 生成包 `packages/@openmaic/generation`：136/137，唯一失败 `test/assets.test.ts` 在未改模板时同样失败（Windows 路径分隔符，既有问题）。
- `tsc --noEmit`、ESLint、Prettier（本轮改动的 TS 文件）通过。
- 下载：Playwright `chromium-1208`、`chromium_headless_shell-1208`、`ffmpeg-1011`、`winldd-1007`，来源 `cdn.playwright.dev`（官方），安装在 `C:\Users\Lenovo\AppData\Local\ms-playwright`。

## 本轮改动清单（未提交，供确认；第一轮清单见上一份汇总）

**修改**
- `lib/auth/session.ts`：托管模式跳过 classroom 注册表调用（P1-1 修复）。
- `tests/persistence/request-auth-reuse.test.ts`：+2 项。
- `scripts/test-hosted-capacity.ps1`：临时库清单加入新 PG 测试。
- `packages/@openmaic/generation/snippets/image-instructions.md`、`packages/@openmaic/generation/templates/slide-content/system.md`：P3-2 提示模板。
- `packages/@openmaic/generation/test/__snapshots__/outline-prompt.test.ts.snap`、`scene-prompt-golden.test.ts.snap`：随模板更新。

**新增**
- `tests/auth/hosted-principal-registry.pg.test.ts`
- 报告：`docs/reports/2026-09-26-p1-1-hosted-auth-reconnect-fix-and-tokyo-server-baseline.md`、`2026-09-26-d0-tokyo-production-deployment.md`、`2026-09-26-p3-2-teaching-image-accuracy.md`、本汇总。

**仓库外（服务器/平台/本机）**
- 服务器：Docker CE、certbot、`/opt/zhiyu`、Nginx 站点文件、证书与续期钩子、3 套发布镜像、`/root/p32-out`、`/root/p32-image-eval.mjs`、`/root/p11-requesttiming.log`、root `authorized_keys` 中的部署公钥。
- 东京 Supabase：Auth Site URL 与 2 条回调；新增 2 门测试课程、1 次聊天记录、1 封重置邮件。
- 本机：`~/.ssh/zhiyu_tokyo_ed25519`，镜像 `*:release-20260926{,b,c}`，Playwright 浏览器；本机栈已停止。

## 需要用户配合/决定

- **D0 收尾：** 用测试账号 `lzg0724aaa@163.com` 在正式域名登录/登出；点开 163 邮箱里的重置邮件确认跳到 `https://zhiyulearn.online/auth/confirm`（可不真的改密码）；换一台设备读回管理员或测试账号的课程；用测试账号访问管理员课程链接应被拒。
- **P2-1：** 需要 3 个账号**同时**在线提交后台课程（每人 2 门，Tier 4 全站上限 4，第 5、6 门应排队）。执行者只能在本地开发地址代输密码，生产需要用户分别在 3 个浏览器/设备登录，并约定同一时间提交；预算按每账号 ¥15，本轮实测一门小课 < ¥1。仅 3 个 owner 时 Tier 8/16 无法打满，只能验证 Tier 4 的全站/每人上限与真实吞吐。
- **P3-2 下一轮：** 是否继续补钟面、“拿走一块”配方与交互页等分约束（每轮约需 30 分钟构建上传 + 1 门课）。
- **安全：** 建议修改服务器 root 密码与管理员密码（两者都出现在本次对话中）；部署公钥可按需删除。
