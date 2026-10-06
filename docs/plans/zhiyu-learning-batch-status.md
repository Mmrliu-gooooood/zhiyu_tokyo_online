# 智域学习功能批次状态

依据：[后续功能规划](2026-09-27-zhiyu-learning-feature-roadmap.md)、[分批实施方案](2026-09-27-zhiyu-learning-implementation-plan.md)（第 9.4 节台账模板）。
本文只记录实际完成和实际验证过的内容；“实现完成”不等于已合并、已预发布验收或已上线。

| 批次 | 实现状态 | 分支 / PR | 合并 commit | 预发布验收 | 生产启用 | 遗留事项 |
| --- | --- | --- | --- | --- | --- | --- |
| B00 | 完成（基线与台账） | `learn/b01-spaces` | `a1a0a7b6`（main） | 不适用 | 不适用 | — |
| B01 | 已上线（2026-10-05，release-20261005） | `learn/b01-spaces` → main（快进，已推送 tokyo） | `a1a0a7b6` | 无预发布环境，生产按开关灰度 | 已启用 `ZHIYU_STUDY_SPACES_ENABLED=1` | 见“生产发布与验收” |
| B02 | 已上线（2026-10-05，release-20261005c） | `learn/b02-materials` → main（快进，已推送 tokyo） | `11113d2e` | 本地托管模式验收通过（见 B02 节） | 已启用 `ZHIYU_STUDY_MATERIALS_ENABLED=1` | 见 B02“遗留事项” |

## B02 共享资料版本、结构化解析与阅读（2026-10-05，已上线）

### 范围与起点

- 分支 `learn/b02-materials` 从 main `0e60d2fa`（含 B01 与 release-20261005b 热修）创建；生产为 release-20261005b、accounts v22。
- 范围：资料库（上传、改名、新版本、永久删除）、学科关联、后台解析任务（排队/运行/取消/重试/失败原因）、结构化解析结果与阅读器、资料在 AI 工作台与课程生成中复用；学习任务队列与 v23 迁移。
- 不包含：检索/索引/答疑（B03）及之后批次；学科页没有放这些能力的占位入口。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

1. **任务队列：独立表，共享机制**。新建 `learning_tasks` 与 `learning_task_attempts`，契约在 `lib/study/tasks/contracts.ts`（客户端安全）与 `lib/server/learning-tasks/contracts.ts`（ownerId、rootTaskId=`learning:{id}`、kind、idempotencyKey + requestHash、status、lease_epoch/lease_expires_at/heartbeat、attempt、budget、usageCompleteness）。kind 目前只有 `material_parse`（表上 CHECK 约束，后续批次加 kind 走新迁移）。从 `lib/server/generation-jobs/repository.ts` 抽出 `lib/server/task-queue/lease-queue.ts`（事务包装、错误摘要脱敏、重试退避、heavy-task 准入锁与公平检查、账号删除栅栏、按 owner 的认领 advisory lock），课程生成改为调用它，SQL 与行为不变；生成队列的单测与真实 PostgreSQL 并发/租约测试全部通过作为回归兜底。
2. **语义**：认领 `FOR UPDATE SKIP LOCKED` + heavy-task 准入（个人 2 / 站点 16 与课程生成共用同一计数，公平调度）；租约 60 秒、心跳续租、`lease_epoch` 栅栏（取消、过期回收都 +1，持有者的后续写入全部失败）；可重试错误按退避进入 `retry_wait`，最多 3 次；不可重试错误（资料已删、类型不支持、解析器不可用、无可提取文字、摘要不符等）直接失败、界面不显示“重试”；已发起外部付费调用的任务过期时标记 `EXTERNAL_RESULT_UNKNOWN` 失败而不是自动重放；排队超过 10 分钟过期；幂等键重复提交返回同一任务。每次尝试写一行 attempt（worker、租约、解析器、结果、用量、用量完整度）；持有者失联或被取消时由 Worker 或回收器补记 `lease_lost`/`cancelled`，不会留下“运行中”的尝试。
3. **Worker**：现有 generation worker 进程在开关打开时启动学习任务调度（`lib/server/learning-tasks/runner.ts`），按 kind 分派，默认并发 1（`LEARNING_TASK_WORKER_CONCURRENCY`，1–4）；心跳行用 `{workerId}#learning` 并声明能力 `learning-tasks-v1`，Web 端只在有存活且具备该能力的 Worker 时才接单。停止时与课程生成一起排空（20 秒，超时的任务以可重试的 `WORKER_DRAIN_TIMEOUT` 交还队列）。
4. **连接池预算**：`app_worker` 池保持 `max=3`。学习调度每 2 秒一次短事务扫描，解析本身（读对象、跑解析器）不占连接，只在认领、心跳、提交时短暂借用；并发 1 时峰值新增 1 个连接，与课程生成共用 3 个以内（`lib/db/pool-registry.ts` 注释记录计算）。并发调到 2 以上前须重算并相应加大池。
5. **数据模型（accounts v23）**：`study_materials`（资料，含当前版本、版本数、revision、`active|deleting`）、`study_material_versions`（不可变；一行对应一次 `owner_material` 上传，记录对象 key、sha256、MIME、大小、原文件名、当前解析结果）、`study_material_artifacts`（按 `(版本, 指纹)` 唯一；指纹 = 解析器 id + 版本 + 转换版本，相同条件不重复解析）、`study_space_materials`（学科关联，含来源 library/generation）、`study_session_material_refs`（工作台会话对版本的引用）。全部 FORCE RLS；`app_web` 对本人数据增删改查（attempt 表只读），写入时 `WITH CHECK` 要求版本引用本人已就绪的上传、会话引用本人未删除的会话；`app_worker` 只有解析所需的最小权限（读资料/版本/任务、写解析结果与 attempt、更新版本当前结果与任务状态）；anon/authenticated 无任何授权。新增 `app_internal.learning_task_readiness()`；`app_internal.heavy_task_capacity` 以 v11 函数体为基础并入 `learning_tasks` 的运行/排队/公平计数（本地模式 SQL 同步覆盖）。
6. **解析**：只复用 `lib/pdf` 的 unpdf / mineru / mineru-cloud / alidocmind 与文档提取器注册表，不新写解析器。默认用内置解析器（PDF → unpdf，Office/文本 → 内置提取器）；**付费 OCR 只在用户明确选择时使用，绝不自动升级**，且只有服务端已配置时才可选（未配置显示“付费 OCR · 未配置”且不可点）。为阅读器按页定位，给 unpdf 增加可选 `pageTexts`（`extractText` 不合并页面），默认输出与合并文本完全不变。
7. **解析结果存储**：规范化后的结构（去掉 providerRaw 与 HTML，按页分块，图片拆成独立对象）存为 `study/{owner}/artifacts/{artifactId}/` 下的 artifact JSON、纯文本与图片对象，表里记录全部对象 key；解析中途失败会清理已写入的对象。**崩溃不留孤立对象（预写清单）**：写对象前先在租约内把将要写的全部 key 记到本次 attempt 的 `staged_object_keys`，提交 artifact 的同一事务里清空；进程在两者之间死掉时，Worker 例行维护里的清扫会在尝试结束 15 分钟后（超过任务时限与栅栏生效时间，确保旧持有者不再写入）删除这些对象再清空清单，且永不删除已提交 artifact 引用的 key。永久删除资料时保留仍有待清扫对象的任务行；账号删除清单也包含这些 key。对象存储没有按前缀列举接口，所以选预写清单而不是扫描存储桶。开发环境可用 `STUDY_PARSE_DEV_DELAY_MS` 拉长解析（生产忽略）以便验收崩溃/取消。
8. **阅读器**：原文件用 pdf.js（经已有依赖 `unpdf` 的浏览器构建）渲染单页 canvas，旁边是该页解析文字与图片，可跳页；非 PDF 显示原图或解析文字。文件/图片/文字接口私有、`no-store`、`nosniff`，非 PDF 附 CSP sandbox。**没有引入 react-pdf-highlighter**（方案提到）：B02 不需要划词高亮/引用定位，留给 B03 引用跳转时再定。
9. **复用到工作台**：“在 AI 工作台中使用”把版本**按引用**绑定到新会话：会话素材行指向共享的原文件与解析文字 key，解析状态直接为完成，并写 `study_session_material_refs`；不复制对象。会话读取共享 key 时由 Worker 侧校验该会话确实引用了这个版本。旧接口 `GET /api/materials?sessionId=` 合约不变并能列出这些素材。删除会话不影响资料与其他会话。
10. **复用到课程生成**：首页资料选择器读取所选版本的解析文字，作为生成输入的 `pdfText`（与上传 PDF 走同一路径），会话记录所用版本；在学科中生成时课程自动关联到学科（`added_via=generation`，同时补上 B01 后台生成路径不关联的缺口）。解析出的图片本批不进入课程生成（需要改生成管线，不在范围内）。
11. **上传**：从 `app/api/materials` 抽出 `lib/server/materials/owner-upload.ts`，两条入口共用同一校验、配额、摘要与存储逻辑（旧接口 87 项测试不变）。资料库只接受文档、图片与文本（音视频仍在工作台）。同一账号重复上传同一文件给出“已在资料库中”的提示（`duplicateOf`），不跨账号比对。
12. **永久删除**：先把资料标为 `deleting` 并取消其任务、撤销会话引用 → 删除全部对象（原文件、解析结果、图片）→ 删除行；对象删除未完成时返回 202，可重入。确认框显示受影响的学科数与仍存活的会话数。账号删除清单纳入新表与 artifact 对象。
13. **开关**：`ZHIYU_STUDY_MATERIALS_ENABLED`（默认关，且要求学科空间开关打开）控制页面与 `/api/study/materials`、`/api/study/tasks`；`ZHIYU_STUDY_TASKS_ACCEPTING=0` 停止接新解析任务（已排队/运行的照常完成），用于发布前排空。`/api/study/capabilities` 返回 `{ spaces, materials }`。Web 与 Worker 都要设置（compose 已透传）。
14. **上限**：每账号 200 份资料、每份 20 个版本、每学科 100 份资料、标题 120 字；单次返回解析文字最多 200 万字；每个解析结果最多 200 张图、单图 10 MB；上传大小沿用原有素材上限。
15. **接口**：新接口全部在 `/api/study/materials`（列表/上传、详情/改名/删除、新版本、`versions/[versionId]/{parse,reader,file,text,images/[imageId]}`）、`/api/study/tasks/[taskId]`（含 cancel、retry）、`/api/study/spaces/[spaceId]/materials`。身份与 B01 相同（`withRequestOwnerId` + `user:` owner，匿名 401，外人/不存在 404）。

