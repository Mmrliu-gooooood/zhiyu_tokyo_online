# Supabase 迁移后的后置优化实施清单

更新：2026-09-23（同日按仓库代码复核修订；当晚完成第二次逐条代码核对，修订见第 0.1 节）。状态：待后续执行，本文仅编制方案，没有实施优化、扩容或生产部署。

## 0. 本次按代码复核的修订要点

- **P1-2**：前台完成分“保存文档 → 调完成 API”两步，第二步失败只记 warn 日志、不重试，重开页面也不补调；Pro 智能体建课与 PPTX 导入从不写 `stage_meta.generation_complete`。由“待确认”改为“已定位缺陷”，实际影响主要是前台容量租约最长占用 60 分钟。**已决定**：`stage_meta.generation_complete` 不作为权威字段，完成状态以文档大纲 `generationComplete` 为准（见第 5 节第 1 步）。
- **P3-1**：编辑器“已配音”只查浏览器本地 Dexie，课堂播放先查云端资产池。原因已定位，入口文件已更正。
- **P1-3**：前端按 Blob 快照渲染媒体，redirect 模式是 S3 SigV4 预签名，不是 Supabase REST `createSignedUrl`。验证项改为 Supabase S3 兼容性（响应头覆盖、CORS、`NoSuchKey`）。compose 中 `ASSET_BYTE_EGRESS: direct` 是写死的。
- **P1-1**：拆出前置的 P1-0 埋点（新代码）；标出鉴权链路、owner 绑定查询和学伴历史的往返放大点；记录已撤回的认证查询合并尝试及其 RLS 反证。
- **D0**：补充生产配置交付物（现有 compose 写死 localhost origin）、构建期公开参数和 MP4 导出资源限制。
- **P2-1 / P2-3**：补充连接池不随档位变化、tmpfs 占用内存、资产回收当前关闭（仅限 Supabase 栈，hosted 栈见 0.1 节更正）、Advisor 修改须走 accounts 迁移。

### 0.1 二次复核修订（2026-09-23 晚，逐条对照代码）

- **P2-3**：更正“hosted 覆盖资产回收关闭”——`docker-compose.hosted.yml` 只在 Web 服务上设 `ASSET_COLLECTION_ENABLED: 'false'`，其 `generation-worker`（`env_file: !reset []`）未设置该变量，而代码默认开启，即 hosted 栈的 worker 实际会运行资产回收。
- **P1-2**：`/api/stage-meta` 响应不含 producer（其 `source` 字段恒为 `'document'`，仅诊断用、代码注释禁止据其分支），重开补偿的 producer 判据改为取本地文档大纲。补充：完成路由的“标记”与“释放”是两条各自自动提交的语句（无显式事务）；每用户上限代码默认为 1，2 是 Supabase compose 写死值；未开启浏览器持久化时不会发完成请求。
- **P1-3**：更正请求计数——描述信息经同一次字节 GET 的 `Accept` 协商返回，redirect 模式下应用请求数与 direct 相同，多出的是浏览器直连 Storage 的一次跨源请求。Blob URL 由存储包铸造，`use-asset-url.ts` 只做租约管理。默认宽限在 `GENERATION_BACKGROUND_ENABLED=1` 时下限为 24 小时。
- **D0**：`TRUST_PROXY_HEADERS` 两处读取取值不一致（限流认 `'1'`，MP4 导出认 `'true'`），单一取值无法同时启用两者；MP4/ZIP 切换实际由运行时 `/health` 探测决定，profile 未启用只是探测失败的一种情形。
- **P1-1**：`loadAccount` 嵌套在 `ensureAccountRow` 成功路径内部而非平级第 4 步；瞬时错误经 `withRegistryRetry` 最多重试 3 次会放大往返。新增候选：聊天首轮 `runtimeViews` 的每会话读取是无上限 `Promise.all` 全量并发。
- **P1-0**：措辞收窄为“生产代码路径中没有分段计时/池等待统计”（`pg` 池的 `waitingCount` 等计数仅出现在个别测试断言中）。

## 1. 执行范围与顺序

依据：[数据库核心功能验收](../reports/2026-09-23-supabase-database-functional-acceptance.md)、[详细历史证据](../reports/2026-09-21-supabase-storage-capacity-acceptance.md)、[原实施计划](2026-09-20-supabase-storage-and-generation-capacity.md)。用户最新决定优先完成数据库功能并上线，性能、扩展验收和非阻断体验随后处理；原计划中要求完整 T8/T9 全部完成再上线的顺序，以本次决定为准。

当前基线：本机应用使用 Supabase；Tier 4、Background、2 个 worker。普通前台/后台/Pro 各有成功样本；资产完整性、私有桶、账号隔离与核心学习记录已验证。稳定回归为 8457 项通过、70 跳过。**这些结果不证明生产环境、P95 延迟或 16 并发已经通过。**

生产目标（用户提供，尚未 SSH 核实）：雨云东京 4 vCPU / 8 GB / 40 GB，上行 20 Mbps、下行 30 Mbps；Supabase 项目位于新加坡。数据库与 Storage 均为跨地域访问。

