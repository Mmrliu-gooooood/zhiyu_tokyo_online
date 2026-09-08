# 智域部署调研与讨论记录

日期：2026-09-07。状态：**历史调研与问答记录；方案已确认，执行请使用独立最终文档**。

本次按 grill-with-docs 进行代码调查和需求讨论，仅更新文档。未修改业务实现、未部署云服务、未修改数据库。[最终执行方案](zhiyu-deployment-execution-plan-2026-09-07.md) 已整理；下文保留各轮历史上下文，早期候选与“待讨论”不代表仍未决。

**最新决定优先于下文历史调研（2026-09-08低成本修订）**：先约5名同学封闭体验，雨云东京运行Web/API、Pro、素材解析与独立Generation Worker并存储持久文件；Supabase Free东京项目承载PostgreSQL和Auth。图文语音为主、视频少量，按容量/出网/并发实测扩容；不固定50人，不要求先购买Pro或自托管数据库。保留正式账号、默认私有/明确发布、跨设备同步、线上空库、真实域名/HTTPS、每日异机备份与一天级恢复目标。Vercel、完整自托管Supabase、MP4及真实支付仍暂缓。以 [ADR-0016](../docs/adr/0016-free-supabase-with-local-files-for-small-trial.md) 和 [当前执行计划](zhiyu-deployment-execution-plan-2026-09-07.md) 为准；下文Pro/全部Storage等结论保留作历史调研，不作为最新启动指令。

## 1. 调研基线与已确定范围

- 工作目录：`D:\ZZGG_Innovation_Project\OpenMAIC-main`。
- 分支 `main`，调查时 HEAD `4d5ad10`；工作区存在大量已有修改和未跟踪文件。本稿依据当前工作区，不仅依据该提交。未来部署须明确包含哪些尚未提交的修改，避免部署旧版本。
- 产品名称依据根目录 `CONTEXT.md`：智域 / ZHIYU，基于 OpenMAIC 构建。
- 用户最初要求含 MP4 的完整功能；随后明确 MP4 暂不上线，其余功能保留。[ADR-0010](../docs/adr/0010-defer-mp4-and-payments-in-private-beta.md) 已更新原 [ADR-0008](../docs/adr/0008-preserve-full-capabilities-in-first-deployment.md)。
- 用户已明确：学生与教师；国内外均有用户，前期优先海外；商业用途；邀请 10–50 人测试（不是已确认的同时在线人数）；正式账号和跨设备同步；基础设施月预算 350 元，不含模型 API。见 [ADR-0009](../docs/adr/0009-require-hosted-accounts-and-cross-device-data.md)。
- 商业意图：平台提供模型、用户购买积分套餐，也支持用户自己的模型 API。内测先发测试积分，真实支付后续上线；积分规则和 BYOK 是否收取基础设施费用尚未确定。
- 用户希望先用 Vercel、考虑 Supabase，后续可能迁至香港服务器；这是待评估意向，并非已经选定的架构。
- 旧 ADR/CONTEXT 中存在未来学习评估功能及“implementation pending”描述；不能把这些文字当成当前已实现或已上线功能。
- 未盘点实际数据库内容或核实云账号套餐；表结构清单代表代码可能保存的数据，不代表现有数据库已创建全部表或已有对应记录。

## 2. 项目用途与技术栈

这是 AI 互动课堂与课程制作应用：从主题、文档或对话生成课程大纲、幻灯片、测验、交互体验和 PBL 内容，并提供 AI 角色授课、语音、白板、讨论、课程编辑及导入导出。Pro 工作台加入持续对话、技能调用、素材处理和课程编辑工具。