### 偏离方案之处

- 未引入 react-pdf-highlighter，pdf.js 走现有 `unpdf` 依赖（见决策 8）。
- 解析出的图片不用于课程生成（决策 10）；OCR 调用不写 `usage_events`（付费 OCR 不是模型调用，attempt 行记录了用量与完整度，计费接入留待付费 OCR 真正开放时）。
- 方案中的“删除会话”接口在代码里不存在（会话是软删除），所以只验证了软删除后的引用行为。
- 课程生成复用走 `pdfText` 而非新的生成输入字段，生成管线不改。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-materials.ts`（v23）、`migrations.ts`、`sql-accounts.ts`（版本 23）、`lib/server/study/schema.ts`、`deletion.ts`。
- 队列：`lib/server/task-queue/lease-queue.ts`（新，共用）、`lib/server/generation-jobs/repository.ts`（改用共用模块）、`lib/server/learning-tasks/{contracts,repository,runner}.ts`、`lib/server/heavy-task-admission/index.ts`、`workers/generation/main.ts`、`lib/db/pool-registry.ts`。
- 资料：`lib/server/study/materials/{repository,service,parse,artifact,http}.ts`、`lib/server/study/flags.ts`、`lib/server/materials/owner-upload.ts`、`lib/server/agent-runtime/session-materials.ts`、`lib/pdf/*`、`lib/document/*`（`pageTexts`）。
- 接口与页面：`app/api/study/{materials,tasks,spaces/[spaceId]/materials}/**`、`app/study/materials/**`、`components/study/materials/*`、学科页资料区、导航“资料库”、首页资料选择器；12 个语言文件 `study.materials.*`。
- 配置：`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml`（两个开关与并发透传）。

### 数据迁移

- accounts **v23**，checksum `3fe42841b0aae393f93cbcfac54967f87ebaa1f298ad1d0552707718d5b746e7`；v21 `a13fa31d…`、v22 `01c9914f…` 未变。旧迁移 SQL 未改动。
- 已执行：PGlite（单测）；一次性 PostgreSQL（`*_rls_proof` 容器）上 v23 迁移/RLS/授权/容量函数测试、全新库 bootstrap 到 v23；本地托管验收库（PostgreSQL 17，按生产顺序 bootstrap 到 v23，7 张新表均 `relrowsecurity = relforcerowsecurity = true`）。均已销毁。**未在生产执行。**

### 测试

- 新增：`tests/server/learning-tasks.test.ts`（14：认领/准入/租约栅栏/取消/重试/回收/外部调用不重放/排空/失联尝试补记等）、`tests/server/study-materials.test.ts`（8）、`tests/server/study-materials-migration.test.ts`（PGlite 4 + PostgreSQL 4）、`tests/api/study-materials-routes.test.ts`（5：开关隐藏、匿名 401、错误码映射、输入校验、owner 只取自会话）。
- 调整：`tests/agent-runtime/session-materials.test.ts`（按引用绑定）、`tests/server/account-deletion-lifecycle.test.ts`、`tests/auth/principal-mode.test.ts`（版本含 23）、`tests/api/study-routes.test.ts`（capabilities）。
- 真实 PostgreSQL（一次性 `*_rls_proof`，已 `down -v`）：v23 迁移 + B01 v22 + 全新 bootstrap 19 项通过；生成队列回归（`generation-jobs.pg`、`generation-transaction-queue.pg`、`generation-worker-pipeline.pg`）、`hosted-capacity-rls.pg`、账号删除 44 项通过。
- 全量结果见本节末“最终校验”。

### 浏览器验收（2026-10-05，本地托管模式）

环境：一次性 PostgreSQL 17（bootstrap 到 v23，`app_web`/`app_worker` 登录角色，RLS 生效）、`scripts/dev-fake-supabase-auth.ts`、本地假模型服务器、本地假 S3（Windows 本地字节存储的 key 含冒号无法写入，生产用 S3，见遗留）、`next dev`（`AUTH_MODE=supabase`）、带学习调度的 generation worker。临时环境文件无真实密钥与生产地址，结束后已删除；容器、fixture、账号文件均已清理。设备 A `localhost:3100`，设备 B `127.0.0.1:3100`。未调用付费 OCR 与真实模型。

1. 账号 A 在学科“创新创业”上传 `智域项目计划书.pdf` → Worker 用 unpdf 解析：39 页、26,832 字、18 张图、879 ms；attempt 记录用量，完整度 none。
2. 阅读器：canvas 原页 + 该页解析文字与图片；跳到第 12 页（文件页码，印刷页码为“第 9 页”）。
3. 从资料库加入“高等数学”：数据库 1 份资料、1 个版本、1 个解析结果、2 条学科关联、1 次上传；S3 对象 21 个（无复制）。
4. “在 AI 工作台中使用”两次 → 两个会话素材行都指向共享 key、解析状态完成、引用行已写、无新对象；旧 `GET /api/materials?sessionId=` 能列出；Worker 角色读取两个会话的文字/原文件成功，读别人会话为空；软删除会话 1 后会话 2 照常读取、对象仍在。
5. 用资料库资料在学科中生成课程（后台生成路径）：任务输入文字 26,890 字、无重复素材；生成成功 2/2；课程自动关联学科。
6. 扫描件 PDF → 失败 `MATERIAL_NO_TEXT`，界面给出可读说明且不显示“重试”；付费 OCR 显示“未配置”不可选。
7. 解析中（开发延迟 30 秒）强杀 Worker → 重启后第 1 次尝试记为 `lease_lost`、第 2 次成功。
8. 界面取消运行中的解析 → 任务 cancelled，Worker 收到租约丢失，尝试记为 cancelled。
9. 上传新版本（iCAN 计划书，20 页、18,779 字）→ 旧版本第 12 页分块哈希不变（`df5de2da…`），旧版本标“非当前版本”提示条。
10. 设备 B 登录同一账号看到同一资料库；375px 宽度下资料库、详情、阅读器均无横向滚动（修复导航换行后）。
11. 账号 B：对 A 的资料/版本/文件/文字/图片/任务/学科关联共 16 个探测全部 404，未登录 401；B 上传同一文件不提示重复；A 数据不变。
12. Worker 离线：上传成功，提示“暂未开始解析：解析服务暂时不可用”；重复上传提示已在资料库；Worker 恢复后点“开始解析”成功（纯文本解析器）。
13. 永久删除（2 个版本、1 个存活会话引用）→ 行与对象全部删除，会话 2 再读为空，课程与其学科关联保留；存储 key 与数据库引用一一对应（8 = 8）。

验收中发现并已修复：不可重试错误仍显示“重试”；被取消/栅栏后的尝试停留在“运行中”（Worker 补记 + 回收器清扫）；删除确认框把已删除会话计入；手机宽度导航换行。上线前又修复：Worker 在写完对象、提交之前崩溃会留下孤立对象（见决策 7；v23 尚未在任何持久环境执行，因此直接修改 v23，checksum 随之更新）。测试：PGlite 上模拟写完 artifact JSON 后进程冻结 → 过期回收 → 宽限期内不清扫 → 期后只删孤立对象、已提交 artifact 的 key 保留；真实 PostgreSQL 上以 `app_worker` 身份跑清扫（跨账号 RLS 下只删未被引用的 key）；账号删除清单包含待清扫 key。

### 遗留事项

- 付费 OCR（MinerU Cloud、AliDocMind）路径未做真实调用验证；开放前需配置、计费接入（`usage_events`/预算）并单独验收。
- Windows 本地字节存储不支持含冒号的 owner key（既有问题，生产用 S3 不受影响）；假模型服务器缺少 agent profile 的 id/difficulty，本地验收用了预设智能体。
- 未运行：Playwright e2e、生产镜像构建；未在部署环境演练开关与排空。
- 阅读器无划词/引用定位（B03）。（“解析图片不进入课程生成”已在 2026-10-06 后续中完成，见下。）

### 回退

- 运行时：取消 `ZHIYU_STUDY_MATERIALS_ENABLED`（Web 与 Worker）→ 资料库页面、接口、学科资料区与首页资料选择器隐藏，Worker 不再启动学习调度；B01 学科功能不受影响。只想停止接新任务时设 `ZHIYU_STUDY_TASKS_ACCEPTING=0`。
- 数据：v23 为纯新增，表与对象保留，旧镜像不读取它们；不回滚迁移。镜像回退按 B01 流程恢复 compose/env 备份。
- 已通过工作台引用的会话在开关关闭后仍能读取共享对象（读取路径不依赖开关）。

### 上线步骤（待用户指示，按 B01 流程）

1. 核对生产 `app_schema_migrations` v22 checksum = `01c9914f…`。
2. Supabase `apply_migration` 只执行仓库 v23 SQL（逐字相同），写入 `app_schema_migrations(23, 3fe42841…)`；核对 7 张新表 RLS 开启且强制、授权与本文一致、anon/authenticated 无授权；`app_internal.learning_task_readiness()` 可调用。**绝不对生产运行 `pnpm accounts:migrate`。**
3. 构建并发布镜像（开关先关）→ readiness ready、accountsVersion 23 → 确认 0 个未完成任务后切换 → 在 Web 与 Worker env 设置 `ZHIYU_STUDY_MATERIALS_ENABLED=1`（并发保持 1）→ apply → 检查 Worker 心跳出现 `#learning` 行、`capabilities.materials=true`。

### 生产发布（2026-10-05）

- 合并：main 快进到 `11113d2e`（含孤立对象修复）并推送 `tokyo`。
- 镜像：本地构建 `release-20261005c`（web `f76dfd12`、worker `4586cd52`）；两镜像内 `smoke-pi-runtime` 通过；worker 镜像内 unpdf 按页提取冒烟通过；`docker save | gzip | ssh docker load` 送到东京，镜像 ID 一致。
- 迁移：生产 v22 checksum 与仓库一致 → Supabase `apply_migration`（`accounts_v23_study_materials`，SQL 与仓库 v23 逐字相同；第一次调用因网络错误未执行，核对无任何对象后重试成功）→ `app_schema_migrations(23, 3fe42841…)`。核对：7 张新表 RLS 开启且强制；授权与设计一致，anon/authenticated 无授权；`heavy_task_capacity` 函数体 md5 与仓库 v23 一致。
- **顺带修正的历史差异**：迁移前生产的 `heavy_task_capacity` 与仓库 v11 不同（即已知的 v11 checksum 差异）：生产版本缺少“同步容量占用的 `independent:` 根算作本根已占用（inherited）”这一判断。仓库的托管函数与本地模式 SQL 从首次提交起都有这一判断，测试也按此断言；v23 替换函数后生产与代码一致。影响仅是同一同步根重入时不再被重复计数。
- 切换：服务器备份 `.env.hosted.local.bak-20261005c-pre`、`docker-compose.supabase.yml.bak-20261005c-pre`（指向 release-20261005b）；compose 更新为仓库版本（只多三项 B02 透传）；确认 0 个进行中的课程生成任务、智能体会话与学习任务后切换镜像（开关关）→ readiness ready、accountsVersion 23、liveWorkers 2/2、日志无错误 → 在 env 加 `ZHIYU_STUDY_MATERIALS_ENABLED=1` 后 apply → readiness 同上；三个容器内开关均为 1；两个 Worker 都有存活的 `#learning` 心跳（`learning-tasks-v1`）；`/api/study/capabilities` 返回 `{"spaces":true,"materials":true}`；未登录访问资料接口 401、资料库页面跳转登录。
- 未做：登录账号在生产上传/解析一份资料的端到端验收（需要用户登录）。
- 磁盘：加载新镜像后东京根分区 87%（剩 5.3 GB），建议清理更早的镜像（需用户同意）。
- 回退：恢复上述两份 `*.bak-20261005c-pre`（回到 release-20261005b，开关关）后 apply；或只删掉 `ZHIYU_STUDY_MATERIALS_ENABLED` 后 apply 隐藏功能。v23 表保留，旧镜像不读取。

### 后续：资料图片用于课程生成 + 后台生成素材修复（2026-10-06）

用户确认（2026-10-06）：课程生成可使用解析出的部分或全部图片；扫描件 OCR 暂不处理，继续只用 unpdf；删除旧镜像 `rollback-r1`、`release-20260926e`（已删，东京根分区 87% → 68%）。

1. **unpdf 能解析图片**：服务器默认的 unpdf 会提取 PDF 内嵌图片（验收的介绍 PDF：39 页、17 张图），解析结果早已按图片对象存储；本次只是把它们接入课程生成。
2. **实现（不改生成管线）**：资料文字接口 `GET …/versions/[versionId]/text` 增加 `images`（id、页码、宽高、描述、MIME，只给元数据，不暴露对象 key）。首页用学科资料开课时，`lib/study/materials/generation.ts` 把文字和图片按与直接上传相同的方式打包（`buildDocumentBundle`），按同样的视觉优先级（每份资料先取、再按页码和面积）最多取 60 张（`MAX_STUDY_GENERATION_IMAGES`，限制浏览器存储和后台逐张上传），经图片接口读取（固定到文字所属的解析结果）后存入浏览器图片库，生成会话的 `pdfImages`/`imageStorageIds` 与直接上传 PDF 完全同形。前台路径（imageMapping）和后台路径（逐张上传为生成素材）都原样复用；读不到的单张图片跳过、不让生成失败；图片存储失败时退回纯文字。
3. **发现并修复的两个既有生产缺陷（后台生成 + 上传素材）**：
   - 创建后台任务时要求素材字节存放在 PostgreSQL（`asset_blobs.bytes` 非空），而生产素材字节全部在 S3（2118 个 blob 全部为空），因此**任何带上传文件或图片的后台生成都会以 `BACKGROUND_MATERIAL_UNAVAILABLE`（422）失败**——生产历史上没有一个带素材的后台任务。修复：使用外部字节存储（S3 或本地文件适配器）时不再要求 PG 字节；素材登记表在外部存储中先写对象、后插入登记行，登记行本身即证明上传完成，Worker 读取时仍校验长度；他人的素材仍不可用。
   - 上传接口返回的 `digest` 是纯十六进制，而登记表的 `content_hash` 是 `sha256-<hex>`，创建任务时的比对对**所有上传文档**都不相等（与存储后端无关）；上传接口的去重查询也因此从未命中。修复：比对与去重都按 `sha256-<hex>` 进行。
4. **验证**：新增 `tests/study/material-generation-input.test.ts`（3：同形打包并固定解析结果、上限与优先级、无图片时纯文字）、`study-materials` 新用例（真实 unpdf 解析带图 PDF → 文字接口给出图片元数据、不含存储 key、他人读图 404）、`generation-jobs` 新用例 2 个（外部字节存储接受本人素材、PG 模式仍要求字节、他人素材拒绝；纯十六进制 digest 与 `sha256-` 登记匹配、错误 digest 拒绝）。本地托管模式（PostgreSQL 17 + 假认证/假 S3/假模型 + Worker，与生产同为 S3 素材存储）浏览器端到端：
   - 修复前：资料库开课上传 17 张图后创建任务 422；直接上传 PDF 开课同样 422（复现生产缺陷）。
   - 修复后：资料库开课 → 任务输入含资料文字（26,618 字）与 17 张图片、17 个输入素材，任务成功；直接上传 PDF 开课 → 任务含 1 个源文件，Worker 解析后成功。
   - 假模型不会选择图片，图片是否出现在幻灯片上取决于真实模型，与直接上传时的行为相同。
   - 本地验收环境已全部清理（临时 env、fixture、容器、账号文件删除，服务停止）。
   - 全量 Vitest：除新增改动触发的 provider 中立性守卫外全部通过；守卫问题已改为复用唯一的 S3 选择点（不新增厂商标识）后通过。真实 PostgreSQL 生成队列/容量回归 28 项通过。`tsc`、ESLint、Prettier、`build:worker`、`pnpm build` 通过。
5. **发布（2026-10-06，release-20261006）**：`c505e552`（修复）+ `ec431c58`（功能）快进到 main 并推送 tokyo；镜像 web `d18b5eb2`、worker `ccd0d117`，两镜像 smoke 通过，送到东京 ID 一致；无迁移。备份 `*.bak-20261006-pre`（指向 release-20261005c）；确认 0 个进行中的任务后切换 → readiness ready、accountsVersion 23、liveWorkers 2/2、日志无错误、`materials: true`；容器内素材存储为 S3（修复所依赖的配置）。回退：恢复两份 `*.bak-20261006-pre` 后 apply。
6. **生产实测发现的问题（2026-10-06，release-20261006b）**：用户在内置浏览器登录管理员账号后实测。资料上传、unpdf 解析（2 页、768 字、2 张图，1.6 秒）、图片接口、阅读器均正常；但带图片开课失败，提示“Generation service unavailable”。原因：生成素材上传接口有每账号 300 MB 的素材配额，而配额统计的是该账号的**全部**素材（包括已生成课程的图片/音频）；管理员账号已有 578 MB（1907 个素材），任何上传都被拒绝，且错误被当成服务故障（503）。这使资料库开课在加图片后对重度账号反而失败（之前纯文字可以）。修复：配额已满时上传接口返回 413 `ASSET_QUOTA_EXCEEDED`；后台生成在图片上传遇到配额已满时跳过剩余图片、照常用文字（和源文件）生成；源文件遇到配额已满仍失败，但界面显示可读说明（12 种语言）。**配额策略（是否只统计上传的材料、或提高上限）待用户决定。**
   - 发布：`a3aa5a3a` → release-20261006b（web `048fa080`、worker `23eb0722`），备份 `*.bak-20261006b-pre`（指向 release-20261006）；readiness ready、2/2、日志无错误。
   - 配额构成（管理员账号）：578 MB 中 575 MB 是课程生成产生的语音（1887 段），图片约 3 MB；生成本身不受配额限制，只有“上传课程材料”被拦。课程删除是软删除（`stage_meta.deleted_at`），素材不回收（生产 `ASSET_COLLECTION_ENABLED=false`），删课不会降低该统计。
   - 应用户要求（2026-10-06）删除管理员账号全部 45 门课程（软删除，内容仍在库中，可由运维恢复；清单保存在本地 `.scratch/prod-course-delete-20261006.txt`）；学科“高中数学”仍在，课程数 0；素材统计仍为 578 MB。

### 上传配额只计上传材料 + 删除课程物理清理（2026-10-06）

用户决定（2026-10-06）：配额选 A（只统计上传的材料）；删除课程要真正从数据库删除并自动回收存储；删除东京旧镜像 `release-20261003`、`release-20261004`（已删，磁盘 89% → 68%）。

1. **配额 A**：生成素材上传接口给每个上传打 `origin: generation-upload` 标记，300 MB 只统计带标记的上传（`lib/server/generation-jobs/upload-quota.ts`，同账号上传用 advisory lock 串行）；课程生成产生的语音、图片不再计入。旧上传没有标记，不计入。
2. **删除课程 = 物理清理**（`lib/server/courses/purge.ts`，Worker 每 5 分钟一轮，`COURSE_PURGE_ENABLED=1` 开启）：用户删除时仍立即隐藏并取消/隔离生成（原逻辑不变）；墓碑超过宽限期（默认 10 分钟）后，Worker 以 `app_worker` 身份删除该课程的页面、大纲、修订记录、生成任务全链路（steps/attempts/events/commands/scenes/job_assets/jobs/ownership）、运行会话，以及**只被这门课使用**的本人素材（任务输入/输出 + 课程内容中引用的 `ast_` id；被其他课程引用或属于他人的不删），并把这些素材的 blob 标记为无引用。
   - **保留一行极小的墓碑**：`document_stages` 行清空（无名称、内容只剩 `purgedAt`）连同 `stage_meta.deleted_at`。原因：墓碑负责拒绝旧设备用同一 id 保存或重建已删课程，删掉它课程可能被旧的本地副本“复活”。
   - 学科空间的课程链接/进度由 Web 角色所有，Worker 无权限，不在本次清理内（学科读取早已过滤已删课程，数据极小）。classroom 快照/媒体表在生产为空，未纳入。
3. **自动回收存储**：素材回收器只在 Worker 中开启（`WORKER_ASSET_COLLECTION_ENABLED`，`app_worker` 可删 blob；Web 角色不可，保持关闭）。修复：托管模式下回收器启动时不再执行 `ensureAssetSchema`（`app_worker` 在 public 无建表权限，真实 PostgreSQL 上复现为 permission denied——这也是此前回收一直未启用的阻碍）。回收器在宽限期后删除 S3 对象和 blob 行：生产开启了后台生成（`GENERATION_BACKGROUND_ENABLED=1`），宽限期下限为 24 小时（`lib/persistence/asset-collection-grace.ts`，保护排队输入与孤立写入），即删除课程约 24 小时后存储才真正释放。启用前只读核对：生产当前无引用为零的 blob 为 0，启用不会删除任何现有对象。
4. **存量已删课程**：`COURSE_PURGE_DELETED_SINCE` 只清理该时间之后删除的课程。上线时设为上线时刻，此前已删除的 143 门课程（含管理员刚删的 45 门）不自动清理——它们的清理不可恢复，由用户确认后自行删除该行并 apply 触发（见发布记录）。
5. **验证**：`tests/server/course-purge.test.ts`：PGlite 上清理范围（本课独占素材删除、共享/他人素材保留、墓碑保留、幂等、宽限期、截止时间）、配额只计上传；真实 PostgreSQL（全新托管 schema、RLS、修订触发器）以 `app_worker` 执行清理，并用生产同一工厂在托管模式下以 `app_worker` 运行回收器，成功回收被释放的 blob。
6. **发布（2026-10-06，release-20261006c，`b6ba667b`）**：web `d5c5485b`、worker `95315698`，两镜像 smoke 通过；备份 `*.bak-20261006c-pre`（指向 release-20261006b）；compose 更新为仓库版本（只多 Worker 的回收/清理变量）；env 增加 `WORKER_ASSET_COLLECTION_ENABLED=true`、`COURSE_PURGE_ENABLED=1`、`COURSE_PURGE_DELETED_SINCE=2026-10-05T18:20:00Z`。上线前只读核对：可回收 blob 为 0。readiness ready、2/2、日志无错误；Worker 容器内回收与清理开启、Web 容器关闭。
7. **生产复测（管理员账号，内置浏览器）**：用资料库中的测试讲义（2 页、2 张图）在测试学科开课 → 两张图片作为素材上传成功（配额 A 生效：此前因 578 MB 被拒），任务输入含 2 张图与 827 字文字，生成 3 页课程成功并自动关联到学科；第 2 页幻灯片直接使用了讲义中的“Figure 2: stretching by a”图。
8. **回退**：恢复两份 `*.bak-20261006c-pre` 后 apply（回到 release-20261006b，回收与清理关闭）。已清理的课程无法恢复。
9. **生产清理验证（2026-10-06）**：在管理员账号中通过页面删除测试课程（墓碑 03:09:36 UTC），Worker 于 03:20:41 清理：页面 3→0、大纲/修订/生成任务/ownership 全部删除，stage 行只剩 `purgedAt`，该课独占的 16 个素材（3.8 MB）删除并标记待回收；学科链接按设计保留。
10. **存量清理（用户确认，2026-10-06 03:21 UTC）**：备份 `.env.hosted.local.bak-20261006-pre-backlog-purge` 后删除 `COURSE_PURGE_DELETED_SINCE` 并 apply（readiness ready、2/2）。143 门已删课程（全部属于管理员账号）按每 5 分钟约 5 门清理；04:22 时已清理 79 门，待回收 706 个 blob / 231 MB，日志无失败事件。存储字节在 24 小时宽限期后由回收器删除（约 2026-10-07 03:20–05:40 UTC）。

### 下一批（B03）前置条件

- B02 已合并并上线；登录账号的生产端到端验收待做。**B03 在用户明确指示前不开始。**
- B03 的索引/检索任务作为 `learning_tasks` 的新 kind（新迁移修改 kind CHECK 与必要的新表），复用 `lib/server/task-queue/lease-queue.ts` 与学习调度，不新建队列。
- 索引以 `study_material_artifacts` 的按页分块（`readerBlocksForPage` / artifact JSON）为输入，引用定位回到“版本 + 页 + 块”；阅读器已能按页跳转，B03 再决定是否引入高亮库。
- 涉及模型调用（嵌入/答疑）时只经模型网关并带 FundingSource、计入 heavy-task 与配额；重新评估 `app_worker` 连接池（若并发 >1）。
- 付费 OCR 若要开放，先完成计费接入与真实验证。

### B02 最终校验（2026-10-05，Node 24.19.0）

- 全量 Vitest（`--maxWorkers=4`）：**851 个文件 / 8860 项通过，16 个文件、83 项跳过，0 失败**（B01 收尾后 847 / 8826）。
- 真实 PostgreSQL（一次性 `*_rls_proof`）：迁移与 bootstrap 19 项、生成队列/容量/账号删除回归 44 项，全部通过；容器已 `down -v`。
- `tsc --noEmit`：通过。`check:i18n-keys`：通过（12 个语言文件）。改动文件 ESLint：0 个问题；改动文件 Prettier：通过。
- `pnpm build:worker`：通过。`pnpm build`：通过，资料库 3 个页面与 13 个新增 `/api/study/*` 路由均已生成；唯一警告是 `unpdf` 经已有的 `material-extraction` → `pdf-providers` 服务端引用产生的 “Critical dependency”，非本批引入。
- 未运行：Playwright e2e、生产镜像构建。
- 孤立对象修复后复验：全量 Vitest **851 个文件 / 8861 项通过，0 失败**；真实 PostgreSQL 上 v23 迁移、全新 bootstrap 与账号删除 31 项通过；`tsc`、改动文件 ESLint/Prettier、`build:worker` 通过。

## B00 + B01 学科学习空间与继续学习

### 批次与范围

- B00：核对基线、运行时与工作区；建立本台账。
- B01：学科空间（创建、编辑、归档/恢复、删除）、课程关联（添加已有课程、移出、在学科中生成新课程并自动关联）、目标/考试日期/考试范围、服务端课程进度与跨设备继续学习、账号隔离、迁移、测试与浏览器验收。
- 明确不包含：资料库与解析（B02）、检索答疑（B03）、学伴（B04/B05）、学习事件与 Memory（B06）、题库/试卷（B07+）。学科页没有放置这些能力的占位入口。

### 开始时 HEAD / 工作区

- HEAD `9927cef2`（main，与 `tokyo/main` 一致）；分支 `learn/b01-spaces` 从此创建。
- 开始时已有未提交改动均保留、未纳入本批：`docs/adr/0019-adopt-model-gateway-on-pi-ai.md`、`docs/plans/2026-09-30-model-gateway-refactor.md`（各 1 行修改），未跟踪的 `docs/competition/` 竞赛材料、路线文档与实施方案两份文档。
- 运行时：Node 24.19.0（Codex 运行时目录；系统 Node 为 18，不满足 `engines >=22.19`），pnpm 10.28 锁定版本，依赖未重装。
- 基线：全量 Vitest（`--maxWorkers=4`）**840 个文件 / 8788 项通过，16 个文件跳过（需外部数据库的 `.pg` 等），0 失败**。

### 采用的设计决策与偏离原计划的原因

1. **数据模型**：accounts **v22** 新增 `study_spaces`、`study_space_courses`、`study_progress` 三张应用层表，不改 Stage DSL、不复制课程文档。链接表用 `(owner_id, space_id)` 复合外键保证链接与学科同属一个账号；链接和进度对 `document_stages` 外键级联，课程被硬删除（账号删除）时随之清理。
2. **隔离**：所有查询显式带 `owner_id`；托管库另有 FORCE RLS（仅 `app_web`，按 `app.owner_id`），且链接/进度写入的 `WITH CHECK` 要求课程是本人未删除的课程（`stage_meta`）。`app_worker` 无任何权限。账号删除在删除课程前删除三张表的本人数据。
3. **身份**：路由用 `withRequestOwnerId`（与 R2 新接口一致：托管模式解析已验证会话，并做 Origin 校验），再要求 owner 为 `user:{uuid}`；匿名设备 owner 返回 401 `STUDY_ACCOUNT_REQUIRED`，不写入共享匿名库。外人资源与不存在资源一律 404。
4. **开关**：服务端运行时开关 `ZHIYU_STUDY_SPACES_ENABLED`（默认关），同时要求云端课程库可用（`DATABASE_URL`）。前端通过 `GET /api/study/capabilities` 决定是否显示入口；关闭后页面与 API 隐藏、数据保留。
5. **接口路径**（相对方案第 7 节的微调）：进度放在 `/api/study/progress/[stageId]`，而不是 `/api/study/spaces/[id]/progress`。原因：进度属于“账号 × 课程”，同一课程可在多个学科中，挂在学科下会产生多份或歧义。另增 `GET /api/study/courses`（可添加的本人课程列表）。
6. **进度语义**：记录最后停留位置（场景、动作序号、动作 id、写入时场景 revision）、最远看到的页（单调）与“看到最后一页结尾”（一次成立后保留）。这是观看事实，不是课程完成，更不是掌握；界面文案为“学到第 n / m 页”“已看完”。“生成完成”单独由课程大纲判定（生成中课程显示“生成未完成”）。
7. **服务端校验与续播目标**：写入时服务端根据库中课程计算场景序号、动作数、动作 id 与 revision，不接受客户端声明；场景不存在 422、动作越界 422。读取时返回 `sceneChanged`/`sceneMissing` 与续播目标：已看完的场景续到下一页；场景被编辑则从该页开头；场景被删除则从课程开头。
8. **并发**：写入必须带上次看到的 `baseRevision`，不一致返回 409 和当前进度。客户端只有在自己的位置观察时间更新时才基于新 revision 重试，否则丢弃——旧标签页/迟到请求不会倒退覆盖，最新的真实学习操作胜出。学科编辑同样用 revision；编辑框只提交本次改动的字段，冲突后保留用户输入并提示。
9. **只上报学习者操作**：课堂打开时恢复本地位置也会触发进度回调，但它不是学习操作，若上报会把旧位置盖上新时间戳并覆盖其他设备。因此只在播放、切换页面、播完一页后上报；本地游标照旧即时保存。上报节流 3 秒，页面隐藏/离开时 keepalive 立即发送。
10. **跨设备继续**：学科页“继续/开始”打开 `/classroom/{id}?resume=study`，课堂加载前读取服务端进度（最多等 2.5 秒），若比本设备新就写入本设备的当前页与游标，再走原有加载与校验逻辑；其他入口不阻塞加载，若其他设备更新则以提示条提供“跳转”。
11. **在学科中生成课程**：学科页“生成新课程”带 `?studySpace=` 进入首页，首页显示“新课程将加入学科空间…”，生成会话记录该学科；生成交接到课堂时把（学科, 课程）放入按账号区分的本地待关联队列并立即尝试，课堂每次打开也会重试；服务端链接幂等，重试/重生成不会重复关联。
12. **学习事件**（方案第 7 步）：本批不新建 `learning_events` 表。`study_progress` 本身就是服务端保存的进度事实（含 revision、观察时间、最远页、看完时间），B06 可从它投影事件；遵循“只在对应批次需要时增加模块”。
13. **旧部署模式**：未启用托管账号的自迁移安装在启动时（与 `owner_material` 相同位置）和 `generation:migrate` 中创建同样的表（无 RLS，靠显式 owner 过滤）。表结构文本 `STUDY_TABLES_SQL_V22` 随 v22 checksum 冻结，后续修改须走新迁移。
14. **上限**：每账号 100 个学科，每学科 200 门课程；名称 60 字、学科 60 字、目标 500 字、考试范围 2000 字；考试日期为日历日期，倒计时按学科时区计算。
15. **开发工具**：新增 `scripts/dev-fake-supabase-auth.ts`（仅开发，绑定 127.0.0.1，只接受本地数据库），用于后续批次的“两个账号 + 多设备”浏览器验收。

### 实际改动模块

- 迁移与账号：`lib/server/accounts/sql-study-spaces.ts`（v22）、`migrations.ts`、`sql-accounts.ts`（版本 22）、`deletion.ts`、`lib/persistence/server-provider.ts`、`workers/generation/migrate.ts`、`lib/server/study/schema.ts`。
- 服务端：`lib/server/study/route.ts`、`lib/server/study/spaces/repository.ts`、`app/api/study/**`（capabilities、spaces、spaces/[spaceId]、courses、progress/[stageId]）。
- 共享契约与客户端：`lib/study/spaces/{contracts,client,view-model,pending-links}.ts`、`lib/study/progress/{sync,resume,classroom-resume}.ts`。
- 页面：`app/study/page.tsx`、`app/study/[spaceId]/page.tsx`、`components/study/spaces/*`；首页入口与生成目标横幅（`app/page.tsx`）；课堂续播（`app/classroom/[id]/page.tsx`）；播放进度上报（`components/edit/PlaybackChromeRoot.tsx`，只增量挂钩）；生成交接关联（`app/generation-preview/*`）。
- 文案：12 个语言文件新增 `study.*`；`CONTEXT.md` 增加“学科空间”“学习进度”术语；`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml` 增加开关说明与透传。

### 数据迁移版本与执行环境

- accounts **v22**，checksum `01c9914fb8643bdd6cc3a7bfc02389785b174327b0f3c5196212401e38fd3fb0`（v21 为 `a13fa31d…`，与生产记录一致）。
- 已执行环境（均为一次性本地实例，已销毁）：PGlite（单测）；PostgreSQL 16（`*_rls_proof` 容器，跑 v22 RLS 测试）；PostgreSQL 17 按生产历史顺序（v1–v4 → 生成/文档基础表 → v8–v22，跳过 v5–v7）完整应用，三张表均 `relrowsecurity = relforcerowsecurity = true`。
- **未在预发布或生产执行**。生产启用时按现有流程：先核对生产 v21 checksum，再用 `apply_migration` 只执行 v22 SQL 并写入 `app_schema_migrations(22, 上述 checksum)`；不要对生产运行 `pnpm accounts:migrate`。迁移完成并发布新镜像后，再设置 `ZHIYU_STUDY_SPACES_ENABLED=1`。

### 已执行测试及结果

- 新增：`tests/server/study-spaces-repository.test.ts`（8）、`tests/server/study-spaces-migration.test.ts`（PGlite 2 + 真实 PostgreSQL 2）、`tests/api/study-routes.test.ts`（5）、`tests/study/progress-sync.test.ts`（7）、`tests/study/spaces-client-logic.test.ts`（10）。
- 调整：`tests/auth/principal-mode.test.ts`（迁移版本列表）、`tests/server/account-deletion-lifecycle.test.ts`（删除三张表且只删本人）、`tests/persistence/route.test.ts`（与其他 schema 一样 mock `ensureStudySchema`）。
- `tsc --noEmit` 通过；`check:i18n-keys` 通过；改动文件 ESLint 无新问题；改动文件 Prettier 通过。
- 全量 Vitest：见“最终校验”一行（本文末尾）。

### 用户可复现的验收步骤与证据（2026-10-05，本地托管模式）

环境：一次性 PostgreSQL 17（托管形态 schema，`zhiyu_app_web` 登录角色，RLS 生效）+ `scripts/dev-fake-supabase-auth.ts` + `next dev`（`AUTH_MODE=supabase`）+ 本地假模型服务器；临时 `.env.development.local` 清空了 `.env.local` 中全部真实密钥与生产地址，测试后已删除。“设备 A”为 `localhost:3100`，“设备 B”为 `127.0.0.1:3100`（不同 origin，cookie、localStorage、IndexedDB 互不共享）。课程通过真实的 owner-bound 文档存储以 `app_web` 身份写入。

1. 账号 A 登录 → 首页出现“学科空间”入口 → 空状态 → 用表单新建“高等数学”（大学、数学、2027-01-08、目标）→ 进入学科页，显示“距考试 95 天”。
2. “添加已有课程”只列出账号 A 的 5 门课（B 的课程不出现，生成中的课程标“生成未完成”）→ 添加 2 门；再建“数据结构”并关联 2 门 → 两个学科各 2 门课。重复添加返回 `created:false`；把 B 的课程加入 A 的学科返回 404。
3. 设备 A 从学科页“开始”进入课堂，切到第 3 页并播完 → 服务端进度：第 3 页已看完、续播目标第 4 页、revision 3。
4. 设备 B 登录同一账号 → `/study` 显示“继续学习：学到第 3 / 4 页” → 点“继续” → 课堂直接打开第 4 页。
5. 竞争：设备 B 播放第 4 页（revision 5，标记已看完）；仍停在旧 revision 3 的设备 A 标签页切到第 2 页 → 先 409，再因其操作更新而基于 revision 5 重试成功（revision 6）。用旧 revision + 更早时间的写入 → 409，服务端仍为第 2 页、revision 6；不存在的场景 → 422。“已看完”保持不变。
6. 账号 B 登录设备 B：学科列表为空；读取/修改/删除 A 的学科、往 A 的学科加课、从 A 的学科移课、读写 A 的进度，全部 404；B 只能把自己的课加入自己的学科。未登录请求 401。数据库核对 A 的数据未变。
7. 在“高等数学”中“生成新课程” → 首页显示“新课程将加入学科空间‘高等数学’” → 用假模型生成一节课（模型请求只到本地假服务器）→ 交接到课堂时自动关联（`addedVia: generation`），待关联队列清空；首页课程列表仍正常、新课堂可打开播放。
8. 编辑冲突：编辑框打开期间另一标签页改了目标 → 保存提示“已在其他页面修改，已显示最新内容”，用户填写的考试范围保留 → 再次保存后两处修改都在（revision 4）。
9. 移出课程（确认框说明课程与进度保留）→ 课程仍在“可添加课程”中；“数据结构”归档（显示已归档、隐藏添加/生成）→ 删除（确认框）→ 返回列表，3 门课程仍存在且不属于任何学科。
10. 非“继续”入口：账号 B 在设备 B 学到第 2 页后，在设备 A 直接打开该课 → 课堂按本设备位置打开，并提示“你在其他设备上学到了第 2 页 · 跳转” → 跳转后到第 2 页。
11. 刷新、换页后数据均从服务端读回；手机宽度（375px）学科页无横向滚动。

### 未验证项目 / 已有问题

- 未验证：预发布/生产 Supabase 上的迁移与开关；生产构建镜像中的行为；`NEXT_PUBLIC_PI_CHAT_ENABLED` 等其他开关组合下的课堂（本批未改聊天路径）；后台生成（Generation Worker）路径下的“在学科中生成”（只验证了前台生成；后台路径的交接代码同样调用关联，但未在浏览器跑）；场景被编辑后“从该页开头继续”的提示（由仓储与决策单测覆盖，未在浏览器复现）。
- 已知限制：在另一个浏览器会话中恢复的后台生成任务没有学科上下文，不会自动关联（可在学科中手动添加）；Pro 工作台生成的课程不自动关联；他人公开课程不记录服务端进度（托管 RLS 下 `app_web` 读不到他人文档），仍只有本设备游标；设备时钟相差很大时，“谁更新”按客户端观察时间判断。
- 验收时发现的已有问题，已在“收尾修复”中处理：托管模式控制台 `KVPersist Refusing to persist "settings-storage"`；`app/page.tsx` 的 `exhaustive-deps` 警告；`PlaybackChromeRoot.tsx` 的 Prettier 问题；全新数据库上 `migrateAccountsSchema` 在 v8 失败。
- 仍保留的开发环境现象：两种生成模式都关闭的开发配置下，浏览器会反复重试一条待撤销的媒体配置（`DELETE /api/agent/media-config-snapshots` 404）。生产为后台生成模式，该接口可用，不受影响；未改动。

### 回退方法

- 运行时：取消 `ZHIYU_STUDY_SPACES_ENABLED`（服务端开关，无需重建）→ 首页入口、`/study` 与全部 `/api/study/*` 隐藏；课堂恢复为只用本设备游标，播放上报自动停止（能力检查失败即不发送）。
- 数据：三张表与数据保留，不回滚迁移（v22 为纯新增，旧版本应用不读取这些表）。
- 演练情况：开关关闭时的 404/隐藏由路由单测覆盖；未在部署环境演练。

### 收尾修复（2026-10-05，同分支）

1. **全新数据库迁移链**：合入 `pnpm accounts:bootstrap-fresh`（`lib/server/accounts/fresh-bootstrap.ts`，说明见 `docs/guides/zhiyu-fresh-accounts-database.md`）。按生产顺序（v1–v4 → 基础表 → FORCE RLS → v8+，跳过 v5–v7）在一个事务内建库，拒绝生产项目、已有迁移记录或已有数据的库；迁移 SQL 与 checksum 不变。本分支上它同样创建学科表（与 `generation:migrate` 顺序一致）并应用到 v22；PGlite 与真实 PostgreSQL 17 上测试通过。
2. **托管模式账号设置不加载**（验收时看到的 `KVPersist` 报错的根因）：账号级本地存储（设置、个人资料）的命名空间取决于登录账号，模块加载时账号未知，读取失败；之前只能靠一次被拒绝的写入触发恢复。设置因此晚加载并报错，**个人资料（昵称、头像）在托管模式下根本不加载**。现在账号确认后、页面渲染前统一重新读取一次（`lib/store/account-stores.ts`，由 `AuthAppShell` 调用，每个账号一次）。浏览器验证：报错消失、已保存的昵称正确显示；临时去掉修复后报错与昵称丢失复现。
3. `app/page.tsx` 用 `useEffectEvent` 消除 `exhaustive-deps` 警告（行为不变）；`PlaybackChromeRoot.tsx` 按 Prettier 重排一行。
4. **生产 checksum 核对（只读）**：生产 `app_schema_migrations` 中 v1（`63a43e9e`）、v8（`b4d86d19`）、v11（`f7dc2b52`）与仓库 SQL 的 checksum 不同（仓库为 `3ddb7580`、`92f685a3`、`5cf41487`），v2–v4、v9–v10、v12–v21 一致。这是早期已应用迁移的文本后来被改动造成的历史差异，线上不受影响；但再次说明**绝不能对生产运行 `migrateAccountsSchema` / `pnpm accounts:migrate`**（会在 v1 报 checksum 不符）。上线新版本时只核对最新一版（当前 v21 = `a13fa31d`，一致）。

### 与原方案不同之处的处理原则

经用户确认（2026-10-05）：**以实际项目代码为准**，原方案只要求逻辑相同或相近。上文“设计决策”中的偏离（进度接口挂在 `/api/study/progress/[stageId]`、本批不建 `learning_events` 表等）即为后续批次的基准，后续批次不需要再改回方案原写法。

### 生产发布与验收（2026-10-05）

- 发布：main 快进到 `a1a0a7b6` 并推送 `tokyo`；本地构建镜像 `release-20261005`（两镜像 smoke-pi-runtime 通过；依赖与构建配置相对 R2 镜像无变化），`docker save | gzip | ssh docker load` 送到东京。
- 迁移：生产 v21 checksum 与仓库一致 → Supabase `apply_migration`（`accounts_v22_study_spaces`，SQL 与仓库 v22 逐字相同）→ `app_schema_migrations(22, 01c9914f…)`；核对三表 RLS 开启且强制、仅 `app_web` 有增删改查、anon/authenticated 无授权。
- 服务器：备份 `.env.hosted.local.bak-20261005-pre-b01` 与 `docker-compose.supabase.yml.bak-20261005-pre-b01`；compose 更新为仓库版本（与 R2 版本相比只多开关透传）；确认 0 个未完成 generation_jobs 后切换镜像（开关关）→ readiness ready、accountsVersion 22、liveWorkers 2/2、日志无错误 → 再开启开关并 apply → readiness 同上，`/api/study/capabilities` 返回 `spaces: true`。
- 用户管理员账号在线验收（内置浏览器，用户自行登录）：首页出现“学科空间”入口；空状态 → 新建“验收测试学科”（考试倒计时 95 天）；“添加已有课程”列出该账号全部 45 门课程（未完成课程标“生成未完成”）并添加 2 门；编辑考试范围后刷新仍在；从学科页“开始”进入课堂并切到第 2 页 → 服务端进度立即为第 2 / 4 页（revision 1）→ 学科页显示“学到第 2 / 4 页”；删除本机该课程的位置记录后点“继续”，课堂直接打开第 2 页（模拟另一台设备）；“生成新课程”进入首页显示学科横幅（未实际生成，避免模型费用）；个人资料简介写入后刷新能正确读回（昵称/头像修复在生产生效），随后已清空；控制台不再出现 `KVPersist` 报错。
- 说明：课堂底部计数“2 / 5”包含播放器原有的完成页（奖杯），课程实际 4 页，学科页显示“/ 4”正确。首页有两门旧课程的封面图片资源不存在（404），为历史数据，与本批无关。
- “移出课程”与“删除学科”在验收时被本地自动权限检查拦截，未由 Claude 在生产点击（已由仓储/路由测试与本地浏览器验收覆盖）；测试学科随后由用户自行删除。
- 回退：恢复上述两份备份（镜像回到 release-20261004）后 apply；或只取消 `ZHIYU_STUDY_SPACES_ENABLED` 后 apply 隐藏功能。v22 表保留。
- 后续热修（2026-10-05，release-20261005b，镜像来自 `fa2c1b10`）：生成页“生成教学动作”一栏在逐页生成的间隙不再退回静止状态（只要已有页面完成教学动作，即保持进行中直到全部完成）。无迁移、compose 与依赖变化；两镜像 smoke 通过；确认 0 个未完成任务后切换；readiness ready（accountsVersion 22、liveWorkers 2/2），三个容器日志无错误。备份 `*.bak-20261005b-pre`（指向 release-20261005）。上线后用户已在生产自建学科“高中数学”、在学科中生成课程并自动关联，学科页显示进度“学到第 3 / 8 页”；验收用的测试学科已由用户删除。

### 下一批（B02）前置条件

- B01 已合并并上线（见上）。**B02 及之后批次在用户明确指示前不开始。**
- 后台任务队列（方案 12.1）：**已决定（用户确认，2026-10-05）采用方案一，泛化现有 generation-jobs 的租约/限流/恢复机制，不引入 pg-boss，也不引入 Redis/BullMQ**。理由：现有实现已有租约、心跳、`SKIP LOCKED` 认领、限流、所有权、恢复，并已接入 RLS（`app_worker`）、账号删除、heavy-task 并发与配额、停止接单和生产部署；pg-boss 会多一套 schema 与连接池，表要另外接 RLS、账号删除和 heavy-task 统计，东京 `app_worker` 连接池预算也要重算。容量瓶颈在模型调用费用/限流和 Worker 数量，而不是 Postgres 队列本身；用户增长时先加 Worker 副本和按任务种类的并发上限。B02 实施时须遵守的架构约束（与方案 3.2/3.3 一致）：
  1. **独立契约，共享机制**：新建 `learning_tasks`（及任务调用明细）表与自己的任务契约（ownerId、rootTaskId、kind、idempotencyKey、status、lease、attempt、budget、usageCompleteness），不把解析等任务塞进课程生成的 `generation_jobs` 契约；把租约认领、心跳、过期回收、重试退避等通用部分从 `lib/server/generation-jobs/repository.ts` 抽成两者共用的模块，课程生成行为保持不变（有回归测试兜底）。
  2. **同一套 Worker 进程与部署**：任务由现有 generation worker 进程按 kind 分派执行，不新增服务；`app_worker` 连接池预算按新增并发重算后再上线。
  3. **全部纳入现有治理**：新表走版本化迁移（v23 起）+ FORCE RLS + 只授予 `app_web`/`app_worker` 所需权限、账号删除、heavy-task 并发统计（SQL 计数覆盖新表）、个人/站点配额、公平调度、停止接单与排空；模型调用只经模型网关并带 FundingSource。
  4. **只做当批需要的任务种类**：B02 只实现资料解析/索引所需 kind；后续批次在同一张表上追加 kind，不再新建第二套队列。
- 资料表与 `study_space_materials` 作为 B02 新迁移追加（v23 或当时最新），不修改 v22。

### 最终校验（2026-10-05，Node 24.19.0）

- 全量 Vitest（`--maxWorkers=4`）：**845 个文件 / 8820 项通过，16 个文件、83 项跳过，0 失败**（基线 840 / 8788；新增 5 个文件、32 项）。
- `tsc --noEmit`：通过。`check:i18n-keys`：通过（12 个语言文件）。
- 改动文件 ESLint：0 个新问题（仅 HEAD 已有的 `app/page.tsx` `exhaustive-deps` 警告）。改动文件 Prettier：通过（`PlaybackChromeRoot.tsx` 在 HEAD 已不符合 Prettier，本批未重排其无关行）。
- `pnpm build:worker`：通过。`pnpm build`（Next 生产构建）：通过，`/study`、`/study/[spaceId]` 与 7 个 `/api/study/*` 路由均已生成。
- 未运行：Playwright e2e 套件（本批浏览器验收为上文手动流程）；生产镜像构建。
- 收尾修复后复验（2026-10-05）：全量 Vitest **847 个文件 / 8826 项通过，0 失败**（新增 `accounts-fresh-bootstrap`、`account-stores` 两个文件）；`accounts-fresh-bootstrap` 与 `study-spaces-migration` 在真实 PostgreSQL 17 上 11 项全过；`tsc --noEmit`、改动文件 ESLint/Prettier、`next build` 通过；托管模式浏览器复验见“收尾修复”第 2 条。
