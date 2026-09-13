# 2026-09-11 普通生成与 Pro 对话故障排查

## 行动计划

1. 读取用户引用任务和完成页验收文档，核查当前代码、容器与日志。
2. 通过子任务分别处理普通生成/取消、模型配置同步、完成页核验。
3. 对确定的缺陷先复现再修复，保留既有头像、角色名称与用户配置。
4. 运行定向回归与类型检查，使用既有发布脚本构建和更新 Web/Worker。
5. 在最终 Docker 上验证真实课程生成、完成页、Pro 对话和取消返回。

## 已确认的代码缺陷

- 普通模式创建任务前失败：无后台 job 的展示投影覆盖了真实错误，页面仍然显示“正在准备”。
- 此时取消按钮错误地要求后台 job ID，无法退出。现在只有在请求尚未提交时停止本地准备、清除该生成会话并返回首页；提交后结果不明仍保留幂等恢复语义。
- 设置异步恢复可能恢复旧模型目录或令加载中的目录请求失效；初始化组件没有在恢复完成后重新同步。现已订阅恢复完成事件并刷新目录。
- 真实 HTTP 复现：向旧 Docker 的 `/api/generate-classroom/model-snapshots` 提交过期平台 revision，返回 `503 GENERATION_UNAVAILABLE`。路由未把模型连接校验异常转为公开错误，掩盖了应返回的版本冲突；客户端也无法据此刷新。修复将保留可识别的错误码，并只在新提交的配置预检阶段刷新同一平台模型并重试一次。
- 刷新后的输入、模型快照以及媒体配置必须一起保持版本一致；已经提交的生成任务继续使用原冻结输入。
- 首次创建任务明确返回 400/401/403/422 后也可取消返回；404/409/5xx、网络结果未知以及旧未知请求的恢复失败仍保留原输入。
- Pro 将会话验证失效、配置版本变化、服务不可用分别呈现为明确提示；不把任意服务响应直接展示给用户。

原用户 Edge 会话未接入本次浏览器工具；截图不包含真实 HTTP 错误码，因此不能仅凭截图将模型错误唯一归因于上述竞态。未清理用户 Cookie、重置用户模型设置或轮换密钥。

## 完成页核验

现有生产布局已经具有基于实际容器高度的 ResizeObserver、760/820px 回差和独立滚动层。本轮没有重新修改完成页生产布局，仅补测试。

覆盖独立课堂、工作台、短容器、键盘滚动、测验结果、1366×768 中文暗色、减少动画、空标题回退与无测验摘要。工作台播放后分隔条已撤下，使用实际 section 高度变化验证 observer；不声称执行过分隔条拖动。

## 部署前真实验证

- 普通模式通过现有平台模型生成“布迪厄：惯习场域资本”，3 页，任务 `52203026-ecb9-4bcf-8e88-6a106cfc546b`，课堂 `fbf92e11-32b3-473b-a557-e081e2edcd18`。后台状态 succeeded，实际进入课堂并查看显示 3 页的课程完成页，然后返回首页。
- Pro 新对话 `1e651404-d3eb-4de4-8541-108a2da4441f` 使用真实 API 返回惯习概念说明，状态已就绪。
- 平台模型 none/high/max 三种思考配置的连接与 runtime 预检全部通过；测试连接已由创建它们的子任务撤销。
- 测试课程关闭图片、视频、TTS、联网搜索以控制验收成本；未声称完成真实媒体生成/语音试听。

## 日志与发布

历史 Worker 日志包含 PostgreSQL 管理员终止连接与退出记录，对应服务重启时段；本轮真实生成期间未观察到相关数据库异常。发布前 Web/Worker healthy，数据库活跃 generation/agent 均为 0。

第一轮修复镜像已发布，revision `worktree-c8e289ef0510-95982eb507d35f43`。迁移、Worker 与 Web 切换全部成功；readiness 四项全部 true。

该镜像真实验收：

- 普通任务 `ef747e53-e330-4229-afeb-843dab484602` succeeded，课堂 `c2f0bbe3-32a5-4026-8bde-f5aa39ddb836`《布迪厄三大核心概念》3 页，完成页实际显示 3 页。
- Pro 对话 `f8393d12-861d-48d7-b425-0c9c203bdaad` succeeded，真实回答场域概念。
- 取消任务 `2bfab627-4329-471c-b828-e7a4f522747f` 最终 cancelled，UI 返回首页；同时发现 Worker 日志将停止误分类为 unexpected。内部 abort 原因只有 Error.message，没有诊断器所读取的 code；已补充结构化 code，并通过实际 runWorker 的租约丢失、关闭超时和数据库不可用三条路径测试；不修改取消执行逻辑。最终镜像上继续验证。
- 相同旧 revision HTTP 预检由部署前 503 变为正确 409 / PRO_MODEL_CONNECTION_STALE。
- 新镜像 Docker E2E 4/4 通过，包含真实页面上的预检拒绝→取消返回及完成页 3 项。
- Web 日志未发现 WARN/ERROR；Worker 的真实课程生成成功，取消误分类单列处理，不能把这条日志称为完全正常。