| 顺序 | 工作项 | 性质 | 何时执行 |
| --- | --- | --- | --- |
| D0 | 生产环境最小验收 | 部署收尾，尚未完成；需先产出生产配置 | 首次开放用户前 |
| P1-0 | 请求分段计时埋点 | 新增代码，是 P1-1 的前提 | 上线后第一批，先于 P1-1 |
| P1-1 | 远程读取延迟定位与优化 | 已知存在明显等待，代码中已有往返放大嫌疑点 | P1-0 完成后 |
| P1-2 | 前台完成标记与租约释放补偿 | 已定位缺陷，影响以槽位占用为主 | 上线后第一批 |
| P1-3 | 私有媒体间接出口（redirect）验证 | 复用已有能力，先验证 Supabase S3 兼容性 | 以 D0 实测中转带宽定序；原计划 13.2 视其为上线重点 |
| P2-1 | 4→8→16 容量验收 | 扩容前必须完成，不是现有故障 | 提高实际并发前 |
| P2-2 | 完整课堂与学伴矩阵补全 | 补覆盖，不能把未测当故障 | 随相关修改补验；扩容后复验 |
| P2-3 | 运行观测与恢复演练 | 最小保障随上线；完善工作后置 | 上线后持续完善 |
| P3-1 | 编辑器配音标签一致性 | 已定位的状态判断缺陷，实际音频正常 | 最后处理；改动小，可按需提前 |
| P3-2 | 教学图片细节一致性 | 内容质量，不是文件保存故障 | 最后处理 |

每次只推进一项可独立验收的修改。先保存当前工作树和镜像标识，保留未提交文件；先做相关测试，稳定后再统一构建与完整回归。不得为优化关闭生成模式、移除课堂/导出能力或放宽 owner/RLS。发现数据丢失、越权或保存失败，应立即升级为功能故障，不继续按普通优化排期。

以下路径均相对于仓库根目录 `D:/ZZGG_Innovation_Project/OpenMAIC-main`。所有性能目标均为建议的后续验收门槛，尚未达成；执行前固定测量环境与目标，避免结果出来后调整口径。

## 2. D0：部署时的最小验收

本项与后置优化分开安排，不要求先做完本文所有工作才部署。具体部署边界参考原计划第 13 节。

**代码现状：**
- `docker-compose.supabase.yml` 是本机切换栈：`APP_ORIGIN: http://localhost:3000`、`GENERATION_ALLOWED_ORIGINS` 只含 localhost，均为写死值。
- `docker-compose.hosted.yml` 写死 3001，并由 `tests/config/hosted-compose-contract.test.ts` 锁定。
- 仓库中没有生产 compose/覆盖文件，也没有 Linux 启停与分档脚本。`scripts/supabase-compose.ps1` 只适用于本机 PowerShell。
- `NEXT_PUBLIC_*`（Supabase URL、publishable key、功能开关）是构建参数，会写入镜像，需要用生产值构建。`Start` 动作的注释说明，Next.js 构建需要先停服务腾出内存，8 GB 服务器上不宜现场构建。
- `render-service`（MP4 导出）内存上限为 `${RENDER_SERVICE_MEMORY_LIMIT:-8g}`（默认 8g，可覆盖），4 核 / 8 GB 服务器无法与 Web + 2 worker 同时运行。MP4 可用性由运行时对 render-service `/health` 的探测（3 秒超时，`lib/server/render-service.ts`）决定：未启用 `video-export` profile 时探测必然失败，前端隐藏 MP4 按钮、仅保留 ZIP 导出。
- `TRUST_PROXY_HEADERS` 由 `lib/auth/rate-limit.ts` 与 `app/api/export-video/render/route.ts` 读取，但两处取值判断不一致：限流判断 `=== '1'`，导出路由判断 `=== 'true'`，单一取值无法同时启用两者。生产配置前需先统一代码取值语义，或在验收记录中写明按哪个语义设置、哪个读取点因此不生效。

1. 核实实际服务器、可用内存/磁盘、已有服务和网络；确认 Supabase（新加坡）、Storage、模型服务从东京服务器可达，并记录 DNS/TCP/TLS 耗时。
2. **产出生产配置**：新增生产 compose 覆盖文件（不修改受契约测试锁定的现有文件），设置 `APP_ORIGIN=https://zhiyulearn.online`、准确的 `GENERATION_ALLOWED_ORIGINS`，确认代理不可绕过后再设 `TRUST_PROXY_HEADERS`（注意上文两处取值语义不一致：先统一代码语义，或明确本次按哪个取值、哪个读取点不生效）。同时提供等价的 Linux 启停/分档脚本，保持 Tier 4 分档值、`APP_HEAVY_TASK_PER_OWNER_LIMIT=2`、两个 worker 副本与本机一致。
3. 在本机或 CI 用生产公开参数构建并标记 Web/worker 镜像，保存发布镜像、配置版本及回滚镜像。明确本次不启用 `video-export` profile，仅保留 ZIP 导出，并在验收记录中写明。
4. 配置域名、HTTPS 与 Supabase Site URL/回调；复用宝塔 Nginx，Web 只绑定 `127.0.0.1:3000`；验证 SSE 不被缓存/缓冲。
5. 核对 Web/worker 同版本、readiness（`supabase-readiness` 服务的检查逻辑可复用）、持久化后端和私有桶。
6. 在正式域名用专用测试账号验证：登录/登出、注册确认与密码重置链接；上传材料、生成带媒体课程、保存学习记录；另一设备读回，另一账号不能访问。
7. **记录媒体中转基线**：打开一门带图片/音频的课程，记录服务器出站字节与耗时，作为 P1-3 排序依据。
8. 在无活动生成任务的维护窗口重建应用容器，再读回上述内容。`/app/data` 与 `/tmp` 是 tmpfs，重建后必然清空，可以直接证明数据不依赖容器。保留备份、密钥恢复材料与明确的回滚步骤。
9. 留存环境、镜像、时间、测试对象 ID、响应和结果。生产环境出现保存、鉴权或读取失败时，先修该失败再开放流量。

**完成标准：**正式域名下关键用户链路通过，能重建并读回已保存数据；生产配置与脚本已入库；清楚标注容量为初始 Tier 4、未启用 MP4 导出，未声称 16 并发通过。

## 3. P1-0：请求分段计时埋点（P1-1 前置）

