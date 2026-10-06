# 智域学习功能批次状态

依据：[后续功能规划](2026-09-27-zhiyu-learning-feature-roadmap.md)、[分批实施方案](2026-09-27-zhiyu-learning-implementation-plan.md)（第 9.4 节台账模板）。
本文只记录实际完成和实际验证过的内容；“实现完成”不等于已合并、已预发布验收或已上线。

| 批次 | 实现状态 | 分支 / PR | 合并 commit | 预发布验收 | 生产启用 | 遗留事项 |
| --- | --- | --- | --- | --- | --- | --- |
| B00 | 完成（基线与台账） | `learn/b01-spaces` | `a1a0a7b6`（main） | 不适用 | 不适用 | — |
| B01 | 已上线（2026-10-05，release-20261005） | `learn/b01-spaces` → main（快进，已推送 tokyo） | `a1a0a7b6` | 无预发布环境，生产按开关灰度 | 已启用 `ZHIYU_STUDY_SPACES_ENABLED=1` | 见“生产发布与验收” |
| B02 | 已上线（2026-10-05，release-20261005c） | `learn/b02-materials` → main（快进，已推送 tokyo） | `11113d2e` | 本地托管模式验收通过（见 B02 节） | 已启用 `ZHIYU_STUDY_MATERIALS_ENABLED=1` | 见 B02“遗留事项” |
| B03 | 已上线（2026-10-06，release-20261006d；同日 20261006e 隐藏未配置的 OCR 选项） | `learn/b03-grounded-qa` → main（快进，已推送 tokyo） | `f7f87190` | 本地托管模式验收通过（关键词模式复验）；真实模型评测完成；生产登录验收通过 | 已启用 `ZHIYU_STUDY_QA_ENABLED=1`（关键词模式，未配置 embedding） | 见 B03“未验证” |
| B04 | 已上线（2026-10-06，release-20261006f） | `learn/b04-classmates` → main `733888b1`（已推送 tokyo） | accounts v25 已在生产执行 | 本地托管模式 + 真实模型验收通过；生产登录后验收通过（2026-10-06） | 已启用 `ZHIYU_STUDY_CLASSMATES_ENABLED=1` | 见 B04“已知问题” |

## 全部批次完成后再做：embedding 与 OCR（用户决定 2026-10-06）

- 先完成全部待完成批次；期间检索保持纯关键词、资料只支持文字版 PDF，不接 embedding 模型与 OCR。
- 之后接入：embedding 选 **Qwen3-Embedding-0.6B** 或其他小模型（0.6B 输出 1024 维，可直接用 v24 的向量列与 `STUDY_EMBEDDING_MODEL` 开关）；OCR 选 **RapidOCR** 或其他较小的 OCR（作为 `lib/pdf` 文档提取器的新 provider）。具体用法（自托管/API、资源与费用）届时再讨论。
- 接入后补做原计划中依赖它们的任务：B02 扫描版解析、B03 混合检索、B05 语义答疑、B08 扫描资料习题提取、OCR 用量展示。详见[实施方案](2026-09-27-zhiyu-learning-implementation-plan.md)第 13 节。

## B04 自定义学伴与课堂接入（2026-10-06）

### 范围与起点

- 分支 `learn/b04-classmates` 从 main `77811b87`（= `tokyo/main`，含 B03 全部后续）创建；生产为 release-20261006e、accounts v24。
- 范围：服务端学伴模板的增改、归档/恢复与 revision；表单（姓名、角色、头像、性格、陪学方式、发言规则、声音、可用资料）；把模板投影到浏览器 registry；为新课堂冻结学伴快照；覆盖首页前台生成、首页后台生成与 Pro `submit_course_generation`；两条课堂聊天路径（LangGraph Director `/api/chat`、Pi Director `/api/chat/pi`）执行一致的发言规则；本机旧角色一次性导入；账号删除清理。
- 不包含：B05 课后答疑与持续会话（资料授权在 B04 只保存，不参与检索）、学伴独立模型策略（B05）、embedding / OCR（见“全部批次完成后再做”）、DiceBear 头像生成。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

- **模板 + 不可变版本快照**：`study_classmates` 保存当前模板，每次保存（含归档/恢复、改资料）revision + 1，并在同一事务写入 `study_classmate_revisions` 的该版本快照（姓名、角色、人设、陪学方式、发言规则、头像、颜色、声音）。Web 角色对快照表只有 SELECT/INSERT，历史不可改。
- **课堂里只放快照，不引用活模板**：新课堂把用户选中的整份角色表冻结到 `stage.generatedAgentConfigs`，学伴以 `<学伴ID>-r<版本>`（如 `cm-…-r5`）为课堂角色 ID；人设 = 用户填写的性格 + 陪学方式对应的固定提示规则。之后编辑、换头像、归档模板都不改已生成的课；别的设备打开课堂也直接读快照。系统教师等内置角色在快照中保留原 ID，加载时继续使用代码内置条目（修复了“含 `default-*` 的角色表加载后把内置教师替换成生成副本、下一门课时被删掉”的既有问题）。
- **不新增绑定表**：方案中的 `classmate_stage_bindings` 由“课堂角色 ID 本身编码模板与版本 + 不可变版本表”代替——任何课堂角色都能在服务端追溯到确切的模板版本，无需在生成时（前台/后台/Pro 三条路径时机不同）额外写一行。
- **发言规则在服务端执行，两条路径一致**：`正常参与`（老师可按需请它发言）/`仅点名时发言`。两个聊天路由在 Director 运行前按快照 ID 读取该版本（owner 隔离），把未被点名的“仅点名”学伴从本次请求的角色里移除；被点名的学伴记为服务端字段 `addressedAgentId`（丢弃客户端传入值），LangGraph 首轮直接调度它，Pi 的 `call_agent` 允许它先于老师回答（其余仍是“老师先答”），两边提示词都加一句说明。学伴的角色与可用动作也按快照重置，人设不能扩大权限。没有学伴角色的请求不访问数据库；查不到/查询失败时按原请求处理（发言规则是对话体验，不是访问控制）。
- **角色只能是助教/同学**：老师仍由系统担任；每门课最多 3 个学伴；每个账号最多 30 个模板（含归档）。
- **头像**：12 个内置头像或上传（浏览器裁成 128px WebP/PNG，服务端按文件头校验类型、≤ 96 KB、按内容去重、每账号 ≤ 60 张），存数据库 `study_classmate_avatars`，经 `/api/study/classmates/avatars/<id>` 只给本人；每次使用都重新鉴权（`private, no-cache` + ETag/304），同一浏览器换账号不会读到缓存。
- **声音**：只能从当前可用的音色目录里选（与首页角色栏同一来源，不含仅本机有效的浏览器音色），保存为现有的 `voiceConfig` 结构；不触发克隆或付费生成。Pro 中只有本次会话音色目录里存在的声音才会带上。
- **registry 投影**：登录账号的有效模板只在内存里投影为首页“预设模式”中的“我的学伴”分组，不写入设备级 localStorage；换账号先清掉上一账号的投影。
- **Pro**：新增只读工具 `list_classmates`；`submit_course_generation` 新增 `classmateIds`，服务端按当前版本补进角色表（模型给了 agents 就追加，没给就用系统教师 + 学伴），模型不复制人设/头像/声音；未知或已归档 ID 拒绝、不建任务。Pro 运行在 Worker，Worker 对模板与版本表只读（按 owner 显式过滤）。
- **开关**：`ZHIYU_STUDY_CLASSMATES_ENABLED`（Web 与 Worker 都读），依赖学科空间；`/api/study/capabilities` 增加 `classmates`。

### 偏离方案之处