| 层次 | 代码所见 |
| --- | --- |
| Web 与服务端 API | Next.js 16.1.2 App Router、React 19.2.3、TypeScript；API 与网页同仓库 |
| UI 与客户端状态 | Tailwind CSS 4、Radix/shadcn 相关组件、Zustand；Dexie/IndexedDB 与浏览器 KV 存储 |
| AI 与智能体 | AI SDK 6、多个模型供应商适配器、Pi agent 相关包，以及 LangGraph 依赖；不同功能链路各自调用，不宜概括为单一智能体框架 |
| 工作区包 | pnpm workspace，`@openmaic/dsl`、generation、storage、importer、renderer、editor 等 |
| 数据库 | PostgreSQL，通过 `pg` 和手写 SQL/JSONB 存储；不是必须换 ORM 才能连接 Supabase |
| 文件 | 浏览器 Blob、PostgreSQL BYTEA、已有可选 S3 资产后端，以及尚未统一的服务器 `data/` 文件 |
| 后台运行 | Pro Agent Runner、素材解析 Runner、独立 Generation Worker、资产清理定时器 |
| 视频导出 | 独立 Node 22 + Hono + Hyperframes Producer + Chromium + FFmpeg 服务 |
| 部署基础 | `.nvmrc` 为 22，Docker 基础镜像 Node 22，pnpm 10.28.0；`vercel.json` 和 Docker Compose 均已有 |

证据入口：`package.json`、`next.config.ts`、`instrumentation.ts`、`workers/generation/main.ts`、`render-service/package.json`。

## 3. 数据分别存在哪里

| 数据 | 当前实现/表 | 部署含义 |
| --- | --- | --- |
| 课程、场景、大纲、文件夹、修订信号 | `document_stages/scenes/outlines/folders`、`document_stage_revision`、`document_scene_revision`、`stage_meta` | PostgreSQL 可独立部署；存在所有权和兼容访问规则，需审查课程可见性 |
| 学习运行记录 | `runtime_sessions`、`runtime_records` | 含 learner_key 与 JSON 数据；仅连接云数据库不等于拥有账号与跨设备同步 |
| Pro 对话及执行记录 | `agent_sessions`、`agent_session_entries/events`、owner 事件与 URL 表 | 保存会话、事件、恢复状态等，供 Runner 和 SSE 使用 |
| 上传素材元数据、解析状态与技能 | `agent_session_materials`、`owner_material`、`agent_user_skill` | 元数据入库不代表原始文件已入对象存储 |
| 注册资产 | `asset_entries`、`asset_blobs` | 默认可存 BYTEA；`ASSET_S3_BUCKET` 只切换此资产层的字节存储 |
| 持久化课程生成 | `generation_jobs/ownership/scenes/steps/attempts/job_assets/events/commands/provider_slots/worker_heartbeats` | PostgreSQL 同时承担作业队列、租约、事件和限流协调；已存在实现，未发现本链路必须依赖 Redis |
| 用户模型配置 | `pro_model_connections`、`pro_model_connection_revisions`、`media_config_snapshots` | 加密保存模型及媒体连接配置，须保留加密密钥并保护所有权 |
| Pro 素材原文件、解析文本 | `lib/server/materials/bytes.ts` | `getMaterialByteStore()` 当前固定使用 `LocalMaterialByteStore`，文件落到 `data/` |
| 部分课程及生成媒体 | `classroom-storage.ts`、`classroom-media-bytes.ts`、image/video/TTS 写入路径 | 部分仍写 `data/classrooms`，仅更换 DATABASE_URL 无法迁移它们 |
| 用量记录 | `lib/server/usage-storage.ts` | 月度 JSONL 写入 `data/usage`，部署至无持久磁盘的函数时需替代 |
| 浏览器状态和历史数据 | `lib/utils/database.ts`、`lib/store/kv-persist.ts`、`lib/runtime/config.ts` | 含本地课程兼容数据、音视频、快照、播放位置、角色/音色、偏好等；需要逐项决定哪些同步，哪些只作缓存 |

注意：浏览器存储按站点 Origin 隔离。由 localhost、vercel.app 切换至独立域名时，现有浏览器数据不会自行搬家。数据库备份也不包含所有本地文件、对象存储对象和浏览器历史。

## 4. 主要工作流程