**事实：**生产代码路径中没有 Server-Timing、连接池等待统计或请求级分段计时（`pg` 池的 `waitingCount`/`idleCount`/`totalCount` 仅出现在个别测试断言中，运行时不采集）。`app/api/persistence/[...path]/handler.ts` 已生成请求 ID，`lib/server/agent-runtime/with-owner.ts` 已有脱敏的错误分类日志，`lib/logger.ts` 支持 `LOG_FORMAT=json`。P1-1 第 2 步要求的分阶段数据需要先写代码采集，这是一项独立的代码修改。

**入口：**`lib/auth/session.ts`、`lib/db/request-queryable.ts`、`lib/db/pool-registry.ts`、`app/api/persistence/[...path]/handler.ts`、`lib/logger.ts`。

1. 以同一请求 ID 记录：鉴权各阶段（`getClaims`、PostgREST 账号自查、`ensure_account`、`loadAccount`、`session_is_active`）、连接池 checkout 等待、每请求 SQL 次数与总耗时、Storage 首字节与总耗时。
2. 只输出阶段名与毫秒数；不写 cookie、token、连接串、owner 明文或签名 URL。如需浏览器瀑布对照，可选输出只含阶段名的 `Server-Timing` 头。
3. 由环境变量控制开关或采样率，默认关闭或低采样；测量埋点自身开销。
4. 补单元测试：日志字段白名单、开关关闭时无额外输出、异常路径不泄露原始错误消息。

**完成标准：**在测试环境能对单个请求给出完整分段；安全审查通过；关闭开关后行为与修改前一致。

## 4. P1-1：缩短课程和学习记录的读取等待

**事实：**本机到云端曾出现文档/音频约 20–35 秒、学伴记录约 8–19 秒的单次等待，均不是 P95。2026-09-21 Web 容器探测样本：新建 PG 连接 5.7–10 秒，复用连接单条查询 461–863 ms，JWKS HTTPS 请求 1.7–2.6 秒（本机网络，非生产）。请求内认证复用、聊天首轮“一次会话扫描 + 每会话一次读取”、学伴历史最多 4 路并行均已实现（见 `tests/persistence/request-auth-reuse.test.ts`、`tests/runtime/chat-storage.test.ts`、`lib/learning/teach-back/runtime.ts`），不要再列为待开发。

**代码中的往返放大点（待 P1-0 数据确认占比）：**
- **鉴权链路**：每个 HTTP 请求在 `lib/auth/session.ts` 的 `resolvePrincipal` 中串行执行 `getClaims()`、PostgREST 自查 `app_accounts`、`app_internal.ensure_account`（`loadAccount` 在其成功路径内部调用，仅当其返回空时才在外层兜底调用）、`app_internal.session_is_active`，正常托管路径共 5 次串行往返；瞬时错误经 `withRegistryRetry` 最多重试 3 次，会进一步放大往返数。其中 Supabase 客户端每个请求新建一次，需核实 JWKS 是否跨请求缓存。
- **owner 绑定查询**：`createOwnerBoundQueryable().query()` 每次都是 checkout + `BEGIN` + `set_config` + SQL + `COMMIT`，即每条业务 SQL 至少 4 次往返；`withTransaction` 可让同一请求的多条 SQL 共享一次事务。
- **学伴历史**：`listTeachBackActivities` 先 `listSessions`，再按会话 `listRecords`（已有 4 路有界并发）。浏览器端 `HttpRuntimeStore` 的每次调用都是独立 HTTP 请求，每次都完整走一遍上述鉴权。
- **聊天首轮**：`lib/utils/chat-storage.ts` 的 `runtimeViews` 同样是“一次会话扫描 + 每会话一次读取”，但每会话读取用的是**无上限的 `Promise.all` 全量并发**（学伴侧为 4 路有界），会话多时会瞬时压满 HTTP 与连接池。
- **连接池**：托管模式下 Web `app_web` 池上限 5，worker `app_worker` 池上限 3（`lib/db/pool-registry.ts`），另各有 LISTEN 专用连接；空闲保留 60 秒。

**已撤回的反证：**2026-09-21 曾把账号与 session 状态合并为一次裸 SQL。模拟测试通过，但真实 `app_web` 连接因 `app_accounts_web_select` 的 RLS 条件要求 owner 绑定而返回 0 行，已撤回。任何合并鉴权查询的改动都必须在正确的 owner 绑定下进行，并提供真实 PostgreSQL/RLS 集成证据，不能只用模拟查询验收。

**入口：**`lib/db/app-pool.ts`、`lib/db/pool-registry.ts`、`lib/db/request-queryable.ts`、`lib/auth/session.ts`、`lib/auth/principal.ts`、`lib/persistence/server-auth.ts`、`app/api/persistence/[...path]/handler.ts`、`packages/@openmaic/storage/src/runtime/http.ts`、`lib/utils/chat-storage.ts`、`lib/learning/teach-back/runtime.ts`。

1. 在实际部署环境建立基线。固定一门旧课、一门新课及固定数量的学伴历史；每类接口采集至少 30 次热读取，并单独记录冷启动样本。报告样本量、中位数、P95、最大值与失败数；30 次仅作初步定位，不能当持续 SLA 证明。
2. 用 P1-0 的分段数据对照浏览器瀑布图，定位占比最大的阶段：新建连接慢查 DNS/网络与空闲回收；池等待高查连接释放与事务时长；短 SQL 往返多查上述放大点；媒体慢转 P1-3。
3. 一次只实施一种有证据的改动，候选按预期收益排列：
   - 同一请求内的多条 owner 绑定 SQL 改用一次 `withTransaction`，或减少 `BEGIN`/`set_config` 的独立往返。必须保持事务级 owner 设置，并与 transaction pooler 兼容。
   - 学伴历史改为批量读取或按需/分页读取，减少 N 次 HTTP 请求及其重复鉴权。
   - 去掉鉴权链路中对 `app_accounts` 的重复读取（PostgREST 自查与 `loadAccount`）。受上文反证约束，必须 owner 绑定并有真实 RLS 证据，且每个请求仍要校验会话撤销。
   - 避免读取整个聊天分区来完成单条展示；为聊天首轮 `runtimeViews` 的每会话读取加有界并发（对齐学伴侧的 4 路）；无变化写入必须先核对版本与冲突语义。