- 不建 `classmate_stage_bindings` 表（理由见上）。
- 头像默认值用仓库内置头像，没有引入 DiceBear。
- 首页“自动生成”模式不带学伴（界面有提示）：学伴只在“预设模式”中选择，用户选的角色表即最终角色表，不会被自动生成覆盖。
- Pi 路径“被点名学伴先答”在代码中允许、由 Director 提示执行；LangGraph 路径在代码中直接调度。不被点名的学伴在两条路径都由代码排除。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-classmates.ts`（v25，4 张表）、`migrations.ts`、`sql-accounts.ts`（版本 25）、`lib/server/study/schema.ts`（旧式安装）、`deletion.ts`（账号删除）。
- 服务端：`lib/server/study/classmates/{repository,speech-policy}.ts`、`lib/server/study/{flags,route}.ts`、`app/api/study/classmates/**`（列表/新建、单个读取/修改、导入、头像上传/读取）、`app/api/study/capabilities`、`app/api/chat/route.ts`、`app/api/chat/pi/route.ts`、`lib/orchestration/director-graph.ts`、`lib/chat/pi/{prompts.ts,tools/call-agent.ts}`、`lib/server/agent-runtime/{classmate-tools,generation-job-tools,runner}.ts`。
- 共享/前端：`lib/study/classmates/{contracts,speech,roster,client}.ts`、`lib/orchestration/registry/{types,store}.ts`、`lib/generation/session-input.ts`、`app/generation-preview/GenerationSessionController.tsx`、`components/agent/agent-bar.tsx`、`components/study/classmates/*`、`app/study/classmates/page.tsx`、`StudyShell` 导航、12 个语言文件。
- 开发工具：`scripts/dev-fake-model-server.ts` 可驱动 Pi Director（`call_agent`/`cue_user`）。

### 数据迁移

- accounts **v25**，checksum `d6bdefd18c125d63d5df8d159a93287c91f9fe26eff7e3edc2c3aa4159725a89`；只新增表，不改旧迁移。四张表 RLS 开启且强制，anon/authenticated 无授权；Web：模板与资料关联可增删改，版本与头像只能读/插入；Worker：只读模板与版本。
- 已在本地一次性 PostgreSQL 17（带扩展）用全新 bootstrap 执行 v1–v25 验证。**生产尚未执行**；上线时按 B01–B03 流程只用 Supabase `apply_migration`，绝不对生产运行 `pnpm accounts:migrate`。

### 测试

- 新增：`tests/study/classmates-logic.test.ts`（校验、快照 ID、人设组合、角色表冻结、发言规则）、`tests/server/study-classmates.test.ts`（仓储：版本快照、冲突、归档、资料与头像归属、上限、导入去重）、`tests/server/study-classmates-migration.test.ts`（v25：可重复执行、强制 RLS、Web 隔离与历史不可改、Worker 只读；设 `TEST_STUDY_CLASSMATES_DATABASE_URL` 可在真实 PG 上重跑）、`tests/server/classmate-speech-policy.test.ts`（服务端规则、Pi 提示、LangGraph 首轮调度）、`tests/agent-runtime/classmate-tools.test.ts`（Pro 工具与提交）、`tests/api/study-classmates-routes.test.ts`（API 端到端，含头像 304）；扩充 registry、后台生成输入、Pi `call_agent`、账号删除、迁移版本列表等既有测试。
- 全量 Vitest（`--maxWorkers=4`）：**862 个文件通过、17 个文件跳过；8942 项通过、94 项跳过，2 项失败**——`principal-mode` 的迁移版本列表未含 25（已更新，单独重跑 25 项通过）；`golden-replay`（模型网关特征回放）全量负载下失败、单独重跑通过，与本批无关。
- `tsc --noEmit` 通过；本批改动的 55 个 TS/TSX 文件 ESLint 0 问题（仓库其余位置既有 159 个错误未处理）；Prettier、`check:i18n-keys`（12 个语言文件）通过；`build:worker` 通过且 Worker 可启动。

### 浏览器验收（2026-10-06，本地托管模式）

一次性 PostgreSQL 17（v1–v25）、假登录、假模型、假 S3、生成 Worker；环境文件把 `.env.local` 的全部变量置空，无真实密钥或生产地址。设备 A = `localhost:3100`，设备 B = `127.0.0.1:3100`（不共享 cookie）。

1. 账号 A 在 `/study/classmates` 用表单新建中文名学伴“小林”（同学、提问引导、仅点名时发言）→ 第二设备登录同一账号，列表读回一致。
2. 首页“预设模式”出现“我的学伴”分组与“管理学伴”入口 → 勾选小林；设备 localStorage 的 registry 快照里没有学伴。
3. **后台生成**一门课 → 课堂文档角色表 `default-1/2/3 + cm-…-r1`，人设含陪学规则；课堂里显示小林。
4. **LangGraph 课堂提问**：不点名 → 只有老师回答；“小林，你觉得…” → 小林先回答。
5. 编辑模板（改名“小林同学”、上传头像、改为正常参与）→ 归档 → 重新打开旧课：仍显示“小林”与原头像，仍按 r1 的“仅点名”规则只让老师回答。
6. 账号 B：学伴列表为空；读取/修改 A 的学伴、读取 A 的头像均为 404。
7. 界面恢复归档、用编辑表单改回“仅点名”（v5）→ **前台生成**另一门课 → 角色表 `default-1 + cm-…-r5`，带上传头像；第一门课仍是 r1。
8. **Pi 课堂提问**（`NEXT_PUBLIC_PI_CHAT_ENABLED=true`）：不点名 → 服务端请求角色只剩 `default-1`，老师回答；点名 → 小林先回答。（首次验收发现 Pi 的 `call_agent` 代码强制“老师先答”，会拒绝被点名的学伴，已修复。）
9. 真实 PostgreSQL 上核对权限：Worker 能读模板/版本，读头像与改模板被拒；Web 角色未设 owner 时看不到任何行，改版本快照被拒。
10. 验收后停止全部服务，删除数据库容器、环境文件、测试账号密码文件与假 S3 数据。

### 真实模型补充验收（2026-10-06 晚，用户要求）

本地托管模式同上，但文本模型与 TTS 改用真实服务：平台默认文本模型 DeepSeek `deepseek-flash`、平台默认 TTS MiniMax `speech-2.8-turbo`（`.env.local` 中的 key 只由开发服务器从 `.env.local` 读取、Worker 从启动进程的环境变量取得，临时环境文件里没有任何 key；课堂聊天走生产同款 LangGraph 路径）。总花费约 0.03 美元（DeepSeek）加少量 MiniMax 字符。

1. **Pro 真实模型会主动调用学伴工具**：两次 Pro 会话都只说“带上我的学伴小林”，模型自己先调 `list_classmates`，再在 `submit_course_generation` 里带 `classmateIds: ["cm-…"]`；冻结的角色表含 `cm-…-r1`/`cm-…-r2`，人设带陪学规则。第一次提交多写了一个 `title_en` 字段被原有 schema 拒绝，模型自行去掉后重交成功。模型还自行加了一个“小助手”助教，与学伴并存。
2. **发现并修复：Pro 丢掉学伴声音**。表单把所有非平台音色都标成“用户自己的 key”，而这台环境里 MiniMax 由平台默认提供，Pro 会话的音色目录对不上，学伴的声音被丢弃。改为按媒体快照同样的规则判断凭据归属（与平台默认 TTS 的服务商和模型相同 → 平台；服务器配置且用户没有 key → 服务器托管；否则用户自己的），Pro 会话也把所有有效学伴的声音放进音色目录。修复后第二次 Pro 课程的 `cm-…-r2` 带上了 `female-shaonv` 平台音色。生产目前只有用户自带 key，原来的标记在生产恰好是对的，此修复针对配置了平台默认或服务器托管 TTS 的部署。
3. **发现并修复：真实模型写出未知动作导致整门课失败**。第一门 Pro 课的讲解动作里有一条 `{"type":"skill"}`，解析器照收，发布场景时校验失败，整个任务在 TTS 已付费后终止（既有问题，与学伴无关）。现在解析时直接丢弃未知类型的动作。
4. **陪学方式在真实台词中生效**：课堂提问“为什么光合作用一定要有光？”（不点名）只有老师回答；“小林，你觉得叶子为什么是绿色的？”由小林先答：“是不是因为叶绿体里要抓光的叶绿素就是绿色的呀？”，再问一次：“我猜是叶绿素把绿光反射出来，别的颜色的光都被它吸收用去干活了？”——简短、用猜想/反问引导，符合“提问引导 + 活泼好奇、说话简短”，没有直接给出完整讲解。
5. **学伴声音走真实 TTS**：小林的实时发言请求 `/api/generate/tts` 用的是它自己的 `minimax-tts / speech-2.8-turbo / female-shaonv`，成功返回音频（7.9 s）；老师用自己的 `Chinese (Mandarin)_Gentleman`。生成阶段 21 段讲解音频全部成功。
6. **本机网络问题（非代码问题）**：这台电脑到 MiniMax / DeepSeek 的新 TLS 连接间歇性卡住，Node 内置 fetch 10 s 连接超时。模型网关对文本调用会自动重试；生成流水线对付费 TTS 调用按设计不自动重放（结果未知 → 待处理），因此两门 Pro 课的 TTS 阶段各需手动“确认并重试”几次才完成。直接用 Node 连续调用同一接口多数 2–5 s 成功。生产在东京服务器上，网络不同，上线后以生产验收为准。
7. **首页角色选择修复的浏览器验证**：首页选“预设模式 + 小林”→ 打开一门生成角色表的 Pro 课（课堂期间存储为课堂角色表，并记录首页选择）→ 地址栏直接跳回首页 → 首页仍是“预设模式”、小林仍勾选，记录已清除。
8. 验收后停止全部服务，删除数据库容器、临时环境文件、测试账号密码文件、假 S3 数据与临时脚本。

修复后全量 Vitest（`--maxWorkers=4`）：**865 个文件通过、17 个跳过；8952 项通过、94 项跳过、0 失败**；`tsc --noEmit` 通过；改动文件 ESLint/Prettier 通过；`build:worker` 通过。`@openmaic/generation` 包测试 138 项中 1 项（`assets.test.ts` 路径分隔符）只在 Windows 上失败，为既有问题。

### 未验证

- 无。生产登录后的验收已完成（见“生产验收”）。

### 已修复的既有问题（2026-10-06 晚）

- **首页角色选择丢失**：课堂页原来只在正常离开（组件卸载）时恢复首页的角色选择，直接刷新/关闭标签页/地址栏跳转后首页停在“自动生成”。现在课堂打开期间把首页选择记录在持久化设置里（`homeAgentSelectionDuringVisit`），下次加载时恢复；同一标签页内课堂仍打开时的存储重载不会打断课堂角色表（`beginClassroomAgentVisit`，`lib/store/settings.ts`）。测试：`tests/config/settings-home-agent-selection.test.ts`（模拟重新加载）。

### 已知问题

- `golden-replay` 在全量并发下偶发失败（单独运行通过）；本次全量未出现。
- 生成流水线对 TTS 的连接超时一律视为“结果未知”并停下等待确认（只有 DNS 失败视为未发送），网络差时需要手动重试。这是计费保护的既有设计，本批未改。

### 方案偏离的确认（用户 2026-10-06）

- 用户确认以实际代码为准，接受两处偏离：不建 `classmate_stage_bindings`（课堂角色 ID 编码模板与版本 + 不可变版本表，B05 的“继续问这个学伴”可直接解析）；默认头像用仓库内置图片，不引入 DiceBear。架构上快照仍只写入 `generatedAgentConfigs`，没有扩展 Stage schema，发言规则与 Pro 都从服务端版本表读取，满足方案“追溯 + 应用策略”的目的。

### 回退

- 运行时止损：把 Web 与 Worker 的 `ZHIYU_STUDY_CLASSMATES_ENABLED` 置空后 apply——学伴页面、API、首页分组与 Pro 工具消失；已生成的带学伴课堂照常播放（快照在课堂文档里），课堂聊天仍按快照执行发言规则（v25 表保留）。
- 版本回退：回到 release-20261006e 镜像；v25 表保留不用。

### 上线记录（2026-10-06，用户批准）

- **迁移**：只读核对生产 v24 checksum `84a64ee3…` 与仓库一致 → Supabase `apply_migration`（名称 `accounts_v25_study_classmates`）执行仓库 v25 SQL 原文 → `app_schema_migrations(25, d6bdefd18c12…)`。核对：四张表 RLS 开启且强制；策略数 2/3/1/2（模板/版本/资料/头像）；授权只有 `app_web`（模板与资料增删改查、版本与头像查/插）与 `app_worker`（模板与版本只读），anon/authenticated 无授权。
- **代码**：`learn/b04-classmates` 快进合并到 main `733888b1`，main 与分支推送 tokyo。
- **镜像**：本机构建 `release-20261006f`（web 74258ffc、worker 9af2c505），`docker save | gzip | ssh docker load` 装入服务器（磁盘 57%，未删除旧镜像）。
- **切换**：确认生产 0 个进行中生成任务 → 备份 `*.bak-20261006f-pre`（指向 release-20261006e）→ 服务器 compose 换成仓库版本（唯一差异是新开关透传）→ env 改镜像标签并加 `ZHIYU_STUDY_CLASSMATES_ENABLED=1` → `supabase-compose.sh apply --tier 4 --mode background --accept-jobs --confirm-writes`。
- **检查**：三个容器 healthy；readiness `ready: true`、`accountsVersion: 25`、2 个 Worker 心跳；三个容器内开关均为 1；`/api/study/capabilities` 返回 `classmates: true`；未登录访问 `/api/study/classmates` 为 401、`/study/classmates` 跳转登录页。
- **回退**：开关置空后 apply（学伴入口消失，已有课照常播放）；或恢复 `*.bak-20261006f-pre` 回到 release-20261006e 后 apply；v25 表保留不用。

### 生产验收（2026-10-06，用户登录后进行）

该账号的文本与 TTS 都用平台默认（DeepSeek Flash、MiniMax Speech 2.8 Turbo），因此学伴声音的凭据归属修复在生产同样生效。

1. `/study/classmates` 用表单新建“小林”（同学、提问引导、仅点名时发言、少女音色 2.8 Turbo）→ 保存为 `cm-be8857466f44d41b` r1，声音绑定为平台默认 `zhiyu-default-tts`。
2. 首页“预设模式”勾选小林 → 后台生成 2 页光合作用小课 → 任务冻结角色表 `default-1/2/3 + cm-be8857466f44d41b-r1`（带平台音色）→ 一次成功，2/2 页，TTS 无卡顿（本机的 TTS 卡顿确认是本机网络问题）。
3. 课堂不点名提问“为什么光合作用一定要有光？”→ 启衡（老师）与知微（正常参与的助教）回答，小林未发言。
4. “小林，你觉得叶子为什么是绿色的？”→ 小林先答：“因为它吸收了别的颜色的光，唯独把绿色反射出来，我们才看见绿！”——简短、活泼；这一次直接给出了答案，没有像本地两次那样用反问引导，陪学方式的效果受模型发挥影响，属于提示词约束而非硬性规则。
5. 小林的实时发言 TTS 用 `female-shaonv`，4 次 `/api/generate/tts` 全部 200。
6. 从课堂地址栏跳回首页后仍是“预设模式 + 小林”（首页选择修复在生产生效）；验收后已把首页改回用户原来的“自动生成”。验收产生的学伴“小林”和课程“光合作用原理”保留在该账号中。

### 原上线步骤（已按此执行）

1. 先问用户：核对生产 v24 checksum `84a64ee3…` → Supabase `apply_migration` 执行仓库 v25 SQL 原文 → 写入 `app_schema_migrations(25, d6bdefd1…)` → 核对四张表强制 RLS、授权与本文一致。**绝不对生产运行 `pnpm accounts:migrate`。**
2. 合并 main 并推送 tokyo → 本机构建 `release-2026100Xx` → 装入服务器（必要时先问是否删除旧镜像）→ 0 个进行中任务后切换 → Web 与 Worker env 加 `ZHIYU_STUDY_CLASSMATES_ENABLED=1` → apply → readiness ready、accountsVersion 25、`/api/study/capabilities` 含 `classmates: true`。
3. 登录账号在生产新建学伴、生成一门带学伴的课、在课堂分别不点名/点名提问各一次。

### 下一批（B05）前置条件

- B04 合并上线（或至少合并）。B05 复用：模板与版本快照（`readClassmateRevisions`）、课堂角色 ID → 模板版本的追溯（`parseClassmateStageAgentId`）、学伴资料授权（`study_classmate_materials`，在 B03 的 `resolveQuestionScope` 中与学科选择求交集）、发言规则模块。学伴独立模型策略（`modelPolicy`）在 B05 新增列。
- “继续问这个学伴”入口可从课堂角色 ID 直接解析出模板，不需要额外绑定表。

## B03 持久检索与带引用答疑（2026-10-06）

### 范围与起点

- 分支 `learn/b03-grounded-qa` 从 main `ef1a399e`（= `tokyo/main`，含 B02 全部后续）创建；生产为 release-20261006c、accounts v23（只读核对 checksum `3fe42841…` 一致）。
- 范围：候选 A 验证与选型（第 1 步）；索引任务（`learning_tasks` 新 kind `material_index`）、索引建立/替换/删除/重试、允许资源版本过滤、`/study/[spaceId]/ask`、结构化引用与回到“版本/页/块”、三种呈现、就绪检查与不可用状态、预算/取消/用量；资料删除/账号删除时清理索引；可重复评测集（第 2、3 步）。
- 不包含：B04 及之后（学伴、课后会话等）；rerank；付费 OCR；扫描页的文字识别（扫描页只报告为“无文字、未纳入检索”）。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 用户决定后的调整（2026-10-06）

用户看过第一版报告后决定：答疑默认**纯关键词检索、零外部成本**，再结合模型自身知识回答；bge-m3 等日后自部署或商用 key 再开；资料库**不做 OCR**，只支持文字版 PDF；批准真实模型评测、生产安装扩展并执行 v24、推送 tokyo，验收后按 B01/B02 流程合并上线并启用开关；删除 1–2 个旧镜像。

1. **检索方式默认关键词**（`lib/server/study/knowledge/config.ts` `resolveStudyRetrieval`）：`STUDY_EMBEDDING_MODEL` 为空 = 关键词模式，索引签名 `keyword@1`，建索引与提问都不调用 embedding；设置后 = 语义 + 关键词（原实现）；设置了但不可用（格式错、维度不是 1024、缺 key）= `EMBEDDING_NOT_CONFIGURED`，不静默降级。切换模式会改变签名，旧索引显示“需要更新”并在重建前继续服务。
2. **v24 改为允许无向量的 chunk**：`study_knowledge_chunks.embedding` 去掉 `NOT NULL`，检索函数的向量一路加 `c.embedding IS NOT NULL`。v24 尚未在任何持久环境执行，因此直接修改，**新 checksum `84a64ee3ccddaa42babda1b5fd96984918f4b86eeec7da85373b4fcf06725320`**（取代 `07219ff1…`；v22/v23 未变）。
3. **“资料中未找到”时也给模型知识的补充说明**：检索为空时不再跳过模型，而是告诉模型“资料片段：无”，模型的所有内容都只能作为“补充说明”（没有可引用编号，`grounded` 段落被改成补充说明），状态仍是“资料中未找到”。提示词第 3 条改为要求在补充说明里用自身知识给出有帮助的解答。每问预算不变（≤2 次模型调用）。
4. **界面**：检索区显示“检索方式：关键词匹配（不调用检索模型）”；回答元信息区分 `keyword`（关键词检索）、`hybrid`（语义 + 关键词）、`lexical`（配置了 embedding 但本次失败、退回关键词，保留原警示）。12 个语言文件新增 `study.qa.keyword`、`study.qa.keywordMode`，`EMBEDDING_NOT_CONFIGURED` 文案改为“检索模型配置无效”。
5. 测试：真实 PG 新增“关键词索引不存向量、不调用 embedding、关键词模式检索、向量查询只走关键词一路、混合索引对关键词模式显示 stale”；“未找到”测试改为验证只有补充说明、提示词含“资料片段：无”；`resolveStudyRetrieval` 单元测试。

#### OCR 检查（用户提供的 MinerU Cloud key，2026-10-06）

- 用黑体渲染两页**纯图片**中文 PDF（无文字层：定积分公式、积分表），经仓库的文档提取器注册表与资料库规范化流程解析：unpdf 0 字、两页都“无文字”；MinerU Cloud（vlm、ch）约 13 秒识别成功，中文正文、标题、公式（LaTeX）、表格文字都正确。
- **当前不能用**：MinerU 下载结果用的 CDN `cdn-mineru.openxlab.org.cn` 证书 **2026-10-02 已过期**（本机与东京服务器都校验失败），代码在下载 ZIP 时失败；为判断识别质量只用 `curl -k` 取了这一次结果，产品代码不关闭证书校验。另外现有 MinerU 解析器把整份结果合成一个块、**没有页码**，用于资料库时引用只能定位到资料而不能到页；资料库解析也只用服务器配置的 key，不用设置里的用户 key。
- **结论（按用户决定）**：资料库继续只用 unpdf、只支持文字版 PDF，扫描页标“无文字、未纳入检索”；不再计划 OCR 计费接入或重新配置。用户自己需要 OCR 时，在设置里配置 MinerU Cloud（课程生成的文档提取已支持用户自带 key），前提是 MinerU 修复证书。
- **后续（用户 2026-10-06 再次确认暂缓 OCR）**：资料详情页的解析方式下拉只列出本服务器可用的解析器，未配置的 MinerU（自托管/Cloud）、AliDocMind 不再显示（服务端仍返回完整列表，日后在服务器配置后会自动出现；删除不再使用的 `study.materials.parserUnavailable` 文案）。两份 2026-09-27 规划文档已注明“暂不支持扫描版 PDF、暂不做 OCR”（文首“范围调整”+ B02/B03/B08、第 12 节原处标注；这两份仍是用户未提交的文件）。之后唯一依赖 OCR 的是 **B08 习题提取**：改为只用 B02 解析结果的文字，扫描页列为“第 N 页无文字，未提取”并提示上传文字版或手动录入，验收里的“扫描件”改为“含扫描页的 PDF 被正确跳过”；`lib/pdf` 的 provider 结构与“解析策略 = provider + 版本”的 artifact 指纹保留，日后恢复 OCR 只需配置 provider、对版本重新解析、再重跑提取，无需改表。

#### SiliconFlow bge-m3（用户提供的 .cn key）

- `https://api.siliconflow.cn/v1/embeddings` + `BAAI/bge-m3` 可用，1024 维；**不接受 `dimensions` 参数**（400 参数无效），所以 `STUDY_EMBEDDING_SEND_DIMENSIONS` 必须为空。从东京服务器单条查询约 0.6 s，本机 0.5–5.5 s，32 条一批约 28 s（免费档限速）。生产暂不配置（关键词模式）。

#### 真实模型评测（2026-10-06，合成语料 48 题，一次性 PostgreSQL 17 + 扩展）

| 运行 | recall@5 | 引用支持率 | 未找到判对 | 有答案且给出依据 | 权限隔离（外账号/范围外） | 版本 | 模型调用 / 输入 / 输出 token |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 关键词 + 假答疑 | 40/40 | 36/39 = 92.3% | 6/8 | 37/40 | 0 / 0（378） | 1/1，旧版本 0 | 48 / — / — |
| **关键词 + DeepSeek-V3.2**（SiliconFlow） | **40/40** | **39/40 = 97.5%** | **8/8** | 39/40 | **0 / 0**（378） | 1/1，旧版本 0 | 48 / 54434 / 7957 |
| 混合（真实 bge-m3）+ DeepSeek-V3.2 | 40/40 | 39/39 = 100% | 8/8 | 39/40 | 0 / 0（419） | 1/1，旧版本 0 | 48 / 66613 / 7716 |

- 未找到的 9 个回答都带有模型的补充说明。关键词模式下唯一的“不支持”是 q16（模型另引了考试通知更正，标注只认原通知）；两种模式都没答出的是 q31（图 2-1 的说明已检索到第 3 页，模型认为资料不足）。
- 每问答疑模型耗时约 13–16 s（DeepSeek-V3.2，首 token 约 1.9 s）；检索本身 p50 55–62 ms。
- **解读**：这套合成题的措辞接近原文，关键词与混合 recall 相同，不能说明真实学生改写提问时向量的增益；但足以支持“默认关键词、零外部成本”上线。拟定生产门槛（以本评测为基线，复评时不得低于）：recall@5 ≥ 85%、引用支持率 ≥ 90%、权限隔离 0、版本正确 100%、未找到判对 ≥ 7/8。
- 两个用户提供的 key 只通过进程环境变量传入，未写入任何文件；报告在 `eval/study-qa/results/`（不入库）。

### 第 1 步：候选 A 验证与选型（提交 `d9db9c69`）

验证代码与结果在 [spikes/b03-candidate-a](../../spikes/b03-candidate-a/README.md)（独立目录，生产代码不导入）。

- **扩展**：生产（只读核对）为 Supabase Pro、PostgreSQL 17.6，`vector` 0.8.2 与 `pgroonga` 3.2.5 可用但未安装；`app_web`/`app_worker` 的 search_path 不含 `extensions`。本地用 `groonga/pgroonga:3.2.5-debian-17` + PGDG `postgresql-17-pgvector`（与生产同版本 PGroonga）。
- **形态**：`halfvec(1024)`（2 KB/向量）；PGroonga **多列索引** `(owner_id, index_id, text)` 让 owner、允许索引与关键词匹配在同一次索引扫描完成（单列索引时规划器走 btree 过滤，`pgroonga_score` 全为 0——第一次运行即发现并改正）；向量侧在已限定范围内精确排序、不建 HNSW；RRF（k=60）融合两路各 30 个候选。
- **结果（假 embedding，合成语料 + 干扰资料）**：混合 recall@5 40/40、仅关键词 40/40、仅向量 39/40；606 个结果中外账号 0、范围外 0；230 个结果的定位与原文一致；单账号 2 万 chunk 全在范围内的最坏情况 p50 491 ms；表+TOAST+btree 约 3.3 KB/chunk。
- **成本发现**：PGroonga 的 Groonga 文件按表观大小计入 `pg_database_size`：装扩展 +43 MB、空索引 +42 MB、6000 行约 150 MB（实际磁盘 54 MB），删行不缩小。生产是 Pro（含 8 GB），当前库 64 MB，可接受。
- **选型结论：采用候选 A，不验证候选 B**（DeepTutor 派生服务需在 4 vCPU/8 GB 主机上再跑一个 Python 常驻进程并重做 owner 隔离/删除/恢复/归集；A 在同库里直接满足定位、权限、恢复与资源门槛）。语义质量需真实 embedding 评测，按约定未调用。

### 设计决策（实际实现）

1. **迁移 accounts v24**（`lib/server/accounts/sql-study-knowledge.ts`，checksum 原为 `07219ff1…`，关键词模式后为 `84a64ee3ccddaa42babda1b5fd96984918f4b86eeec7da85373b4fcf06725320`，见“用户决定后的调整”；v22/v23 未变）：
   - 无条件部分：`learning_tasks.kind` 增加 `material_index`；`study_knowledge_indexes`（一份解析结果 × 分块策略 × embedding 签名一行，`active` 部分唯一索引保证每版本最多一个在用索引）、`study_qa_answers`、`study_qa_citations`（引用按版本外键级联）；FORCE RLS，`app_web` 只读/删除索引、读写自己的答案，`app_worker` 写索引；anon/authenticated 无授权；`app_internal.learning_task_kind_ready()`。
   - **条件部分**（只在 `vector` 与 `pgroonga` 都可用时执行，DO 块 + EXECUTE）：在 `extensions` schema 建扩展、`study_knowledge_chunks`（`extensions.halfvec(1024)`、PGroonga 多列索引）、检索函数 `study_knowledge_search`（SECURITY INVOKER、固定 search_path、`enable_seqscan=off`，RLS 在函数内照常生效，仅授予 `app_web`）、`USAGE ON SCHEMA extensions`。原因：PGlite、普通 `postgres:16` 证明库和旧版自迁移安装没有这两个扩展，而全新 bootstrap 会跑所有迁移；没有 chunk 表时检索显示“不可用”。旧版安装通过 `ensureStudySchema` 应用同一文本，扩展创建失败只记 notice、不影响启动。
2. **索引任务**：`material_index` 复用 `learning_tasks`、租约队列与现有 Worker（不新建队列）。subject 为 `index:{versionId}`，B02 的按版本解析状态不受影响。Worker 读解析结果 JSON → 用仓库 `lib/rag` 分块器（800 字/块）→ 经网关分批 embedding（32 条/批）→ 在**带租约栅栏的提交**里一次写入索引行与全部 chunk，同一事务里删除该版本的旧索引并激活新索引：重建失败或丢租约绝不影响正在使用的索引。无对象存储写入。embedding 是付费调用，任务 `externalCost=true`（过期回收标记结果未知而不自动重放）；可重试错误（限流/网络/上游）按队列退避最多 3 次；模型或分块策略变更、存储不可用、超过 3000 块等为不可重试。Worker 心跳新增 `learning-kind:<kind>` 能力，Web 只有在存活 Worker 能跑 `material_index` 时才接受建索引请求（防止只开了 Web 开关时任务无人执行）。
3. **embedding 只经模型网关**：pi-ai 没有 embedding 接口，因此在网关内新增 `lib/model-gateway/runtime/embeddings.ts`（OpenAI 兼容 `/embeddings`），与文本调用同样的阶段：私有凭据句柄、撤销栅栏、配额槽、传输、分类与有限重试、每次尝试写用量（`funding_kind=operator`、`api=openai-embeddings`）与结构化日志。本批 embedding **由运营方出资**：`STUDY_EMBEDDING_MODEL=provider:model` 指向服务器已配置的 provider（复用其 key/base URL/代理，未设 base URL 时用目录里的官方地址），维度必须是 1024。embedding 签名 = 模型 + 维度 + 地址指纹；换模型后旧索引显示“需要更新”，提问只用同一签名的索引。
4. **答疑在 Web 同步执行**（不是学习任务）：放在现有的同步重任务租约（`runIndependentHeavyTaskRequest`，新 kind `study-qa`）里，计入个人/站点 heavy-task 上限与公平调度；用户选择的模型从请求头解析（与其他模型功能相同，`resolveRequestBinding(..., 'study-qa')`，可被 MODEL_ROUTES 路由），因而用户 Key 不落库。理由：BYOK 选择若放进任务需要加密快照，答疑又需要即时返回。每问预算（服务端执行）：1 次查询 embedding、≤8 段证据/8000 字、≤2 次模型调用（第二次只用于修复非 JSON 输出）、每次 ≤1500 输出 token、每账号每小时 60 个已保存回答；检索无结果直接“未找到”、不调用模型。客户端中断即取消，取消的问题不保存。
5. **范围与权限**：允许范围由服务端计算 = 学科内存活资料 ∩ 在用且同签名的索引 ∩（当前版本，或用户固定的版本）；固定了范围外/他人/无索引的版本返回 400。范围在产生候选的 SQL 里（参数 + FORCE RLS），不是事后过滤。`KnowledgeIndex` 契约增加 `allowedResourceVersionIds`（候选前过滤）与 `method: 'hybrid'` + 分项名次/分数，内存实现同步支持。
6. **引用**：模型只能引用给出的 `E1…E8`；未知编号被丢弃，“资料依据”段落若没有有效编号改为“补充说明”，“已回答”但没有有效依据改为“未找到”。引用行由服务端用自己的检索结果写入（资料、版本、解析结果 id、页、块、≤300 字摘录、内容 hash），不取模型输出。阅读器 `…/read?version=&page=&artifact=&block=` 打开指定版本与解析结果，给块加框并标出摘录。
7. **三种呈现**：“资料依据”（每条带引用）、“补充说明”（标明是模型补充、非资料原文）、“资料中未找到”（附模型的简短说明）；另有“只检索原文”（不调用答疑模型）。元信息显示检索方式（语义+关键词 / 仅关键词）、模型、token 与“部分用量未知”。
8. **就绪与降级**：`/api/study/capabilities` 增加 `qa`；`GET …/knowledge` 返回原因 `STORAGE_UNAVAILABLE`（库无扩展）、`EMBEDDING_NOT_CONFIGURED`、`WORKER_UNAVAILABLE`（已有索引仍可提问，只是不能建新索引）。embedding 服务在提问时失败 → 只用关键词检索并明确标注，不触发其他高消耗路径。
9. **删除与清理**：永久删除资料时，在第一阶段事务里取消 `index:` 任务并删除索引（chunk 级联），检索立即停止；第二阶段删除任务行；已保存的回答保留正文，引用随版本删除，界面显示“来源已删除”。账号删除清单加入 chunk（表存在时）、索引、答案与引用。**课程物理清理**：索引只挂在资料版本上，不引用课程，课程清理不涉及索引数据（核对后无需改动）。
10. **开关**：`ZHIYU_STUDY_QA_ENABLED`（默认关，需资料库开关）控制页面、`/api/study/spaces/[id]/{knowledge,ask,search,answers}`、`…/versions/[vid]/index` 与 Worker 的 `material_index` 处理器；Web 与 Worker 都要设置（compose 已透传，另透传 `STUDY_EMBEDDING_*`）。

### 偏离方案之处

- 答疑不是 `learning_tasks` 任务，而是同步请求 + 同步重任务租约（决策 4）；只有索引是任务。
- 方案写“允许资源版本集合直接作为 SQL 过滤”：实现为服务端计算的“索引 id 集合”（索引 = 版本 × 解析 × 策略 × 签名），效果相同且能区分同版本的新旧索引。
- 没有 rerank（方案允许“需要时再接”）；没有引入 react-pdf-highlighter（块级框选 + 摘录标记已满足“回到页/块”）。
- 评测用自建 runner 计算指标，promptfoo 作为同一管线的外壳（见“评测”）；Ragas 未用（Python）。
- 扫描页不做 OCR（B02 决定只用 unpdf），只在索引状态里列出“无文字、未纳入检索”的页。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-knowledge.ts`（v24）、`migrations.ts`、`sql-accounts.ts`、`lib/server/study/schema.ts`、`deletion.ts`。
- 网关：`lib/model-gateway/runtime/embeddings.ts`（新）、`index.ts`。
- 检索与答疑：`lib/server/study/knowledge/{config,chunks,query-terms,repository,index-task,ask,service,http}.ts`；`lib/rag/{types,index}.ts`、`providers/in-memory-lexical-index.ts`、`chunking/grapheme.ts`（见“发现的问题”）。
- 队列：`lib/study/tasks/contracts.ts`、`lib/server/learning-tasks/{contracts,repository,runner}.ts`（kind、每 kind 能力心跳、按 kind 的 Worker 就绪）、`lib/server/heavy-task-admission/{index,independent-request}.ts`（`study-qa`）、`workers/generation/main.ts`。
- 资料：`lib/server/study/materials/repository.ts`（删除时清理索引）、`lib/server/study/{flags,route}.ts`、`spaces/repository.ts`（错误码）。
- 接口与页面：`app/api/study/spaces/[spaceId]/{knowledge,ask,search,answers/[answerId]}`、`app/api/study/materials/[materialId]/versions/[versionId]/index`、`capabilities`；`app/study/[spaceId]/ask`、`components/study/knowledge/StudyAskPage.tsx`、学科页入口、阅读器引用定位；`lib/study/knowledge/{contracts,client}.ts`、`lib/study/spaces/client.ts`；12 个语言文件 `study.qa.*`。
- 配置与工具：`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml`；`scripts/dev-fake-model-server.ts`（假 `/embeddings` 与答疑回答）。
- 评测：`eval/study-qa/**`；验证：`spikes/b03-candidate-a/**`。

### 发现的问题

- **Worker ESM 包与 `graphemer`**：`lib/rag` 分块器第一次进入 Worker 包；`graphemer` 是带 `exports.default` 的 CommonJS，Worker 的 ESM 包原生导入时默认导入是整个 `exports` 对象，启动即崩溃（`Graphemer is not a constructor`）。Next 与 Vitest 会自动解包所以测试没发现，本地托管验收启动 Worker 时发现；已改为兼容两种形态。已上线的 B02 镜像不导入该模块，不受影响。
- 验收中发现 `POST …/knowledge` 对他人学科返回 202（逐项报错）而不是统一的 404，已修复。

### 测试

- 新增：`tests/server/study-knowledge-migration.test.ts`（PGlite 2 + 带扩展的 PostgreSQL 2：v24 应用、FORCE RLS、Data API 无授权、kind 约束、owner 隔离、函数内 RLS、Worker 不能调检索函数、版本删除级联）；`tests/server/study-knowledge.test.ts`（真实 PostgreSQL + vector + pgroonga 9 项：经队列建索引与状态、无 `material_index` Worker 时拒绝、范围/固定版本/跨账号/换模型、混合与仅关键词检索及降级、引用只认服务端编号、无结果不调模型、丢租约不写入且重建原子替换、可重试/不可重试失败、永久删除）；`tests/study/knowledge-logic.test.ts`（11）、`tests/model-gateway/embeddings.test.ts`（6）、`tests/api/study-qa-routes.test.ts`（6）、`tests/rag/allowed-resource-versions.test.ts`（3）。
- 调整：`tests/auth/principal-mode.test.ts`（v24）、`tests/api/study-routes.test.ts` 与 `study-materials-routes.test.ts`（capabilities 含 `qa`）、`tests/server/account-deletion-lifecycle.test.ts`（四张新表只删本人）。
- 全量结果见本节末“最终校验”。

### 浏览器验收（2026-10-06，本地托管模式）

环境：一次性 PostgreSQL 17 + PGroonga 3.2.5 + pgvector（全新 bootstrap 到 v24，`zhiyu_app_web`/`zhiyu_app_worker` 登录角色，RLS 生效）、假认证、假 S3、两个假模型服务器（答疑 LLM 18787；embedding 18788，经 `siliconflow` provider 配置）、带学习调度的 Worker、`next dev`。资料为按评测语料用黑体生成的真实 PDF（第 5 页为无文字层的灰色图）。临时环境文件把 `.env.local` 的 145 个变量全部置空，无真实密钥与生产地址；结束后环境文件、账号文件、PDF、假 S3 数据与数据库容器已删除。没有调用任何真实模型。

1. 学科页出现“资料答疑”入口 → 答疑页列出 5 份资料（含第 2 版的补充讲义），全部“未建立索引”，提问按钮不可用。
2. “为全部资料建立索引” → Worker 依次完成，全部“可检索”；讲义显示“第 5 页没有文字，未纳入检索”；再为旧版本（第 1 版）单独建索引。
3. 问“arctan x 的导数是什么？” → “资料依据”带 [E1]“高等数学讲义（上册）· 第 1 版 · 第 4 页”，“补充说明”单独显示且标明非资料原文；元信息“语义 + 关键词检索 · 模型输入 10 / 输出 5 tokens，1 次调用”。点 [E1] → 阅读器打开该版本第 4 页、对应解析结果，块加框、摘录标记。
4. 问“红黑树有哪五条性质？” → “资料中未找到”。固定第 1 版后问 x³ 系数 → 只引用“第 1 版 · 第 1 页”。“只检索原文”问考试日期 → 两份冲突通知排在前两位。提问后立即取消 → 提示“已取消，本次提问没有保存”，已保存回答数不变。
5. 用量：索引 embedding 6 次记在 `learning:` 根；查询 embedding 与答疑调用记在 `independent:` 同步重任务根；同步租约全部释放；每个索引 attempt 记录 chunk 数、调用次数、token，完整度 complete。
6. 账号 B（另一 origin）：对 A 的学科/资料的知识状态、建索引、答案列表、提问、固定 A 版本提问、检索、删答案、删索引、阅读共 10 个探测全部 404（修复后）；在 B 自己的学科固定 A 的版本 → 400；B 打开 A 的答疑页显示“找不到这个学科空间”。
7. 停掉 embedding 服务 → 提问仍成功，标注“仅关键词匹配（语义检索暂不可用）”与“部分用量未知”；此时重建索引 → 3 次尝试后失败（`EMBEDDING_NETWORK`），界面显示原因与“重试”；恢复服务后点“重试” → 可检索。
8. 停掉 Worker → 横幅“后台处理服务暂时不可用：已建好的索引可以继续提问…”，建索引按钮不可用，提问仍可用。
9. 375px 宽度无横向滚动。
10. 永久删除被引用的讲义 → 该资料的索引、chunk、引用与索引任务全部清除，旧回答正文保留、[E1] 显示“来源已删除”。
11. 关闭 `ZHIYU_STUDY_QA_ENABLED` 重启 → `capabilities.qa=false`、入口消失、答疑接口 404，资料库照常。

### 评测（`eval/study-qa`，可重复运行）

- 数据：合成中文资料 + 近似干扰资料，48 个标注问题（正文 17、公式 8、表格 5、图 2、扫描页 2、冲突 3、版本 3、无答案 4、隔离 4）；没有可授权的真实教材，按约定先用合成资料。
- 运行（2026-10-06，假 embedding + 假提取式答疑模型，一次性 PostgreSQL）：13 个版本 45 个 chunk；混合 recall@5 **40/40**，仅关键词 40/40；检索 p50 5.9 ms / p95 9.0 ms；权限隔离：419 个结果中外账号 **0**、范围外 **0**；固定版本 1/1、默认范围旧版本命中 0；（假答疑模型）引用支持率 36/39 = 92.3%，无答案判对 6/8，有答案且给出依据 37/40。
- **解读**：语料小（每账号约 43 个 chunk），假 embedding 本质上是另一路词法信号，recall 近乎必然很高；这组数字证明管线、权限与版本正确，**不代表真实语义检索质量**。假答疑模型的支持率只验证引用校验与保存。真实 embedding（推荐 `BAAI/bge-m3`，1024 维）与真实答疑模型的评测需用户同意后运行（`EVAL_EMBEDDING_*`、`EVAL_ANSWER_MODEL`），再据此定生产时延与门槛。
- promptfoo：`eval/study-qa/promptfoo/` 用同一管线输出 recall@5、isolation、version、citation-support、not-found 指标。**本机未能运行**：npm 安装 promptfoo 0.124.0 时其安装后构建步骤失败（两次尝试），因此该外壳未经实测；指标以 `run.mjs` 的结果为准。

### 未验证

- 真实学生提问（改写、口语）下关键词与语义检索的差距：合成题措辞接近原文，无法回答；Playwright e2e。
- PGroonga 3.2.5 + pgvector 0.8.2 组合只在本地 PGroonga 3.2.5 + pgvector 0.8.7 上验证（所用 `halfvec`/`<=>` 自 0.7 起存在）。
- 单账号超过约 2 万 chunk 的时延（设了每账号 2 万 chunk 上限）；并发多 Worker 下的索引构建。

### 回退

- 运行时：取消 `ZHIYU_STUDY_QA_ENABLED`（Web 与 Worker）→ 入口、接口与 Worker 处理器全部关闭；资料库、阅读、B01/B02 不受影响；已保存回答与索引保留。
- 数据：v24 为纯新增；表、扩展保留不回滚。确需移除时可 `DROP` 新表/函数后 `DROP EXTENSION pgroonga, vector`（无其他依赖），但不建议在回退时做。

### 上线步骤（待用户指示，按 B01/B02 流程；以下都尚未执行）

1. 先问用户（已批准）：在生产启用扩展并执行 v24。核对生产 v23 checksum = `3fe42841…`；Supabase `apply_migration` 只执行仓库 v24 SQL（逐字相同，含在 `extensions` schema 创建 vector/pgroonga），写入 `app_schema_migrations(24, 84a64ee3…)`；核对四张新表 RLS 开启且强制、授权与本文一致、`study_knowledge_search` 只授予 `app_web`、`learning_task_kind_ready` 可调用。**绝不对生产运行 `pnpm accounts:migrate`。**
2. 关键词模式不配置 embedding（`STUDY_EMBEDDING_MODEL` 留空）；构建发布镜像 → 0 个未完成任务后切换 → Web 与 Worker env 设置 `ZHIYU_STUDY_QA_ENABLED=1` → apply → readiness ready、accountsVersion 24、Worker 心跳含 `learning-kind:material_index`、`capabilities.qa=true`。
3. 登录账号在生产为一份资料建索引并提问，核对引用跳转与用量。

### 生产发布（2026-10-06，release-20261006d）

1. **v24**：核对生产 v23 checksum `3fe42841…` 一致 → Supabase `apply_migration`（`accounts_v24_study_knowledge`，仓库 v24 SQL 原文）→ `app_schema_migrations(24, 84a64ee3…)`。核对：`vector` 0.8.2、`pgroonga` 3.2.5 装在 `extensions`；四张新表 RLS 开启且强制、anon/authenticated 无授权；`embedding` 可空；`study_knowledge_search` 的应用角色执行权只有 `app_web`；kind CHECK 含 `material_index`；空表上调用检索函数正常。数据库 64 MB → 149 MB（PGroonga 表观大小，与 spike 预测一致）。Security advisor 没有新增项（现存的 `reserved_admin_lifecycle_snapshot`、`app_schema_migrations` 无策略、泄露密码保护为既有项）。**未运行 `pnpm accounts:migrate`。**
2. **镜像**：main 快进到 `e0aa27b1` 后首次构建 Web 镜像失败——`scripts/dev-fake-model-server.ts` 引用了 `eval/`，而镜像构建上下文排除 `eval/`、`next build` 又会类型检查 `scripts/`；把假 embedding 移到 `lib/model-gateway/testing/fake-embedding.ts`（`f7f87190`）后构建通过。本机构建 → `release-20261006d`（web `81cbdd62`、worker `b38c511c`）→ `docker save | gzip | ssh docker load`。
3. **服务器**：用户批准后删除旧镜像 `release-20261005`、`release-20261005b`（磁盘 78% → 57%，装入新镜像后 68%；内存一直充足，约 6.3 GB 可用）。确认 0 个进行中的生成任务与学习任务 → 备份 `.env.hosted.local.bak-20261006d-pre`、`docker-compose.supabase.yml.bak-20261006d-pre` → compose 换成仓库版本（只多 B03 的 4 个透传变量）→ 镜像改为 `release-20261006d`、加 `ZHIYU_STUDY_QA_ENABLED=1`（`STUDY_EMBEDDING_MODEL` 不设）→ `apply --tier 4 --mode background` → readiness ready、accountsVersion 24、2/2 Worker；两个新 Worker 心跳含 `learning-kind:material_parse` 与 `learning-kind:material_index`；`/api/study/capabilities` = `{spaces, materials, qa: true}`。
4. **生产登录验收**（用户账号，学科“资料功能验收（可删除）”、资料 `smat-aR7KpBSulcDF`）：答疑页显示“检索方式：关键词匹配（不调用检索模型）”→ 建立索引 → 可检索、2 个片段、无向量 → 中文提问“二次函数的顶点坐标怎么求？”检索 0 条（该资料是英文，关键词模式不能跨语言匹配，属预期限制）→ 英文提问 “What is the vertex of a quadratic function in vertex form?” → “资料依据”两条（[E1] 第 2 页、[E2] 第 1 页）+ “补充说明”，元信息“关键词检索 · platform:zhiyu-default-text · 输入 634 / 输出 228 tokens，1 次调用”→ 点 [E1] 阅读器第 2 页加框并标出摘录；`usage_events` 一条 `study-qa`（platform、ok），无 embedding 记录。
5. **回退**：恢复 `*.bak-20261006d-pre`（回到 release-20261006c）后 apply；或只把 `ZHIYU_STUDY_QA_ENABLED` 置空后 apply。v24 表与扩展保留（旧版本不使用）。
6. **release-20261006e**（`886f98eb`，同日）：资料详情页只列出可用解析器（隐藏未配置的 OCR 选项）。0 个进行中任务 → 备份 `.env.hosted.local.bak-20261006e-pre`（→ release-20261006d）→ 换镜像 → apply → readiness ready、v24、2/2 Worker；生产资料页解析方式下拉只剩“unpdf · 默认（免费）”。装入后磁盘 78%；用户确认后删除 release-20261006b、20261006c 两组旧镜像（磁盘 57%），保留 20261005c、20261006、20261006d（回退目标）。注意 `*.bak-20261006d-pre` 指向已删除的 20261006c，不再可用；回退只用 `*.bak-20261006e-pre`（→ 20261006d）。

### 下一批（B04/B05）前置条件

- B03 合并并上线（或至少合并，B04 可与之并行）。B05“课后与指定学伴答疑”直接复用：`resolveQuestionScope`（再交学伴授权资料集合）、`searchStudyKnowledge`、`askSpace` 的证据组装/引用校验，以及 `study_qa_*` 的引用保存与“来源已删除”语义；学伴的资料授权应表达为允许的资料版本集合，在 `resolveQuestionScope` 里求交集，而不是事后过滤。
- 检索基线：2026-10-06 真实评测（关键词 + DeepSeek-V3.2，见上表）；B05 若改动检索或提示词，用 `eval/study-qa` 复评且不低于拟定门槛。日后开启 bge-m3 时先用真实学生问题补充评测集。
- 扫描件 OCR 不是 B04/B05 的前置条件：用户已决定（2026-10-06）不做 OCR，继续只用 unpdf；扫描页继续标为“无文字、未纳入检索”。

### B03 最终校验（2026-10-06，Node 24.19.0）

- 全量 Vitest（`--maxWorkers=4`，带扩展的一次性 PostgreSQL 提供 `TEST_STUDY_KNOWLEDGE_DATABASE_URL`）：**859 个文件 / 8910 项通过，16 个文件、84 项跳过**；运行中唯一失败是 `learning-tasks` 一处心跳断言（Worker 心跳现在附带 kind 列表），已更新后单独重跑通过。
- 真实 PostgreSQL（一次性 `*_rls_proof`，普通 PG16，验证 v24 的“无扩展”路径）：全新 bootstrap、v22/v23/v24 迁移、账号删除（16）、课程清理、heavy-task 容量 RLS、生成队列/事务队列/Worker 管线、用量迁移共 11 个文件全部通过（账号删除在独立 schema 中运行，暴露了 chunk 表存在性检查写死 `public.` 的问题，已改为按 search_path 查找）。带扩展的 PostgreSQL 17：v24 迁移 4 项、检索端到端 9 项通过。
- `tsc --noEmit`、`check:i18n-keys`（12 个语言文件）、改动文件 ESLint（0 问题）与 Prettier 通过；`build:worker` 通过且产物可加载；`next build` 通过，`/study/[spaceId]/ask` 与 `/api/study/spaces/[spaceId]/{knowledge,ask,search}` 已生成，唯一警告是既有的 `unpdf` “Critical dependency”。
- 未运行：Playwright e2e、生产镜像构建、promptfoo 外壳（本机安装失败）。
- **关键词模式复验（2026-10-06）**：全量 Vitest `--maxWorkers=4` **858 个文件 / 8901 项通过，17 个文件、94 项跳过，0 失败**；带扩展的 PostgreSQL 17：检索端到端 10 项 + v24 迁移 4 项通过；`tsc`、改动文件 ESLint/Prettier、`check:i18n-keys` 通过。本地托管模式浏览器复验（不启动 embedding 服务，`STUDY_EMBEDDING_MODEL` 为空）：答疑页显示“检索方式：关键词匹配（不调用检索模型）”→“为全部资料建立索引”4 份全部可检索（讲义第 5 页无文字）→ 数据库 4 个 `keyword@1` 索引、12 个 chunk、0 个向量，Worker 日志 0 次 embedding 调用 → 问 arctan x 的导数得 [E1] 第 4 页依据，元信息“关键词检索”→ 点 [E1] 阅读器第 4 页加框并标出摘录 → 问红黑树得“资料中未找到”+ 模型补充说明 → 只检索原文“期末考试是哪一天”两份冲突通知排前两位；用量只有 2 条答疑调用。环境文件、测试账号、PDF、假 S3 数据与数据库容器已删除。

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

- ~~付费 OCR 计费接入~~：用户决定（2026-10-06）资料库只支持文字版 PDF（unpdf），不再计划 OCR 计费接入；需要 OCR 的用户在设置里自行配置 MinerU Cloud（自带 key，只用于课程生成）。2026-10-06 的实测见 B03“OCR 检查”。
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

- B02 已合并并上线（当前 release-20261006c）；登录账号的生产端到端验收已完成（资料 `smat-aR7KpBSulcDF` 上传 → 解析任务成功 → 生成 artifact → 用于课程生成）。**B03 在用户明确指示前不开始。**
- B03 的索引/检索任务作为 `learning_tasks` 的新 kind（新迁移修改 kind CHECK 与必要的新表），复用 `lib/server/task-queue/lease-queue.ts` 与学习调度，不新建队列。
- 索引以 `study_material_artifacts` 的按页分块（`readerBlocksForPage` / artifact JSON）为输入，引用定位回到“版本 + 页 + 块”；阅读器已能按页跳转，B03 再决定是否引入高亮库。
- 涉及模型调用（嵌入/答疑）时只经模型网关并带 FundingSource、计入 heavy-task 与配额；重新评估 `app_worker` 连接池（若并发 >1）。
- ~~付费 OCR 若要开放，先完成计费接入与真实验证。~~（用户 2026-10-06 决定不做，见 B03“OCR 检查”。）

### B02 最终校验（2026-10-05，Node 24.19.0）

- 全量 Vitest（`--maxWorkers=4`）：**851 个文件 / 8860 项通过，16 个文件、83 项跳过，0 失败**（B01 收尾后 847 / 8826）。
- 真实 PostgreSQL（一次性 `*_rls_proof`）：迁移与 bootstrap 19 项、生成队列/容量/账号删除回归 44 项，全部通过；容器已 `down -v`。
- `tsc --noEmit`：通过。`check:i18n-keys`：通过（12 个语言文件）。改动文件 ESLint：0 个问题；改动文件 Prettier：通过。
- `pnpm build:worker`：通过。`pnpm build`：通过，资料库 3 个页面与 13 个新增 `/api/study/*` 路由均已生成；唯一警告是 `unpdf` 经已有的 `material-extraction` → `pdf-providers` 服务端引用产生的 “Critical dependency”，非本批引入。
- 未运行：Playwright e2e、生产镜像构建、promptfoo 外壳（本机安装失败）。
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