1. 普通课程：浏览器接收主题/材料，请求生成大纲，再通过 scene-content、scene-actions、TTS/媒体接口分步骤生成；由客户端现有存储抽象保存并进入课堂。每个 API 有自己的时限，不能把整门课时长直接等同于一次函数时长。
2. Pro：创建持久会话/提交消息，Node 进程中的 Agent Runner 领取任务，调用技能、素材、模型和课程工具，保存会话事件与课程；页面通过 SSE 与补偿轮询获取更新。素材解析另有 Runner。
3. 后台整课生成：`POST /api/generate-classroom` 校验并保存任务，返回 202；独立 Worker 执行材料准备、大纲、角色、场景、动作、媒体和 TTS，保存步骤、事件与心跳。开关与迁移就绪状态决定是否启用。
4. 学习与编辑：读取课程/场景/媒体，驱动角色讲解、白板和讨论，保存相应运行记录。需要逐条确认启用云持久化后仍保留在浏览器的数据范围。
5. MP4：浏览器把课堂编译为自包含 ZIP，经导出接口提交渲染服务，查询进度后下载 MP4。`render-service/README.md` 明确渲染可能持续数十分钟。

## 5. 分开部署判断

**应用与 PostgreSQL 适合分开部署。** 项目已经通过 DATABASE_URL 连接数据库，核心存储实现与同机路径没有强绑定。Supabase 可作为托管 PostgreSQL 使用；不必把现有 SQL 全部改成 Supabase Data API。

但完整应用还需要处理进程生命周期、文件和认证，因此“换数据库地址”与“完整支持 Vercel”是两个不同工作量。

| 候选架构 | 评价（尚未决定） |
| --- | --- |
| Vercel Next.js + Supabase 数据库，两项服务 | 不满足当前全部功能范围，缺少已确认需要的常驻执行和渲染环境 |
| Vercel Web/API + 独立后台/渲染主机 + Supabase + 对象存储 | 可设计实现，但必须拆分 Runner 生命周期、统一文件访问、大文件传输、鉴权及 SSE；比普通一键部署复杂 |
| 香港服务器部署 Next.js、后台进程与独立渲染容器，数据库托管 Supabase | 结构更贴合现有 Docker/常驻架构；有条件成为完整功能最快上线方案，取决于预算和用户网络实测 |
| 香港服务器同时部署 PostgreSQL | 可行，内网延迟低；需自行承担数据库备份、恢复、升级、资源竞争及整机故障恢复 |

数据库分离不要求 Web 和 Worker 再互相拆成多个公网微服务。可以先让 Web 和后台在同一主机运行，PostgreSQL 托管，后续按瓶颈拆分。

## 6. Vercel 混合部署必须解决的代码点

- **进程拆分**：`instrumentation.ts` 当前启动 Agent Runner、素材解析、通知监听和资产清理。需要分离“允许调用 Pro API”和“在此进程执行 Runner”的开关，并新增独立启动/停止/健康检查入口；现有 generation-worker 不等于这两个 Runner。
- **通知连接**：`event-notify-bus.ts` 用专用 `pg.Client` 执行 LISTEN，却仍读取 DATABASE_URL。设计独立通知连接变量；普通短请求用事务池，LISTEN 用直连或 session 模式。Vercel 侧 SSE 须具备断线续接/轮询兜底，不能靠永不退出的监听器保证可靠性。
- **文件统一**：替换固定本地 MaterialByteStore、课程媒体和用量日志；梳理所有直接 fs 写入和读取者。临时文件可用于一次任务处理，不能作为持久化或跨主机共享方案。
- **对象存储**：已有 S3 资产实现使用 `new S3Client({})`。接 Supabase S3 应显式支持 endpoint、region、`forcePathStyle: true`；不能把设置一个 bucket 变量当作已经覆盖所有文件。
- **大文件**：素材、PPTX、录音、导出 ZIP 和媒体下载须逐条审查。Vercel 当前普通函数请求/响应 payload 限制为 4.5 MB；优先规划授权后直传对象存储、提交引用和签名下载，或受保护的独立上传网关。流式读取 req.body 不应被视为绕过平台上传限制。
- **渲染隔离**：保留 Chromium 出网隔离。当前 Docker render 网络为隔离网络，外置对象存储的取件/上传应由可信网关或侧车处理，不能未经设计直接开放渲染容器公网出站。
- **认证**：普通 persistence 使用开发共享 token 与客户端 learner key；Pro 使用签名设备身份。公开多用户上线需要统一服务端身份和课程/素材/会话/记录的权限；ACCESS_CODE 不等于用户账号系统。
- **SQL 与权限**：应用层的 owner 检查、表权限、RLS、角色是不同层。不能给 pg 连接加上 RLS 后就假定它自动拥有 Supabase Auth 的 `auth.uid()`。后台角色、普通请求角色和迁移角色需明确分工。
- **迁移**：现有 `workers/generation/migrate.ts` 已覆盖基础持久化与 generation 迁移，但未显式包含所有 Agent/素材/技能/模型连接建表逻辑；需整合版本化部署迁移，再减少运行时 DDL。
- **连接池**：共享 persistence pool 与 generation pool 当前独立存在，后者 max=8；Vercel 实例增长会放大总连接数，需统一或分别明确池大小与连接预算。
- **构建**：沿用根目录 pnpm workspace 构建；保留 prompts/skills/导入 Worker 的 tracing。`next.config.ts` 已按 VERCEL 切换 standalone，无需无依据重写。核验 Linux 构建、依赖体积及逐路由 maxDuration。
- **密钥**：保留 GENERATION_SESSION_SECRET、PRO_MODEL_ENCRYPTION_KEY 和实际使用的 MEDIA_CONFIG_ENCRYPTION_KEY；不得把值写进交接文档。owner 变化会影响加密 AAD，账号迁移不能只 UPDATE owner_id，必须设计受控解密再加密。

