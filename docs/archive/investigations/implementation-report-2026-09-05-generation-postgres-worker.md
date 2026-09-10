# PostgreSQL 课程生成 Worker 实施与验证记录

后续部署更新：用户随后要求更新并清理 Docker，最新兼容应用已部署为 `zhiyu:latest` / `zhiyu`，端口 3000，并发生效为 2；旧应用和测试容器已清理，后台 Worker 仍关闭。当前运行清单见 [Docker 部署与清理记录](docker-current-zhiyu-2026-09-05.md)。下文保留首次代码交付时的验证与部署状态。

依据：`technical-plan-2026-09-05-generation-postgres-worker.md`。本报告记录代码交付与实际验证，不替代原方案的发布验收门槛。

## 交付状态

已通过三个子任务代理分别完成队列仓储、独立 Worker、客户端接入，并完成独立代码审查和修复。现有界面的布局、样式、组件视觉结构和文案保持原样；预览与课堂的改动集中在提交、观察、恢复和事件处理逻辑，没有新增页面或重做 UI。

原应用 `zhiyu` 仍使用原镜像运行。原 PostgreSQL 已恢复并通过连接和健康检查。新数据库迁移仅在隔离恢复副本及测试 schema 验证，尚未在原库执行；`GENERATION_BACKGROUND_ENABLED=0`、`GENERATION_ACCEPTING_JOBS=0`，因此本报告不宣称已经完成 P6 正式切换。

收尾时原应用 `/api/server-providers` 正常响应，运行实例的 `parallelSceneConcurrency` 仍为 0；`.env.local` 中的并发 2 尚未通过重建应用注入当前实例，不能把配置已保存表述成优化已经在线生效。

## 已实现的生成链路

- PostgreSQL 版本化加法迁移、Job/Step/Attempt、课程所有权、审阅状态、租约、事件、Worker 心跳与全局服务商配额。幂等提交返回同一任务，阶段产物与课程增量写入受同一事务和租约栅栏保护。
- 独立 Node Worker 从材料、研究、大纲、审阅、角色、首幕一直执行到末幕。内容并发默认 2、前瞻最多 2 幕；actions 按顺序使用 previousSpeeches；云 TTS 和媒体配额分开管理。
- 模型 300 秒、TTS 120 秒、媒体 600 秒的独立时限，与任务预算及取消信号合并。不支持中止的适配器停止本地等待、拒绝迟到提交，不能保证远端服务商已经停止计费。
- 外部结果未知时暂停并要求明确确认重试；已有成功响应和 checkpoint 可恢复而无需重新付费调用。LLM/TTS 的明确 429 使用持久延迟与冷却，SDK 内部自动重试关闭。
- 可选图片/视频只有提交明确被拒绝或服务商明确报告终态失败时，才写入幂等的 warning 和 skipped checkpoint 并继续完成课程；网络、下载、超时和未知状态不降级为警告。必要的语音与材料处理不会沿用可选媒体的跳过规则。
- 完整输入快照、材料资产归属与固定版本、服务端配置指纹。API 不接收客户端私钥或任意模型地址；任务执行期间服务端配置变化会停止任务，避免恢复时悄悄换模型。
- 签名所有者会话、同源变更校验、私有任务查询、资产归属隔离、普通写入与旧生成 API 门禁。失败、取消和 Worker 离线都不会让后台课程自动改由浏览器生成。
- 浏览器提交后只观察服务端进度；持久大纲审阅、关闭页面后继续、重入恢复、场景逐步可用。既有重试入口复用原任务，已完成场景和成功步骤保留。取消 API 可用，离开页面不等于取消任务。
- 显式迁移 CLI、无 DDL 的 readiness、Worker 心跳健康检查、独立非 root Docker 构建目标、统一 Compose 检查与操作脚本。

## 数据与部署保护

原卷身份保持为 `openmaic-main_openmaic-postgres` 与 `openmaic-main_openmaic-data`，Compose 使用 external 映射；PostgreSQL 保持 16 系列，固定已验证镜像摘要。没有删除原卷或旧容器，没有让两个 PostgreSQL 实例同时使用原卷。

短暂停止原应用取得冷备份后已恢复应用。备份保存在本机受限目录 `.scratch/generation-backup-20260905`，未写入 Git 或 Docker 构建上下文：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| postgres.tar | 49,469,440 | `8EC034DE9576D038B7ED9FEABB3C3692DECD6022DF08BBAFBF713FDB16C9F217` |
| app-data.tar | 30,720 | `F04F6D13F757A2277B135AE5D645F9A4A9D1247D123CD88C0C81C57ADDB92704` |

恢复演练使用独立卷 `openmaic-generation-verify-20260905`；恢复后的 PostgreSQL 为 16.15，集群标识 `7680757326467162150`。当时基线的 stages、scenes、assets、runtime_sessions 关键表均为 0 行，不能把“空表恢复成功”表述成已覆盖真实存量课程迁移。原库重新启动后的连接检查通过，观测窗口内原应用数据库连接错误为 0。