4. 请求缓存仅保留在同一次已鉴权请求内；若新增跨请求缓存，必须设计 owner/session/version 键、注销/撤销失效和更新后的读一致性。不得缓存成功身份来跳过下一请求的撤销验证。
5. 调整池参数前统计 Web、两个 worker、Pro 与维护连接的总上限。原计划实测 Supabase `max_connections=60`；代码按 session pooler 约 10 个后端槽位为 `app_worker` 做预算（两个 worker 各 3 个池连接 + 1 个 LISTEN）。连接模式须与 IPv4/IPv6、事务边界和 prepared statements 兼容，不直接扩大所有池。[官方连接说明](https://supabase.com/docs/guides/database/connecting-to-postgres)
6. 在相同环境和数据集复测，并验证撤销会话、跨 owner 读取、并发保存/恢复；至少完成一次真实课堂打开与历史恢复。

**完成标准：**提交逐阶段前后数据；建议热读取 P95 相比基线下降至少 50%，池等待 P95 < 1 秒，功能和隔离无回归。如延迟主要来自东京—新加坡的网络，记录实测下限及待选方案（如调整部署区域），不为达数值取消鉴权。

**回退：**撤回本项代码/池配置到上一版本；缓存可失效重建，不回滚用户已写入的数据库。

## 5. P1-2：前台完成标记与租约释放补偿

**事实（代码已定位）：**
- 前台课 `bK4mbbRke1` 曾出现 `outline.generationComplete=true`、`stage_meta.generation_complete=false`，已通过现有 API 补齐。下列代码路径可稳定产生该状态，不再归为“是否历史残留”。
- `lib/store/stage.ts` 的 `setGenerationComplete`：先 `saveToStorage()`，把大纲 `generationComplete=true` 写入文档；成功后再调用 `completeForegroundGenerationRoot` → `POST /api/stages/[id]/generation-complete`。第二步的任何失败（网络、500、保存后关闭页面）只记 `log.warn`，没有重试。触发完成请求还要求 `stageId` 存在且 `isBrowserPersistenceEnabled()` 为真；未开启浏览器持久化的纯本地模式不会发该请求，也不存在租约占用问题。
- 重开页面：`loadFromStorage` 读到 `persistedComplete=true` 后，`markGenerationCompleteIfDone` 直接返回；自愈分支只在 `!persistedComplete` 时调用 `saveToStorage()`，从不调用完成 API。因此不一致会一直保留。
- 完成路由中 `markStageGenerationComplete`（只更新 `stage_meta` 的窄 UPDATE）与 `releaseForegroundGenerationRoot` 是两条各自自动提交的独立语句（没有显式事务包裹，效果等同两次独立事务）；释放仅在请求带 session 头时执行（`if (sessionId)`），释放失败时返回 500，客户端同样不重试。两步各自幂等，重试是安全的。
- 租约：`FOREGROUND_GENERATION_LEASE_MS` 为 60 分钟；每用户上限代码默认为 1（`lib/server/heavy-task-admission/index.ts` 的 `heavyTaskOwnerLimit`），当前 Supabase compose 写死 `APP_HEAVY_TASK_PER_OWNER_LIMIT: '2'`。完成 API 失败时，一个槽位会被占到过期。session id 存在 `sessionStorage`（另有进程内 `volatileSessions` 兜底），同一标签页刷新后仍在，关闭标签页后无法再按 holder 释放，只能等过期。
- 后台 worker 的 `complete()`（`lib/server/generation-jobs/repository.ts`）在同一事务内同时更新 `document_outlines` 与 `stage_meta`，不受影响。
- Pro 智能体建课（`lib/server/agent-runtime/curriculum-tools.ts`）与 PPTX 导入（`lib/server/agent-runtime/import-pptx.ts`）在大纲中直接写 `generationComplete: true`，仓库中没有任何路径为它们更新 `stage_meta.generation_complete`，这类课程的镜像恒为 false。
- 目前 `stage_meta.generation_complete` 只经 `/api/stage-meta` 输出，前端 `fetchStageMeta` 只使用 `isOwner`，没有产品功能依赖它。实际影响主要是槽位占用，其次是镜像失真。

**入口：**`lib/store/stage.ts`（`setGenerationComplete`、`markGenerationCompleteIfDone`、`loadFromStorage`）、`lib/generation/foreground-root-client.ts`、`app/api/stages/[id]/generation-complete/route.ts`、`lib/persistence/stage-meta.ts`、`lib/server/heavy-task-admission/foreground-generation.ts`、`app/classroom/[id]/page.tsx`、`lib/classroom/stage-meta-client.ts`、`tests/generation/foreground-root-client.test.ts`、`tests/store/stage-generation-complete.test.ts`、`tests/agent-runtime/stage-meta-routes.test.ts`。

1. **镜像语义（2026-09-23 已决定）：`stage_meta.generation_complete` 不作为权威字段。**
   - 课程是否生成完成，以文档大纲 `document_outlines.data.generationComplete` 为唯一依据；前端的生成恢复、编辑冻结与学习就绪判断本来就只读大纲。
   - `stage_meta.generation_complete` 定位为“仅由前台完成路由与后台 worker 写入的镜像”。实施本项时，把 `lib/persistence/stage-meta.ts` 中字段注释由“Server-side mirror of the document outline's generation-complete flag”改为上述含义，并注明 Pro 智能体建课与 PPTX 导入不写入。
   - 不为 Pro/导入补写入路径，不修复历史 false 记录，禁止对 false 记录批量置 true。
   - 若将来有功能（如发布门槛、列表筛选、统计）要读取该字段，必须先作为独立工作项把它升级为权威字段：为 Pro/导入补写入路径，并按 producer 与实际文档逐条核对修复历史数据，经真实 PostgreSQL/RLS 验证后才能使用。在此之前，服务端判断完成状态应读取大纲。
   - 选择理由：仓库中没有产品功能依赖该字段；升级为权威字段需要改动三条写入路径并修复历史数据，风险与工作量都更大，却没有用户可感知的收益。本项真正要解决的是前台容量租约的释放。
2. **前台完成请求加有界重试**：网络错误与 5xx 退避重试，4xx（404 已删除、403 非本人）不重试；最终失败时给出可见提示。不能让旧页面整份覆盖新文档。
3. **重开补偿**：课堂页已在加载后调用 `fetchStageMeta`，响应中含 `generationComplete` 与 `isOwner`，但**不含 producer**——响应中的 `source` 字段恒为 `'document'`，仅诊断用，代码注释明令禁止据其分支。当“大纲已完成、镜像为 false、producer 不是 `server-job`（取自本地已加载文档大纲的 `producer` 字段，如 `lib/store/stage.ts` 的 `outlinesRecord?.producer`）、本人课程”时调用完成 API。无 session 头时只补标记、不释放（与完成路由现有 `if (sessionId)` 行为一致），租约由过期回收；同一标签页 `sessionStorage` 仍有 session id 时顺带释放。
4. 评估把路由中的“标记”与“释放”放进同一 owner 绑定事务（`withTransaction`），消除“已标记、未释放、返回 500”的中间态。
5. 保留四个受控故障位置（最终保存前、保存成功但完成请求失败、请求成功但响应丢失、刷新重开）作为回归测试：修复前应能复现，修复后应能收敛。
6. 补充失败重试、重复请求、外来 owner、已删除课程与并发编辑测试；核对取消/失败语义下不把半成品或已删除课程标为完成。最后跑一门全新的真实前台课程。

**完成标准：**正常流程与受控故障后，前台课程的租约在完成后立即释放，或在无法释放时于过期后可复用；前台课程的镜像与大纲一致；无内容覆盖。`stage-meta.ts` 字段注释已按第 1 步更新；Pro/导入课程镜像保持 false，属于预期行为，不计为失败。

## 6. P1-3：私有媒体间接出口（redirect）验证

**事实（代码）：**
- 当前 Supabase 栈为 `ASSET_BYTE_EGRESS: direct`，在 `docker-compose.supabase.yml` 中写死（`.env.hosted.example` 同为 direct）。媒体字节路径为 Storage → 应用 → 浏览器，全部占用服务器带宽；生产上行 20 Mbps。
- redirect 能力已实现：`app/api/persistence/[...path]/handler.ts` 在 `ASSET_BYTE_EGRESS=redirect` 且资产回收宽限期不低于签名有效期 10 倍时启用（签名 TTL 60 秒；默认宽限 1 小时，`GENERATION_BACKGROUND_ENABLED=1` 时下限抬升为 24 小时——见 `lib/persistence/asset-collection-grace.ts`，两种取值均满足条件；不满足时回退 direct 并输出警告）。服务端先校验 owner/资源，再用 `@aws-sdk/s3-request-presigner` 对 Supabase S3 端点签发 SigV4 GET URL，并写入 `ResponseContentType`、`ResponseCacheControl`、`ResponseContentDisposition`（`packages/@openmaic/storage/src/asset/s3-bytes.ts`）。
- 浏览器端 `HttpAssetStore`（`packages/@openmaic/storage/src/asset/http.ts`）发起一次字节 GET 并带 `Accept: application/vnd.openmaic.asset-descriptor+json, */*;q=0.9` 协商头；redirect 模式下服务端以描述符 JSON 作答（不是独立的预请求），客户端再以 `credentials: 'omit'` 跨源 fetch 签名 URL 读取完整 body（字节 GET 设 `redirect: 'manual'`，任何 3xx 按错误处理、不跟随）。Blob URL 由存储包铸造（`http.ts` 与 `browser-store.ts` 的 `URL.createObjectURL`），`lib/media/use-asset-url.ts` 只负责租约与引用计数；`<img>`、`<audio>`、编辑器画布与导出都只接触 Blob URL。
- 因此：拖动播放由浏览器对 Blob 处理，不走 Storage 的 Range；画布导出不涉及跨源图片；签名过期只影响“拿到描述信息到发起 fetch”之间的 60 秒窗口；数据库与课程内容只保存资产 ID（已满足）。
- 客户端要求签名响应带 `content-type`；404 只有带 `NoSuchKey` 错误码才判为对象缺失，否则按错误处理。
- [Supabase S3 兼容表](https://supabase.com/docs/guides/storage/s3/compatibility)确认支持 SigV4 查询参数预签名与 GetObject Range，但**未列出 `response-*` 响应头覆盖参数**，且**不支持 `PutBucketCors`**。浏览器能否跨源读取取决于 Supabase 的默认 CORS 行为。

**入口：**`app/api/persistence/[...path]/handler.ts`、`packages/@openmaic/storage/src/asset/s3-bytes.ts`、`packages/@openmaic/storage/src/asset/http.ts`、`packages/@openmaic/storage/src/asset/byte-store.ts`、`lib/persistence/asset-byte-store.ts`、`lib/persistence/asset-collection-grace.ts`、`lib/media/use-asset-url.ts`、`docker-compose.supabase.yml`、`tests/media/use-asset-url.test.ts`、`tests/persistence/asset-byte-store.test.ts`。不另开发第二套签名机制。

1. 以 D0 第 7 步的中转基线确定优先级：若媒体已占满服务器上行或明显拖慢首屏，本项提前到 P1-1 之前。
2. 在测试环境把 compose（或生产覆盖文件）中的 `ASSET_BYTE_EGRESS` 改为 `redirect`。这是改 compose 文件，不是只改 env 文件。启动日志不应出现回退到 direct 的警告。
3. **Supabase S3 兼容性验证**（图片、SVG、MP3、已有视频各一）：
   - 签名响应的 `content-type`、`cache-control`、`content-disposition` 是否与 direct 模式一致；
   - 从正式 origin 发起的跨源 fetch 是否被 CORS 放行；
   - 已删除对象是否返回带 `NoSuchKey` 的 404；错误桶/端点是否不会被误判为缺失；
   - 读取的字节 hash/长度与 direct 模式一致。
4. 若 Supabase 不支持响应头覆盖：评估上传时写入正确的对象元数据（PutObject 支持 Content-Type/Cache-Control/Content-Disposition）能否满足；否则保持 direct，不自建代理之外的第二套。
5. 功能回归：课堂播放与拖动、编辑器画布、ZIP/PPTX 导出。
6. 权限：匿名、另一 owner、退出/删除账号后请求描述信息应被拒；已签发的 URL 在 60 秒内仍有效，记录这一实际窗口。响应和日志不泄露签名 URL。需要逐次即时撤权的资源继续走 direct。
7. 对比 direct 与 redirect 的服务器出站流量和媒体完成时间。注意 redirect 模式下应用请求数与 direct 相同（每资产一次描述信息请求、完整鉴权），多出的是浏览器直连 Storage 的一次跨源请求；高延迟下单资产耗时不一定下降，收益主要在带宽。确认收益后再切换默认值，并保留回切方式。

**完成标准：**全部现有播放/编辑/导出路径仍可用，资产 hash/长度一致，桶仍 private；服务器中转流量下降有数据支持。当前 Blob 模型会先下载完整文件再播放，大视频的流式播放和直传上传都属于独立的后续工作。

## 7. P2-1：全站 16 / 每用户 2 的真实容量验收

**现状：**当前 3 个账号不足以证明 8-owner/16 根任务。已有临时 PostgreSQL 调度验证脚本，但它不调用真实云端模型，不能代替吞吐验收。

**配置事实：**
- `scripts/supabase-compose.ps1` 的 4/8/16 档分别设置 `APP_HEAVY_TASK_LIMIT`、`OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT`、`GENERATION_LLM_MAX_INFLIGHT` 为 4/8/16，`GENERATION_WORKER_CONCURRENCY` 为 2/4/8；worker 固定 2 副本；每用户上限在 compose 中写死为 2（代码默认值为 1）。
- **连接池不随档位变化**：托管 worker 池固定 3、Web 池固定 5。16 档时每个 worker 有 8 个根任务共享 3 个连接；设计上根任务不预占连接，但池等待是主要风险。
- `docker-compose.supabase.yml` 中 Web 与 worker 的 `/tmp`、`/app/data` 都是**未设大小上限的 tmpfs**（hosted 覆盖的 `/app/data` 为命名卷，不适用此条），解析/渲染临时文件直接占用内存，要计入内存峰值。
- 生产机为 8 GB，还要容纳宝塔及其他已有服务；`render-service` 不在本次范围内。

**入口：**`scripts/test-hosted-capacity.ps1`、`scripts/supabase-compose.ps1`、`docker-compose.supabase.yml`、`lib/db/pool-registry.ts`、`lib/server/heavy-task-admission/`、`lib/server/generation-jobs/`、`tests/server/hosted-capacity-rls.pg.test.ts`。

1. 使用隔离测试环境或明确维护窗口，准备至少 8 个专用 owner。先核对模型 RPM/TPM、图片/TTS 配额、测试费用上限；真实用户不参与故障注入。维护单独的测试对象清单。
2. 先运行现有多进程临时 PG 测试，证明全局/owner 准入、租约 fencing、取消、去重和删除不回归。前提：Docker；Node 需满足 package.json 的 `>=22.13.0`（脚本本身只检查主版本 ≥22）；55432 端口空闲（脚本不做预检）。脚本会先运行 `scripts/build-generation-worker.mjs` 重建本地 `dist-worker/`，数据库写入只发生在它新建的临时 PostgreSQL 中。

   ```powershell
   # 仓库根目录；数据库写入只发生在脚本新建的临时 PostgreSQL，另会重建本地 dist-worker/。
   ./scripts/test-hosted-capacity.ps1 -NodeExecutable node
   ```

3. 建立固定任务集：普通后台与 Pro 混合、相近页数和媒体数量；另测普通前台同步准入与后台/Pro 共享额度。使用相同输入规模，避免将任务变轻当成容量提升。
4. 按 4→8→16 逐档执行，每档开始前核实实际配置。改档用 `Apply` 会重建配置变化的容器，应先停止接入新任务并等待活动任务终态，不能在真实请求中途切换。
5. 每档建议先一轮冒烟，再至少三批可比较任务；记录每个根任务的 owner、类型、排队/开始/结束时间、结果、重试和提供商用量。持续采集 DB 准入事件与每秒监测；仅靠采样不能证明从未短暂超限。
6. Tier 16 时让 8 个 owner 各有 2 个可运行根任务，并额外提交第 17 个；验证全局最多 16、每 owner 最多 2，超额的任务等待或按既有契约拒绝。Pro 派生的 job/解析任务不能被重复计为根任务；公平性检查新旧 owner 都有进展。
7. 采集池等待（P1-0 埋点）、队列等待、P95 完成时间、成功率、429、CPU/RSS、tmpfs 占用、事件循环延迟、心跳和租约丢失；负载中实际打开旧课堂、播放媒体并完成学伴一轮。
8. 用可控 provider 做超时/429/worker 退出恢复；真实模型只做有预算的必要验证。核对重试不产生重复课程或无依据的重复收费，不删除共享对象。
9. 单独给出“调度上限通过”“真实模型吞吐通过”“课堂在负载下可用”三项结论。每次失败先说明瓶颈，再决定调度优化、配额调整、池预算（受 P1-1 第 5 步约束）、带宽或机器升级。

**建议完成标准：**确有 16 个根任务重叠运行；全站/owner 从不越限；无 OOM、重复课程、非预期租约丢失；三批均达到预先约定的成功率，原始失败也计入；池等待 P95 < 1 秒、容器总内存峰值（含 tmpfs）< 分配内存 75%。模型额度不足时只能宣布调度通过。失败率建议目标 ≤1%，但小样本须同时报告失败个数，不能推断长期稳定性。

**停止/回退：**发生越权、数据错写或重复执行立即停止升档；资源持续饱和、429/超时集中出现则排空后回到上一已验证档位。恢复原配置、保留任务日志，测试账号/文件只按测试对象清单和既有删除流程清理。

## 8. P2-2：补齐完整课堂和学伴验收矩阵

1. 从原计划第 9.1 节与 T0 清单建立表格，逐项填“已有证据 / 待测 / 失败 / 不适用及原因”。沿用已通过的课程 ID，不把全部工作重新标为未做。
2. 四类课程分别覆盖：普通前台、普通后台、Pro、迁移旧课。页面类型选已有的 slide、交互/练习等代表样本；每种已有导出格式单独记录。生产未启用 MP4 导出时，标为“不适用（资源限制）”，不写失败也不写通过。
3. 补测生成阶段的确认/取消/失败恢复；课堂的编辑保存、媒体、聊天、白板、练习/反馈、导出；刷新和容器重建后的持久化读取。
4. 学伴补齐选择、准备、解释、追问/评价、引用/总结、暂停/恢复、结束、历史和账号隔离。已有的“重试创建新活动”是当前行为，不写成同一 activity 续跑；瞬时播放位置也不冒充已支持跨设备同步。
5. 每项记录课程/会话 ID、操作、预期、实际与证据；UI 与云端持久化各有证据。扩容后重点复测受连接和模型竞争影响的链路。

**完成标准：**原矩阵各项有结论，失败项已修复或明确归为既有问题；未验证项不写通过。仅在完整矩阵通过时更新原 T8，在真实容量同时通过后更新 T9。

## 9. P2-3：观测、恢复与资源维护

1. 上线时先保留错误率、readiness、worker 心跳、备份和回滚；随后补池等待、队列年龄、模型 429、Storage 失败及磁盘/内存（含 tmpfs）指标。阈值基于真实运行基线设定，避免重复告警。
2. 现有 compose 只设置 `LOG_LEVEL`/`LOG_FORMAT`，没有 Docker `logging` 轮转配置。生产覆盖文件或宿主 Docker daemon 需配置日志轮转和保留期；业务状态和删除账本仍在数据库；日志脱敏，区分测试与真实用户流量。
3. **临时文件**：Web/worker 的 `/tmp`、`/app/data` 是 tmpfs，容器重建即清空，但运行期间占用内存。为 tmpfs 设置 size 上限，按“任务租约 + 最后使用时间 + 保留期”清理长运行容器内的临时文件。先 dry-run 输出候选，只删除确认没有活动任务引用的文件；不递归清理业务卷或备份目录。
4. **Storage 孤儿对象**：Supabase 栈在共享环境锚点中设 `ASSET_COLLECTION_ENABLED: 'false'`（web/worker/readiness 全关闭），替换或删除后无引用的对象会累积。**注意 hosted 覆盖并未全关**：`docker-compose.hosted.yml` 只在 Web 服务上设置该变量，其 `generation-worker`（`env_file: !reset []`）未设置，而代码默认开启（`lib/persistence/asset-collector-schedule.ts` 仅 `'0'`/`'false'` 视为关闭），即 hosted 栈的 worker 实际会运行资产回收；启用状态必须按服务逐一核对，不能按栈笼统认定。按原部署计划，在对象层与备份保护验证后再启用。`AssetCollector` 没有 dry-run 模式，启用前需另写只读查询，统计无引用对象的数量与体积。
5. 在隔离恢复环境演练数据库、Storage 对象及加密密钥恢复，记录实际 RPO/RTO；抽查课程、媒体、学习记录和共享对象引用。备份是否覆盖 Storage 必须独立确认。
6. 复核历史 Advisor 提示：
   - `public.reserved_admin_lifecycle_snapshot`（定义在 `lib/server/accounts/sql-accounts.ts`，accounts v5）授权给 `authenticated`，是为 `scripts/lib/test-admin-lifecycle.ts` 的 dry-run 服务。函数内部已校验 `auth.uid()` 非空、邮箱属于调用者、账号为 active admin。如要收紧，须新增 accounts 迁移版本，同步 readiness 的 `ACCOUNTS_SCHEMA_REQUIRED`（当前 19），并保证该脚本仍可用或有替代途径，不在控制台直接改。
   - 泄露密码保护：按产品登录策略决定是否开启，不为清空告警破坏现有账号功能。
7. 验证断网时显示未同步/可重试状态，不能仅写本地缓存就显示保存成功。恢复后验证幂等和冲突处理。

**完成标准：**至少一次可复现的恢复演练、一个告警触发/恢复样本、临时文件 dry-run 及安全清理样本、孤儿对象只读统计；已有业务数据与私有访问边界保持完整。

## 10. P3-1：编辑器“未配音”标签一致性

**事实（代码已定位）：**Pro 样本有 5 条 MP3，读取与课堂播放均成功，但编辑器显示“未配音”。原因是两条路径的判断依据不同：
- 编辑器标签：`components/edit/ActionsBar/ActionsBar.tsx` 用 `audioExists(candidateId) || !!audioUrl` 判断，而 `audioExists`（`lib/audio/regenerate-speech-tts.ts`）只查浏览器本地 Dexie 的 `db.audioFiles`。
- 课堂播放：`resolveAudioBlob`（`lib/media/resolve-audio-bytes.ts`）先查云端资产池，再回退到 Dexie。
- Pro/后台生成的音频只存在云端资产池，本机没有 Dexie 副本，所以标签必然显示“未配音”。`audioExistsBulk` 目前没有调用方。
- 标签错误可能诱导用户点“全部配音”，重新调用 TTS 并产生费用。

**入口：**`lib/audio/regenerate-speech-tts.ts`、`components/edit/ActionsBar/ActionsBar.tsx`、`lib/media/resolve-audio-bytes.ts`、`lib/media/use-asset-url.ts`（`assetRefExists`）、`tests/audio/regenerate-speech-tts.test.ts`、`tests/media/resolve-audio-bytes.test.ts`、`tests/edit/actions-bar-cue-preview.test.ts`。

1. 冷启动同一 Pro 样本，确认持久化的 `audioId` 存在、Dexie 中无记录、资产池可读，以此复现。
2. 存在性判断改为“资产池存在或 Dexie 存在”。资产池侧优先使用 `assetRefExists`：存储支持时只查元数据，不下载字节；不要为每条台词下载完整音频。
3. 区分无音频、检查中、可播放、资源失效和失败；检查失败时保持原状态，不误报为“已配音”。
4. 不为修标签重新调用 TTS，也不把真实丢失的对象标成成功。
5. 回归旧课程（仅 Dexie 旧键）、无配音课程、生成中、失败、替换声音、编辑文本后失效、刷新重开与编辑保存；确认不覆盖原 `audioId`。

**完成标准：**标签与持久化/实际可用性一致，无额外模型费用，课堂播放和编辑保存无回归。

## 11. P3-2：教学图片细节质量

**事实：**分数课图片已生成并保存，但“四等分”视觉未严格满足教学要求；文件完整性与教学准确性分别评价。

1. 固定一组可人工判断的样本：等分、数量、标签与公式；保留 prompt、模型版本、种子（如支持）和图片，先记录通过率。
2. 追踪课程计划到图片请求的实际约束，排查要求是否丢失；先调整明确可执行的约束和模板，不修改数据库迁移逻辑。
3. 对精确几何/计数图，评估现有 SVG/画布或结构化插图路径；自然图片继续使用图像模型。需要改变产品交互时单独提出方案。
4. 若增加自动检查，限制最多重试次数和费用；判断不确定时标记需人工检查，不无限重生成。
5. 用相同样本集对比修改前后，人工复核教学含义，再检查显示、持久化和导出。AI 自评不能作为唯一证据。

**完成标准：**固定样本的等分、数量和标签达到事先定义的正确性标准；生成耗时与费用有记录，导出不损坏。未达标时保留人工替换路径，不声称普遍准确。

## 12. 每项实施后的验证与记录模板

只运行与本项有关的测试；全部代码稳定后再跑一次完整测试、类型检查及构建。文档变更无需全套测试。现有入口示例（本机 PowerShell；Node 需满足 package.json 的 `>=22.13.0`）：

```powershell
# 认证与读取优化相关测试
node node_modules/vitest/vitest.mjs run tests/persistence/request-auth-reuse.test.ts tests/runtime/chat-storage.test.ts tests/learning/teach-back-runtime.test.ts --maxWorkers=2

# 完成状态相关测试
node node_modules/vitest/vitest.mjs run tests/generation/foreground-root-client.test.ts tests/store/stage-generation-complete.test.ts tests/agent-runtime/stage-meta-routes.test.ts --maxWorkers=2

# 媒体出口相关测试
node node_modules/vitest/vitest.mjs run tests/media/use-asset-url.test.ts tests/persistence/asset-byte-store.test.ts --maxWorkers=2

# 配音标签相关测试
node node_modules/vitest/vitest.mjs run tests/audio/regenerate-speech-tts.test.ts tests/media/resolve-audio-bytes.test.ts tests/edit/actions-bar-cue-preview.test.ts --maxWorkers=2

# compose 配置契约（修改 compose 或新增生产覆盖文件后）
node node_modules/vitest/vitest.mjs run tests/config --maxWorkers=2

# 修改稳定后的类型与全套回归
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=15000
```

这些命令是已有检查入口，不能替代新增的失败场景、真实 PostgreSQL/RLS 集成与真实浏览器验证；涉及 RLS 或鉴权的改动不能只用模拟查询验收。机器负载影响测试时应记录原因，在稳定环境重跑失败项；不要直接调高超时掩盖真实回归。

每项在 `docs/reports/` 新增日期化记录，使用以下模板：

```markdown
# 工作项编号与名称
- 环境/日期/代码版本/镜像：
- 初始问题及复现步骤：
- 修改范围与原因：
- 前后指标（样本量、中位数、P95、失败数）：
- 自动测试命令及结果：
- 真实操作与课程/任务/会话 ID：
- 权限与持久化检查：
- 回退方式及是否验证：
- 结论：通过 / 未通过 / 受外部条件限制
- 剩余事项：
```

后续接续任务可直接使用：

> 阅读本清单、当前数据库验收报告和相关代码，只实施我指定的工作项。先复现与测量，再做最小修改并验证；保留当前未提交工作和三种生成模式，不修改无关功能，不把历史单次测试当作当前性能结论。完成后更新对应报告，明确通过范围和剩余限制。

技术资料于 2026-09-23 核对；后续执行涉及 Supabase API、S3 兼容性、连接模式或配置变更时，重新核对[官方更新记录](https://supabase.com/changelog)及对应文档。