## 7. 已核对的平台事实

- [Supabase 连接方式](https://supabase.com/docs/guides/database/connecting-to-postgres)：事务池适合短连接/serverless；长期连接优先直连，IPv4-only 环境可用 session pooler。所有地址从项目 Connect 面板复制，不能猜区域主机名。
- [Vercel 函数限制](https://vercel.com/docs/functions/limitations)：Fluid Compute 下 Hobby 默认及最大 300 秒；Pro/Enterprise 通常可到 800 秒，当前另有条件性 extended beta。项目已有 300 秒配置不代表支持任意长任务；普通 payload 上限 4.5 MB。
- [Vercel 后台 API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)：waitUntil 仍受同一函数时限约束，不是把常驻 Runner 原样搬过去的解决方案。
- [Supabase S3 认证](https://supabase.com/docs/guides/storage/s3/authentication)：AWS SDK 支持路径式访问；服务端 S3 凭据与浏览器 publishable key 是不同用途。
- [Supabase S3 兼容性](https://supabase.com/docs/guides/storage/s3/compatibility)：Object Lifecycle 当前不支持，孤立对象清理应明确由可信后台定时对账执行；不能套用 AWS lifecycle 配置。
- [Supabase API 防护](https://supabase.com/docs/guides/api/securing-your-api)：审核 Data API 暴露、授权和 RLS，不把平台默认设置当成应用授权。
- [Data API 变更](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)：新表自动暴露默认行为正在变化；执行时核验项目实际配置。
- [Supabase Node 20 支持变更](https://supabase.com/changelog/45715-deprecation-notice-dropping-support-for-node-js-20)：如引入当前 Supabase SDK，沿用项目 Node 22 基线。
- [Vercel Hobby](https://vercel.com/docs/plans/hobby)：仅面向个人非商业使用，套餐选择需要先明确用途。

平台资料按调研日读取，真正执行前重新确认变更。未对任何云套餐进行付款或资源创建。

## 8. MP4 对机器规格的实际影响

`render-service/src/resource-profile.ts` 设置启动检查：standard 至少 8 GiB，low-memory 至少 4 GiB；并限制单个渲染执行槽。这里是渲染进程可见的最低内存门槛，不是整套系统并发使用的容量保证。服务器还要容纳 Web、Agent、素材处理、操作系统以及可能同机的数据库。必须在预算明确后给出规格和压测目标，不能直接推荐 1–2 GB 小机承载全部功能。

## 9. Team 命名建议（未选定）

- 推荐 Team Name：`ZHIYU Lab`；Team URL slug：`zhiyu-lab`。
- 备选：`ZHIYU Learning` / `zhiyu-learning`，或 `ZHIYU Studio` / `zhiyu-studio`。
- 若占用，使用 `zhiyu-learning-lab` 或加入用户认可的团队标识；未验证可用性，也未注册。
- Team slug 是团队管理路径标识；项目名称与实际站点域名另行设置。[团队说明](https://vercel.com/docs/accounts)、[项目域名](https://vercel.com/docs/domains/working-with-domains)。
- 建议考虑独立应用域名，以便后续迁香港时保持用户入口和 Origin；数据库与对象存储可暂时保持原服务，降低一次迁移同时变动的范围。

## 10. 待讨论与最终文档交付范围

第一轮 Q1–Q4 已全部回答，结果见第 1 节。第二轮已发出，等待用户答复：

- Q5：Vercel 是否硬性要求；如果坚持，是否接受免费数据库限制或提高预算。
- Q6：首次邀请测试是否真实收款，还是先发放测试积分、验证账本和扣减。
- Q7：海外首批主要区域（亚太/北美/欧洲）。
- Q8：默认私有并主动发布、指定学生/班级分享，或课程共享模式。
- Q9：线上空库开始，还是迁移部分/全部本地历史数据。

后续根据答案继续明确：具体后台环境与数据库区域、登录方式、师生是否只是用户画像或需要不同权限、文件大小与视频时长、任务并发与排队、数据保存期限与可接受丢失/恢复时间、域名与交付版本，以及积分预占/结算/退款和 BYOK 规则。独立问题成组讨论，依赖答案的问题延后。

最终 Markdown 应包含：已确认决策、架构与数据流、逐文件代码修改任务、数据库迁移与权限、Supabase Database/Auth/Storage 的实际使用边界及配置步骤、Vercel Git/项目/构建/环境配置、后台及渲染服务部署、密钥填写位置、域名与 TLS、备份恢复、旧数据归属迁移、限额与监控、验收案例、失败回滚、后续香港迁移步骤，以及新对话 AI 的执行顺序和停止条件。

验收至少覆盖：正式用户隔离、所有课程类型与 Pro 工具、素材解析、大于 4.5 MB 的真实文件路径、音视频生成、后台重启/中断恢复、SSE 重连、媒体读取及数据库+文件+加密密钥的恢复演练。MP4 本期验收改为入口与 API 能力正确关闭且不影响其他导出。构建成功不等于这些路径全部可用。

## 11. 第一轮答复后的预算与范围更新

[Vercel Pro](https://vercel.com/pricing) 基础订阅 20 美元/月；[Supabase Pro](https://supabase.com/pricing) 从 25 美元/月起，首个 Micro 实例在所含计算额度内。两项合计 45 美元，按仅用于预算的假设汇率 1 美元=7 元约 315 元；这不是实时汇率或含税报价，尚不包含额外运行主机、对象存储超量、流量、邮件等。

因此暂不推荐在 350 元预算内直接锁定“两项 Pro + 另购完整后台/渲染机器”。候选方向是优先给持续运行与渲染留足预算，减少重复托管；若 Vercel 是硬要求，应另行评估免费数据库限制或预算调整，而不是删减已确认的功能。

Supabase Free 当前列出 500 MB 数据库、1 GB 对象存储、单文件最大 50 MB、无自动备份、闲置一周可暂停。小规模测试是否接受这些限制需明确，不能把 10–50 位用户直接等同于免费容量足够，尤其课程含音视频。

真实用户账号、跨设备数据与积分系统均不能靠部署配置自动补齐。代码关键词与表结构调查尚未发现完整充值订单、支付回调、积分账户和不可重复扣费账本；现有用量 JSONL 仅是证据入口之一，不能作为财务记账系统。最终修改方案需要纳入这部分新业务，或记录用户明确接受的阶段划分。

课程生成和 AI 编辑可能引发多个子调用。积分设计应讨论统一计量入口、预占/结算、失败退款、幂等和并发扣减；用户自带 API 仍会产生文件存储、解析和渲染成本，因此 BYOK 收费边界不能自动假定为全部免费。这里是待讨论事项，不是已决定的收费规则。

## 12. 第二轮及后续修正：当前有效边界

- Q5 最初回答必须 Vercel、可以加预算，随后明确采纳优先评估常驻服务器 + 托管数据库；第三轮又询问 Vercel 可用性。已解释 Vercel 可做 Web/API，但仍要持续后台。最终 Web 托管方式待明确，不能替用户直接锁定。
- Q6：先发测试积分，真实支付后续上线。
- Q7：亚太用户为主。
- Q8：默认私有，只有主动发布的课程共享。
- Q9：线上空库开始，所有本地数据保留，不执行本地历史归属迁移。
- 额外修正：MP4 当前用不上，本期不部署，不删除实现。
- Q10：用户倾向香港云服务器，可提高预算，最终提供商/规格/上限未定。
- Q11：邮箱+密码、验证邮箱、邀请限制。

当前建议（待最终定案）：香港常驻 Linux 服务器运行现有 Docker 应用、内嵌 Agent/素材 Runner 和按需启用的 generation-worker；Supabase 托管 PostgreSQL 和账号。若 Web 同机，则无需为 Vercel 抽离 Runner 或把所有文件立即改成跨主机对象存储；文件方案仍需明确持续磁盘、云对象存储及恢复边界。

此前用于比较的新加坡 [AWS Lightsail 定价](https://aws.amazon.com/lightsail/pricing/) 公开 IPv4 Linux 档位：2 GB/2 vCPU 为 12 美元/月，4 GB/2 vCPU 为 24 美元/月；加 Supabase Pro 25 美元，分别合计 37/49 美元。以预算假设汇率 7 约 259/343 元，不含税、备份、域名与额外用量。**这不是香港服务器报价**，不能移用为香港采购承诺；香港提供商与续费价需另查。

第三轮 Q12–Q15 已答：只扣实际平台 API 调用积分，BYOK 调用不扣模型积分；教师学生统一个人权限，发布课程链接可浏览；每人一个/全站两个重任务、单文件 50 MB、每人总文件 1 GB；暂无域名和云服务器账号，Supabase 可以创建项目。见 [ADR-0011](../docs/adr/0011-isolate-published-learning-and-meter-platform-calls.md)。Supabase Pro 与邮件服务仍是建议，尚未代表用户购买授权或已创建资源。

登录邮件必须配置实际可给受邀用户发信的 SMTP；[Supabase 默认 SMTP](https://supabase.com/docs/guides/auth/auth-smtp) 只给组织成员地址发信，不能当作给 10–50 位测试用户的正式通道。[Resend Free](https://resend.com/pricing) 当前有每月 3000、每日 100 封额度，可作为小规模验证候选，需用户域名验证与实际投递验收。

## 13. 当前最后一轮讨论入口

- Q16 已确认：香港服务器同时运行 Web 与后台，Supabase 托管数据和账号。
- Q17 已确认：文字采用 DeepSeek、Qwen 等；其他媒体服务商按现有代码目录整理，不局限 OpenAI。具体上线模型与凭据在执行阶段填写，不应把目录支持当成已购买/已启用。当前本地 .env 中 DEFAULT_MODEL 为空，没有读取或输出任何 API 密钥值。
- Q18 已确认：全部持久文件统一 Supabase Storage。
- Q19 已确认：每日备份，最多恢复到前一天状态，争取一天内恢复服务，必须演练。

补充代码证据：虽然 MP4 渲染服务暂缓，`lib/server/agent-runtime/voice-clone-tools.ts` 的音频裁切和 `lib/document/extractors/local-media.ts` 仍需要 ffmpeg/ffprobe。当前主应用 Docker runner 的 apk 安装项没有 ffmpeg，最终容器方案须补齐这些现有功能的依赖，不能把停用 MP4 理解为完全不需要 FFmpeg。

[腾讯云香港调价公告](https://cloud.tencent.com/announce/detail/2131) 在 2025-09-15 列出 2 核 4 GB、70 GB SSD、30 Mbps 峰值、2 TB 月流量的香港入门型 Linux 刊例价 90 元/月。该公告可用于候选预算，购买前必须复核实际套餐、库存、续费与线路；本次价格总览页面抓取超时，不能把公告当成已经核实的当日成交价格。加 Supabase Pro，按上述估算汇率基础约 265 元，有机会为域名、备份和余量留出原 350 元预算空间。

[OpenAI 官方 API 支持地区](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories) 和 [Anthropic 支持地区](https://www.anthropic.com/supported-countries) 当前未列香港。香港部署能否调用某模型必须按实际 API 服务商、账户和服务区域核验；不能因为使用第三方平台就宣称所有底层服务授权或支持条件自动满足。若供应商不支持该部署区域，选择其支持的服务/区域并在方案中记录影响。