`.env.local` 已持久化原运行配置、数据库连接、独立会话签名和兼容 token、并发 2；文件仍被忽略，报告不包含秘密。Compose 检查已通过，固定项目名、external 卷、Docker 内数据库目标、构建时 public 配置和运行时配置一致；部署脚本拒绝 shell 环境意外覆盖。可选 `server-providers.yml` 同时只读挂载到应用与 Worker。

## 验证结果

| 检查 | 结果与范围 |
| --- | --- |
| 全仓 Vitest（含隔离真实 PG） | 最终代码 680 个文件通过、10 个文件跳过；7353 项通过、45 项跳过；193.39 秒。日志：`.scratch/generation-release-tests.log` |
| TypeScript | 全仓 `tsc --noEmit --pretty false --incremental false` 通过 |
| Next 生产构建 | `next build --webpack` 通过，51 个静态页面生成完成；日志：`.scratch/generation-next-build-release.log` |
| 仓储与故障恢复 | 双领取、所有权、租约栅栏、审阅、失败场景投影、幂等、真实 Worker 强杀后未知结果不重放及已保存响应恢复通过 |
| 外部时限 | 三类调用截止、迟到结果拒绝、后续调用停止、不支持 signal 的适配器取消等待均通过 |
| 代码检查 | 修改文件 ESLint 通过，`git diff --check` 无空白错误 |
| UI 保持 | 三个页面 JSX AST 与 HEAD 对比均通过；仅排除事件绑定，保留比较文本、class/style、节点及顺序。脚本：`.scratch/generation-ui-structure-check.mjs` |
| Docker Worker | 最终镜像构建成功，非 root UID 1001、Node 22.23.2；26 个模板与 16 个 prompt Markdown 资源存在；独立测试库迁移及重跑成功，独立 Worker 启动和 `--check` 心跳检查通过；镜像不含 `.env.local` 或 `.scratch` |
| Compose | external 卷身份、数据库地址、构建/运行配置、签名密钥长度与本机绑定检查通过 |

本机测试使用捆绑的 Node 24，并设置 `NODE_OPTIONS=--no-experimental-global-navigator`、`--maxWorkers=4`，避免该版本 Node 的全局 navigator/locks 与既有浏览器存储测试相互影响；部署镜像使用 Node 22。测试日志中的既有 KaTeX/DOMMatrix/Path2D 提示不影响本轮通过结果。Next 构建仍有既有依赖和 middleware 弃用提示。

最终 Worker 镜像：`zhiyu-generation-worker:20260905`，Docker inspect ID `sha256:18c493241881d52f6de0ce0204a921d7202e878c314867012dc486c638d55b47`，构建日志 `.scratch/generation-worker-docker-release.log`。这不是已部署的 R0 应用镜像。本次临时 Worker 和隔离测试数据库已停止；测试卷与备份保留，原应用及原 PostgreSQL 继续运行。

确定性调度基准使用 6 幕、每幕 content 80ms/actions 20ms 的模拟服务：串行总耗时 600ms、并发 2 为 280ms，减少 53.3%；两者首幕均 100ms。此结果验证调度行为，不代表真实模型调用速度或费用改善。

## 发布前尚需验收的边界

1. 真实 provider 小流量样本、费用/429/首幕与全课时延分布，尚未执行；当前强杀测试使用本地模拟 provider 和真实 PostgreSQL，不产生远端模型费用。
2. 尚未执行真实浏览器完整 E2E、Windows 宿主冷重启与 R0 回滚演练。源码视觉结构核对和回归测试不等于浏览器逐像素截图对比。
3. 首轮后台生成只开放已验证的 PostgreSQL bytes 资产后端；配置 S3 时提交前置拒绝，不能宣称实现了 S3 staged 上传与清理协议。旧资产读取兼容保留。
4. 未部署兼容 R0 应用镜像、未对原库执行新增迁移、未开启后台入口。当前手工镜像 `zhiyu:bugfix-20260905` 缺少新所有权门禁，产生后台课程后不能直接回滚到它提供写服务。
5. 容器 restart 策略不能证明 Windows 登录前 Docker Desktop 已启动，宿主自启仍须实测。

## 后续部署顺序

在上述验收通过后，按原方案顺序切换；不要仅把开关改为 1 就跳过关卡。

1. 使用 `scripts/generation-compose.ps1 check` 核对配置，再使用 `build` 构建兼容应用与 Worker，保存 R0 镜像标识及对应配置。父 shell 不应覆盖 `.env.local` 中声明的变量。
2. 保持接收开关关闭，执行显式 `migrate`；不得使用 `down -v`、卷删除或卷清理。迁移前再次核对备份、原卷和基线数据。
3. 按切换窗口停止占用 3000 的手工 `zhiyu`，再执行 `start-app`。脚本在原应用仍运行时会拒绝启动新应用，避免端口冲突和双写。检查旧课程读取和 R0 门禁。
4. 执行 `start-worker`，核对 readiness 和 Worker 心跳；完成真实小流量、冷启动及回滚演练后，才按原方案开启接收并重新创建应用/Worker。
5. 回滚先关闭接收、等待或明确暂停任务，再回滚到 R0 或更新的兼容镜像；保留原卷、已完成场景和 checkpoint，不降级到缺少门禁的旧写入链路。

原方案保留为历史设计文档，其“尚未实施”文字描述的是该文档编写时状态；本报告是后续实施事实记录。