旧镜像回退标签：`zhiyu:before-generation-repair-20260911` 与 `zhiyu-worker:before-generation-repair-20260911`。沿用原数据卷、模型配置与密钥。

## 自动检查

- 汇总定向 Vitest：22 文件，333 项通过（日志 `.scratch/20260911-generation-repair-tests-final.log` 、`.scratch/20260911-generation-repair-http-tests.log` 与 `.scratch/20260911-generation-repair-worker-tests.log`）。包括设置加载、模型版本刷新、真实 HTTP 错误边界、课程输入与快照一致性、取消与未知结果恢复、完成页统计、角色选择、语音配置和提示词。
- TypeScript `--noEmit --incremental false` 通过。
- 本轮修改文件 Prettier 检查和 ESLint 通过，`git diff --check` 通过。
- 第一轮部署后 Docker E2E 4/4 通过（`.scratch/20260911-generation-repair-e2e.log`）。

## 本轮生产代码范围

`GenerationSessionController.tsx`、`zhiyu-generation-state.ts`、`server-providers-init.tsx`、`model-snapshots/route.ts`、`model-snapshot-client.ts`、`session-input.ts`、`model-config.ts`、`pro-model-connection-client.ts`、`workbench.ts`、`workers/generation/runner.ts`。完成页、头像和六个角色名称的既有修改保留，本轮未重新设计或替换。


## 最终功能验收记录（日志补丁发布前）

revision `worktree-c8e289ef0510-2394990c8ced9fb6`，Web/Worker 同版本，四项 readiness 全部 true。

- 真实普通任务 `2ab9903f-d7b7-4ee2-b40d-d6ae62d72b58` succeeded，课堂 `7320011f-6a68-46c8-b99a-ce71a177f18e`。3 页《布迪厄的惯习概念》，完成页异步统计稳定后显示 3 页，截图 `.scratch/20260911-generation-repair-evidence/completion-final.png`。
- Pro 新对话 `b050da3f-3d9e-434d-80ba-3915605cf978` 已就绪，真实回答文化资本概念，截图 `.scratch/20260911-generation-repair-evidence/pro-final.png`。
- 运行中取消任务 `377e67d5-cb73-4de6-be58-f4272cdf781f`，数据库 cancelled，UI 返回 Home。日志仍出现 unexpected：下游 execute 将内部 abort reason 包装成了普通异常，需要在 Worker 自有信号已 aborted 时取结构化 signal.reason。已修复该诊断路径；包装异常三条回归先红后绿，同时覆盖未 abort 时保留 EXTERNAL_RESULT_UNKNOWN 原分类。Worker/流水线 51 项通过，类型检查通过。
- 相同旧 revision 预检为 409 / PRO_MODEL_CONNECTION_STALE。
- Docker E2E 再次 4/4 通过，日志 `.scratch/20260911-generation-repair-e2e-final.log`。


## 最终发布与关闭验收

最终 revision：`worktree-c8e289ef0510-d0e349be5c8ec12e`。

- Web：`sha256:fbc75ec581ddedc026e3921a2011be2e6417ec0b61921caba2349edec4930307`。
- Worker：`sha256:6522db9cb9f2b59a37704457765c09f078637a43f49746ddd6ea5c7b87d539b9`。
- 两容器及 PostgreSQL 均 healthy；database/schema/worker/accepting 均 true。
- 最终真实取消任务 `f25087ed-7de2-4554-94e8-951f1867ded6`，数据库 cancelled，UI 返回首页。Worker 正确记录 `category=lease_lost`、`code=GENERATION_LEASE_LOST`，不再误报 unexpected。
- 发布后观测窗口内 Web WARN/ERROR 为 0，Worker 未出现数据库不可用或领取异常，活跃 generation/Pro 任务均为 0。
- 最终日志：`.scratch/20260911-generation-repair-worker-release.log`；部署记录：`.scratch/20260911-generation-repair-final-deploy.log`。
- 本轮未生成真实图片、视频、语音或运行真实联网搜索；未把这些能力写成已完成的验收项目。
- 原浏览器需要 Ctrl+F5 加载新版页面；无需删除 Cookie 或清空模型设置。

最终发布后 Docker E2E 4/4 通过（19.9 秒），日志：.scratch/20260911-generation-repair-e2e-release.log。完成页在最终容器重载后再次核对标题与 3 页统计，截图：.scratch/20260911-generation-repair-evidence/completion-release.png。浏览器验收结束已恢复原视口设置。
