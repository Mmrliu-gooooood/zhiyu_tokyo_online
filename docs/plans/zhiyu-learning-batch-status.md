# 智域学习功能批次状态

依据：[后续功能规划](2026-09-27-zhiyu-learning-feature-roadmap.md)、[分批实施方案](2026-09-27-zhiyu-learning-implementation-plan.md)（第 9.4 节台账模板）。
本文只记录实际完成和实际验证过的内容；“实现完成”不等于已合并、已预发布验收或已上线。

| 批次 | 实现状态 | 分支 / PR | 合并 commit | 预发布验收 | 生产启用 | 遗留事项 |
| --- | --- | --- | --- | --- | --- | --- |
| B00 | 完成（基线与台账） | `learn/b01-spaces` | `a1a0a7b6`（main） | 不适用 | 不适用 | — |
| B01 | 已上线（2026-10-05，release-20261005） | `learn/b01-spaces` → main（快进，已推送 tokyo） | `a1a0a7b6` | 无预发布环境，生产按开关灰度 | 已启用 `ZHIYU_STUDY_SPACES_ENABLED=1` | 见“生产发布与验收” |
| B02 | 已上线（2026-10-05，release-20261005c） | `learn/b02-materials` → main（快进，已推送 tokyo） | `11113d2e` | 本地托管模式验收通过（见 B02 节） | 已启用 `ZHIYU_STUDY_MATERIALS_ENABLED=1` | 见 B02“遗留事项” |
| B03 | 已上线（2026-10-06，release-20261006d；同日 20261006e 隐藏未配置的 OCR 选项） | `learn/b03-grounded-qa` → main（快进，已推送 tokyo） | `f7f87190` | 本地托管模式验收通过（关键词模式复验）；真实模型评测完成；生产登录验收通过 | 已启用 `ZHIYU_STUDY_QA_ENABLED=1`（关键词模式，未配置 embedding） | 见 B03“未验证” |
| B04 | 已上线（2026-10-06，release-20261006f；10-07 音色修复 release-20261007c） | `learn/b04-classmates` → main `733888b1`（已推送 tokyo） | accounts v25 已在生产执行 | 本地托管模式 + 真实模型验收通过；生产登录后验收通过（2026-10-06） | 已启用 `ZHIYU_STUDY_CLASSMATES_ENABLED=1` | 见 B04“已知问题” |
| B05 | 已上线（2026-10-07，release-20261007d） | main `62ba7ede`（已推送 tokyo） | accounts v26 `354fbeed…`（生产已执行） | 本地托管模式验收通过（假模型 + 真实 DeepSeek）；生产登录验收通过（含 OpenRouter 独立模型） | 已启用（`ZHIYU_STUDY_COMPANION_CHAT_ENABLED=1`） | 见 B05“未验证” |
| B06 | 已上线（2026-10-09，release-20261009） | `learn/b06-memory` → main `bb6684a1`（快进，已推送 tokyo） | accounts v27 `62c3e9d2…`（生产已执行） | 本地托管模式两轮验收通过（假模型 + 真实 DeepSeek，含课堂偏好）；生产登录验收通过（2026-10-09）；网关修复随后上线为 release-20261009b（main `e1ab2823`） | 已启用 `ZHIYU_STUDY_MEMORY_ENABLED=1` | 见 B06“未验证” |
| B07 | 已上线（2026-10-11，release-20261011；同日 20261011b 修公式渲染） | `learn/b07-bank-exams` → main（快进，已推送 tokyo） | accounts v28 `d6e44cc5…`（生产已执行） | 本地托管模式两轮验收通过（不配置任何模型，真实 RLS，双账号）；生产非管理员账号登录验收通过 | 已启用 `ZHIYU_STUDY_EXAMS_ENABLED=1` | 见 B07“未验证” |
| B08 | 已上线（2026-10-12，release-20261012；同日 Web 20261012b 修 PDF 文字里的 NUL） | `learn/b08-question-import` → main（快进，已推送 tokyo） | accounts v29 `cfd0433a…`（生产已执行） | 本地托管模式验收通过（真实 RLS、双账号、真实 PDF；模型整理用真实 DeepSeek 1 次）；生产非管理员账号登录验收通过 | 已启用 `ZHIYU_STUDY_EXTRACTION_ENABLED=1` | 见 B08“未验证” |

## 随 B09 一起发布：Web 启动时 LISTEN 首次连接超时（用户决定 2026-10-13）

- 现象：Web 每次启动有一条 `AgentEventNotifyBus` ERROR “dedicated LISTEN connection lost; retrying Error: timeout expired”（`lib/server/agent-runtime/event-notify-bus.ts`，node-pg `connectionTimeoutMillis` 10 s）。实际不是断线，而是 `instrumentation.ts` `register()` 启动后的第一次连接没在 10 s 内完成；100 ms 后的重试成功。Worker 启动没有这个问题。
- 已查明（2026-10-13）：Supavisor 日志里两次启动的第一次尝试都没有到达连接池（旧连接正常 Terminate，重试在报错后约 0.85 s 认证成功）；容器内平时连接 35–100 ms，连接池 3 个 IP 逐个 25–75 ms；新容器 DNS 10–20 ms；最大 server chunk 编译与 `warmApi` 预热只阻塞约 0.2–0.3 s。结论：卡在 Web 进程刚启动的十几秒里，不是网络/DNS/连接池；具体哪一步占住现有日志分辨不出。
- 影响：无功能影响（SSE 有 5–30 s 轮询兜底），只在部署后十几秒。
- 要做（随 B09）：① 首次连接失败记 WARN、文案改为“首次连接失败，正在重试”，并记录卡在哪个阶段（DNS/TCP/TLS/认证）与耗时；连续重试失败（如 3 次或 60 s）才记 ERROR。② 首次连接超时放宽到 30 s，或在启动工作完成后再连接。发布后看日志确认根因。

## 全部批次完成后再做：embedding 与 OCR（用户决定 2026-10-06）

- 先完成全部待完成批次；期间检索保持纯关键词、资料只支持文字版 PDF，不接 embedding 模型与 OCR。
- 之后接入：embedding 选 **Qwen3-Embedding-0.6B** 或其他小模型（0.6B 输出 1024 维，可直接用 v24 的向量列与 `STUDY_EMBEDDING_MODEL` 开关）；OCR 选 **RapidOCR** 或其他较小的 OCR（作为 `lib/pdf` 文档提取器的新 provider）。具体用法（自托管/API、资源与费用）届时再讨论。
- 接入后补做原计划中依赖它们的任务：B02 扫描版解析、B03 混合检索、B05 语义答疑、B08 扫描资料习题提取、OCR 用量展示。详见[实施方案](2026-09-27-zhiyu-learning-implementation-plan.md)第 13 节。

## B08 习题资料提取、核验与题源管理（2026-10-12）

### 范围与起点

- 分支 `learn/b08-question-import` 从 main `5caa0ef2`（= `tokyo/main`）创建；生产为 web release-20261011b、worker release-20261011、accounts v28。
- 范围：方案 B08 第 1–7 条——从资料版本与页范围提取习题（只读 B02 解析文字，扫描页列出不提取、不做 OCR）；候选题保留页、原文行、题号、选项、配图；原文答案（题内或答案区）与模型建议、学生填写、缺答案分开记录；左右对照核验页（编辑、拆分、合并、丢弃、恢复、可选的模型整理）；批量入库为 `material_extracted` 题；重复提取与重复入库不重复；资料删除/移出学科后不能再入库；公开题源记录链接、获取日期、版本、许可与署名，许可不明标“许可待确认”；组卷可不用公开资源题。新开关 `ZHIYU_STUDY_EXTRACTION_ENABLED`。
- 不包含：OCR/扫描版提取（见“全部批次完成后再做”）；主观题入库（B09，提取出的主观题保留为候选、不能入库）；B11 的 AI 出题；自动抓取网络题源。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

- **提取默认按规则、零模型调用**（`lib/study/extraction/rules.ts`，纯函数，策略 `rules-v1`）：读取解析结果中所选页的文字（unpdf 每页一个文字块）；去掉页码和每页重复的页眉页脚；按题号（`3．`、`第 3 题`、`例 2`）切题，题号必须递增（跳号最多 3，`1` 开始新的一组），所以题干里的 `2023.` 不会被当成新题；`习题 1.2`、`第二章` 这类带编号的标题开始新的一组，`二、填空题` 这类题型标题不打断编号；题目跨页时接着读，候选记录两页；选项支持同一行 `A. … B. …`、每行一个、`(A)`，并要求字母按 A、B、C 连续（`设 A、B 两点` 不会被当成选项）；题内答案 `【答案】`/`答案：`/`故选 B`，解析 `【解析】`/`解：`（但题干开头的 `证明：` 是题干）；答案区 `参考答案` 后的 `1. B 2. AC`、`1~4 CBAB`、`3. 3x²`（主观题参考答案）按“同一编号的习题组 + 题号”配对，配不上的条目列为“答案区未匹配”，从不猜测。没有选项的题记为 `open`（主观题）。页内的图交给提到“如图/图 1”的题，归不了的列出来，可在核验页手动加入。
- **扫描页**：所选页里没有文字的页列为“第 N 页没有文字（可能是扫描页），未提取”，提示上传文字版或手动录入；只有扫描页时提取成功但 0 道候选。
- **提取 = 一次同步请求**，不进学习任务队列：规则提取在毫秒级（验收的 5 页习题册 4 ms），一次最多 200 页、500 题。幂等键 = 资料版本 + 解析结果 + 页范围 + 策略，同一请求返回同一份提取（200）；每个学科最多 100 份提取记录。
- **答案证据与核验分开**：候选题的 `answerBasis` ∈ `source`（原文印着，题内或答案区，附页码）/ `model`（采用了模型建议）/ `user`（学生自己填或改）/ `missing`。入库后题目 `source.answerBasis` 只保留 `source`/`model`，核验状态只由学生在候选上勾“我已核对答案”决定（`user_verified`），原文答案和模型建议都不算核验；缺答案的题入库为草稿（B07 规则：不可判分、不进试卷）。
- **可选的模型整理**（`lib/server/study/extraction/assist.ts`）：只在学生点“模型整理”时，对所选的最多 6 道候选调用学生当前选择的模型（经模型网关、同步重任务租约 `study-extract`、每次最多 2 次调用、每份提取最多 60 次），把公式写成 `$…$` LaTeX、拆选项、给出建议答案和一两句理由。结果只存为“建议”，不改候选；学生点“采用建议”才生效。采用后答案与原文一致时证据仍是 `source`、且不带模型理由；答案来自模型时证据为 `model`、取消“已核对”勾选。用量记在提取上（调用次数、输入/输出 token、模型、完整度），并照常写 `usage_events`（source `study-extract`）。
- **核验页**（`/study/[spaceId]/extractions/[extractionId]`）：左边是原页（PDF 用 B02 阅读器的 pdf.js 画布，其他类型显示解析文字）、本页图片（可加到/移出当前题）和当前题的原文行（剪刀图标从该行起拆成新题）；右边是候选题列表（待处理/可入库/已入库/已丢弃/全部），每题显示题型、答案来源、是否修改过、问题提示、模型建议；操作有编辑（沿用 B07 编辑器）、与下一题合并、恢复提取结果、丢弃/恢复、勾选已核对、单题入库；批量“选中全部可入库”“模型整理”“加入题库”。窄屏时原文可折叠。编辑带 revision 检查（409 返回最新的候选）。拆分/合并按原文行重新读题，原文答案跟着能对上选项的那一部分走。
- **入库**：只有单选/多选能入库；`origin = material_extracted`，`source` 记资料标题与 `material = {资料、版本、版本号、解析结果、文件页、题号}`，题库、试卷与报告都显示“《资料》第 N 版 · 文件第 p 页 · 第 n 题 · 查看原文”（打开原版本的原页）。去重沿用 B07：指纹 `mat:<版本>/<原文行 hash>` 与内容 hash，重复入库返回“已在题库中”；配图不计入版本，同一本书重新上传后同样的题也是重复。资料必须仍在资料库且仍在本学科，否则 409 `STUDY_EXTRACTION_SOURCE_GONE`；新的提取同样被拒（404）。
- **配图**：题目版本新增可选 `figures`（最多 4 个，指向资料版本解析出的图片），随试卷快照冻结，作答与报告页经资料图片接口读取。资料删除后图片显示“图片不可用（原资料可能已删除）”，题目本身保留。
- **公开题源**：JSON 导入可勾“这些题来自公开资源”，填写资源名称、链接、获取日期、版本、许可、署名，并单独确认“许可允许这样使用”；不确认就是 `licenseStatus = unclear`，题目显示“许可待确认”，来源为 `public_source`。导入文件自己的 `source` 也可带 `retrievedAt`/`version`/`licenseStatus`。组卷新增“也使用来自公开资源的题（排在自己的题之后）”，默认开；顺序为自己的题 → 公开资源题 → 官方题包。
- **开关**：`ZHIYU_STUDY_EXTRACTION_ENABLED`（只有 Web 读取），同时要求资料库与题库开关；`/api/study/capabilities` 增加 `extraction`；关闭时入口消失、接口 404，已入库的题照常使用。

### 偏离方案之处

- 提取不是学习任务（Worker），而是同步请求：规则提取极快，没有付费调用；模型整理与 B03 答疑一样在 Web 同步执行（BYOK 选择不必进任务快照）。“失败保留已完成候选”：每次模型整理只改它自己的几道候选，失败不影响其他候选。
- 模型不参与切题，只在学生要求时整理所选题；不让模型声称“原文有答案”（原文答案只来自规则读到的文字）。
- 方案“保留 bbox”：unpdf 的解析结果没有 bbox（只有每页文字和图片），因此定位到“文件页 + 原文行”；以后换用带版面的解析器时可补。
- 题源管理没有单独的“官方维护白名单资源清单”：官方题包仍是代码里的 B07 题包；“用户提供链接”是导入时记录来源信息，不由服务器抓取链接（不建爬虫，也避免服务器替用户下载）。
- 主观题候选（填空、计算、证明）保留在提取里、带原文参考答案，但不能入库，等 B09 开放主观题。
- 入库时不选课程（B07 导入可选）；入库后可在题库编辑器里关联课程。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-extraction.ts`（v29）、`migrations.ts`、`sql-accounts.ts`（版本 29）、`lib/server/study/schema.ts`、`lib/server/accounts/deletion.ts`。
- 纯逻辑：`lib/study/extraction/{contracts,rules,candidate,client}.ts`。
- 服务端：`lib/server/study/extraction/{repository,service,assist}.ts`；`lib/server/study/{flags,route}.ts`（开关与 `studyExtractionRoute`）、`spaces/repository.ts`（9 个错误码）、`materials/service.ts`（导出 `loadArtifactDocument`）、`heavy-task-admission`（`study-extract`）。
- B07 扩展：`lib/study/questions/contracts.ts`（`QuestionSource.material/answerBasis/retrievedAt/version/licenseStatus`、`QuestionFigure`、`parseSourceDetails`、去重键计入配图数量）、`blueprint.ts`（`includePublic`、公开资源层）、`lib/server/study/questions/{repository,service}.ts`（`figures` 列、导入 `publicSource`、编辑保留配图）、`lib/server/study/exams/service.ts` 与 `lib/study/assessments/contracts.ts`（快照与视图带配图和资料来源）。
- 接口：`app/api/study/extractions/**`（列表/开始、详情/删除、`commit`、`assist`）、`app/api/study/extraction-candidates/[candidateId]/{route,actions}`；`question-bank/imports` 支持 `publicSource`；`capabilities` 加 `extraction`。
- 界面：`components/study/extraction/{ExtractQuestionsDialog,ExtractionReviewPage}.tsx`、`app/study/[spaceId]/extractions/[extractionId]`；`components/study/exams/{exam-format,PublicSourceFields,ImportQuestionsDialog,QuestionBankPanel,PaperBuilderPanel,PracticePage,AttemptPage}.tsx`（题库“从资料提取”、来源行、配图、公开题源表单、组卷开关）；`MaterialReaderPage` 导出 `PdfPageView`；`StudyShell` 未找到错误码；12 个语言文件 `study.extraction.*` 与 `study.practice.{source,publicSource,figure*}`。
- 配置：`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml`（新开关透传）。

### 数据迁移

- accounts **v29**，checksum `cfd0433a6dcf475d438c00d7a79a085f124911e56293bf01299dd704768cd10e`；v28 `d6e44cc5…` 未变。只新增：`study_question_extractions`、`study_question_candidates`（都 FORCE RLS，`app_web` 按 owner 增删改查，anon/authenticated/PUBLIC/`app_worker` 无授权），以及 `study_question_versions.figures`（可空，1–4 项，≤2 KB；旧版本全为空，B07 题目的去重 hash 不变）。提取引用学科与解析结果（`(owner_id, id)` 外键、级联删除），所以删除资料或学科时提取一起删除；已入库的题不受影响。旧式自迁移安装经 `ensureStudySchema` 应用同一文本（约束用 DO 块按需添加）。
- 已执行：PGlite（单测）；一次性真实 PostgreSQL（`*_rls_proof`，127.0.0.1:55432，用后 `down -v`）；本地验收库全新 bootstrap 到 v29（两张新表 `relrowsecurity = relforcerowsecurity = true`）。生产已执行（见“发布”）。

### 测试

- 新增：`tests/study/extraction-rules.test.ts`（23：选项拆分与误判、题内答案/`故选`/错误字母、主观题参考答案、`证明：` 题干、跨页与页眉页码、答案区按习题组配对、`1~3 BAB`、题型标题不打断编号、编号回退/跳号、配图归属与未归属、只有扫描页、候选校验与配图限制、模型输出解析、配图不影响跨版本去重）；`tests/server/study-extraction-migration.test.ts`（PGlite 4 + PostgreSQL 4 + 登记 1：可重复执行、强制 RLS、只授权 `app_web`、只能引用本人的学科与解析结果、他人不可见不可改、入库状态约束、Worker 无权、级联、配图上限）；`tests/api/study-extraction-routes.test.ts`（5：开关；规则提取、跳过扫描页、重复请求同一份、页范围校验；改答案变“你填写的”、过期 revision 409、非本解析结果的图 422、恢复、拆分再合并、模型整理只给建议、采用后为 `model`、用量记录、入库结果与来源/版本/配图、主观题不能入库、重复入库 skipped、配图进入试卷与图片接口、移出学科后 409/404、删除资料后提取消失题目保留；他人 9 个接口 404 且数据不变；公开题源导入与组卷排除）。
- 调整：`principal-mode`（版本列表加 29）、`study-exams-migration`（版本断言放宽为 ≥28）、`account-deletion-lifecycle`（两张新表只删本人）、三个 capabilities 断言（加 `extraction`）、`question-bank-logic`（blueprint 加 `includePublic`）。
- 全量 Vitest（`--maxWorkers=4`）：**883 个文件通过、17 个跳过；9112 项通过、94 项跳过、1 项失败**——失败的是运行期间新加的“`证明：` 题干”用例（规则修复前已被加载），修复后与 API 测试单独重跑全部通过；验收修复后再跑 `tests/study` 与两个题库/提取接口测试 11 个文件 129 项全部通过。`tsc --noEmit`、改动文件 ESLint（0 问题）与 Prettier、`check:i18n-keys`（12 个语言文件）、`build:worker` 通过。
- 真实 PostgreSQL（一次性 `*_rls_proof`）：v29 + v28 迁移测试 18 项、账号删除 16 项通过。

### 浏览器验收（2026-10-12，本地托管模式）

环境：一次性 PostgreSQL 17（`zhiyu-b08-acceptance-pg`，127.0.0.1:56433，全新 bootstrap 到 v29）、假 Supabase 登录、假 S3、Worker（只解析资料，无任何模型密钥，日志显示 0 个 LLM provider）、`next dev`；Web 以 `zhiyu_app_web` 登录（RLS 生效）。`.env.local` 其余变量全部置空，只有 DeepSeek 三项由 `next dev` 从 `.env.local` 读取（不写入任何文件），供“模型整理”使用。用后删除容器、临时 env、测试账号文件与假 S3 数据，进程按 PID 停止。

资料：用黑体生成的 5 页《高数习题册》PDF（每页页眉“高等数学同步练习”与页码；习题 1.1 的选择、填空、解答、证明题；第 3 题跨第 1–2 页；第 4 题带三角形插图；第 3 页是只有图片的扫描页；习题 1.2 一道题内带【答案】【解析】的多选；第 5 页参考答案 `1~4 CBAB`、`5. 3x²`、`6. 1`、`7. 略`、习题 1.2 `1. AB`），以及改写了第 1 题的第 2 版。经 unpdf 解析：5 页、690 字、1 张图。

1. 学科“高等数学”→“题库与测试”→“从资料提取”：选资料、第 1 版（非当前版本）、第 1–5 页 → 核验页“读取 5 页 · 找到 8 题（选择题 5，其他 3）· 8 题有原文答案 · 规则提取用时 4 毫秒 · 未调用模型”，提示“提取自旧版本（第 1 版）”与“第 3 页没有文字（可能是扫描页），未提取”。8 道候选的题号、答案全部正确：第 3 题“文件第 1–2 页”，第 4 题带插图，第 5–7 题为主观题并带参考答案，习题 1.2 第 1 题为多选 AB（题内答案，答案区重复的那条不算未匹配），答案区没有未匹配条目。
2. 1400 px 宽左右对照：选中第 4 题，左侧跳到第 2 页 PDF 画面（含三角形）、本页图片显示“从本题移除”、原文行列出；第 1、2 题勾“我已核对答案”。
3. 对第 4、6 题点“模型整理”（真实 DeepSeek，平台默认 `platform:zhiyu-default-text`）：1 次调用、18 秒、输入 325 / 输出 248 tokens，`usage_events` 一行 `study-extract`（platform 资金、ok）；第 4 题题干与选项改成 LaTeX、建议答案 B 并给出理由；第 6 题只整理格式。采用第 4 题建议后答案仍为 B、来源仍是“答案来自原文”，配图保留。
4. 第 2 题从选项行拆开 → 9 道（前半是主观题“缺答案”，后半带原文答案 B）；再“与下一题合并” → 恢复 4 个选项、答案 B（原文）。在编辑器里给第 3 题加解析 → 答案来源不变。丢弃第 7 题。
5. “选中全部可入库”→“加入题库（5）”→“已加入题库 5 题”；题库 5 题都是“资料提取”，第 1、2 题已核验，其余未核验；第 4 题展开显示插图、LaTeX 与“高数习题册 · 第 1 版 · 文件第 2 页 · 第 4 题 · 查看原文 · 答案来自原文”，“查看原文”打开第 1 版第 2 页。
6. 组卷 4 单选 + 1 多选（含未核验）→ 作答页第 4 题显示插图，作答接口没有答案字段；交卷 5/5，报告每题来源行写明“第 1 版 · 文件第 x 页 · 第 n 题”。
7. 同一请求再提取 → 同一份（200）；只提取第 3 页 → 0 道候选、列出第 3 页；对当前第 2 版提取 8 题并入库 → 只有改写的第 1 题新增，第 2、3 题和习题 1.2 第 1 题为“已在题库中”（第 4 题因当时去重键含版本而被新增，随后改为只计配图数量，见下）。
8. 账号 B（127.0.0.1）：对 A 的提取、学科、资料、候选、图片共 12 个接口（读、列表、在 A 学科提取、用 A 的资料在 B 的学科提取、改/恢复/拆分/合并候选、入库、模型整理、删除、读 A 的图片）全部 404；直接打开 A 的核验页显示“找不到这个学科空间”；数据库核对 A 的候选状态与 revision 不变，B 没有任何提取。
9. 把资料移出学科 → 核验页显示“原资料已删除或已从这个学科移除，不能再把候选题加入题库”，编辑与入库按钮消失；入库 409、新提取 404。重新关联后永久删除资料 → 三份提取随之删除，题库 7 题保留，配图位置显示“图片不可用（原资料可能已删除）”。
10. 375 px：核验页（含展开的原文 PDF 画面）、题库页与提取对话框都没有横向滚动。服务器日志无错误；整个验收只有第 3 步那一次模型调用。

### 验收中发现并修复的问题

- `二、填空题` 这类题型标题会把编号清零，导致后面的第 5 题被并进第 4 题：只有带编号的标题（`习题 1.2`、`第二章`）才开始新的一组。
- 题干以 `证明：` 开头时被当成解答，题干变空：只有题干之后的 `解：`/`证明：` 才算解答。
- 答案区重复题内答案的条目被列为“未匹配”：一致时视为已匹配。
- 题库里的配图用了 `loading="lazy"`，在部分窗口中不加载：改为直接加载（每题最多 4 张）。
- 采用模型建议时，即使答案来自原文也会带上模型写的理由，题库里显示成没有标注的“解析”：只有采用了模型自己的答案（此时标“答案为模型建议”）才带上理由。
- 主观题的模型建议显示“模型没有把握”：改为“主观题只整理格式，不给出答案”。
- 去重键原来包含配图所在的资料版本，同一本书重新上传后带图的题会重复入库：改为只计配图数量。
- 单页范围显示“第 3–3 页”：改为“第 3 页”。

### 未验证

- 深色模式未检查（用户 2026-10-11：之后会重做 UI）。
- 只用了一份自制的规整习题册；真实教材排版（多栏、公式图片化、题号样式更多）下的规则命中率没有统计，遇到切错可用拆分/合并/编辑修正，或用“模型整理”。
- 扫描版（OCR）提取按用户决定暂不做。
- 没有新增 Playwright 用例（与前几批一样做人工浏览器验收）。

### 发布（2026-10-12）

- main 快进到 `0ce80ac0` 并推送 tokyo。生产 v28 checksum 与仓库一致 → Supabase `apply_migration` `accounts_v29_study_extraction` + `app_schema_migrations(29, cfd0433a…)`；核对两张新表 RLS 强制、只有 `app_web` 授权、各 4 条策略、`study_question_versions_figures` 约束存在。
- 镜像 `release-20261012`（web `826e6e1c16c9`、worker `fa5fdb3d30cf`），两者 `smoke-pi-runtime` 通过，送到东京镜像 ID 一致。备份 `.env.hosted.local.bak-20261012-pre`、`docker-compose.supabase.yml.bak-20261012-pre`（→ web 20261011b、worker 20261011）；compose 换成仓库版本（只多新开关透传），env 换镜像并加 `ZHIYU_STUDY_EXTRACTION_ENABLED=1`，`apply` 后 readiness 正常（v29、2/2 Worker），`capabilities.extraction = true`，未登录访问提取接口 401。
- **热修 `release-20261012b`（只有 Web）**：生产验收第一次提取返回 503，日志为 Postgres `22P05`——验收用 PDF 的字体子集没有 Unicode 映射，解析出的页文字带 5 个 U+0000，jsonb 不能保存。真实 PDF 也可能这样，所以 `lib/study/questions/contracts.ts` 新增 `cleanText`（去掉 NUL，其他控制字符变空格，孤立代理项变 U+FFFD），提取规则读页文字、题目导入/编辑（`normalizeText`）和模型整理输出都经过它；单测覆盖提取与导入两条路径（`cd8b9de9`）。失败的请求整体回滚，库里没有残留。Web 镜像 `7787cc3cd85f` 冒烟通过，备份 `*.bak-20261012b-pre`（→ web 20261012、worker 20261012），只改 `ZHIYU_WEB_IMAGE`；readiness 正常。磁盘 81%（7.4 GB 可用）。2026-10-13 用户同意删除 web 20261011、web+worker 20261009c/20261009b/20261009/20261007d：磁盘 38%（24 GB 可用）；保留 web 20261012b/20261012/20261011b、worker 20261012/20261011（`*.bak-20261012b-pre`、`*.bak-20261012-pre` 仍可回滚，更早的备份指向已删除的镜像）。
- Web 每次启动有一条 `AgentEventNotifyBus` “dedicated LISTEN connection lost; retrying (timeout expired)”，随后不再出现，两次启动都一样，不是本批引入。

### 生产验收（2026-10-12，用户非管理员账号登录）

1. 新建测试学科，上传 19.5 KB 测试 PDF（本地验收那份习题册去掉字体后的版本，页面内按字节校验 sha256 后上传）→ Worker 解析成功，5 页、690 字。
2. 热修后“从资料提取”第 1–5 页 → “读取 5 页 · 找到 8 题（选择题 5，其他 3）· 8 题有原文答案 · 规则提取用时 49 毫秒”，第 3 页列为扫描页；第 3 题第 1–2 页、第 4 题带三角形配图、习题 1.2 第 1 题多选 AB。（第 1 题题干 `x + 2x` 少了 `²`：是这份测试 PDF 的字体子集丢了该字形的映射，不是提取问题。）
3. 1400 px 左右对照：选第 4 题，左侧为第 2 页 PDF 画面、本页图片“从本题移除”、原文行。
4. 第 4 题“模型整理”（真实 DeepSeek，平台默认）：1 次调用，输入 292 / 输出 194 tokens，`usage_events` 一行 `study-extract` ok；建议为 LaTeX 题干与选项、答案 B。采用后答案仍为 B、来源仍是原文、不带模型理由、配图保留。勾选第 1、2 题“已核对”。
5. “选中全部可入库”→“加入题库（5）”：5 题 `material_extracted`，第 1、2 题已核验，其余未核验，来源带资料、版本、页、题号；第 4 题带 1 张配图。
6. 组卷 4 单选 + 1 多选（含未核验）→ 作答页配图正常加载，作答接口不含答案；交卷 5/5，报告每题显示“B08验收习题 · 第 1 版 · 文件第 p 页 · 第 n 题 · 查看原文 · 答案来自原文”，“查看原文”链接到对应版本与页。同一请求再提取返回同一份（200，`created: false`）。
7. 跨账号：用该账号访问管理员账号的学科/资料——列出其学科的提取、在其学科提取、用其资料在自己学科提取、两者都用，全部 404；不存在的提取 404。
8. 375 px 核验页无横向滚动。
9. 清理：永久删除测试资料（提取随之删除）和测试学科；数据库核对该账号学科、资料、题目、提取、候选均为 0。

（浏览器面板用 1400 px 模拟宽度时，指针点击作答选项有时落空；恢复正常宽度后真实点击正常，是面板缩放问题，不是页面问题。）

### 回退

- 运行时：Web 的 `ZHIYU_STUDY_EXTRACTION_ENABLED` 置空后 apply——入口消失、提取接口 404；已入库的题、试卷与公开题源导入照常（导入的 `publicSource` 字段不依赖该开关）。
- 版本回退：回到 B07 镜像；v29 的表与 `figures` 列保留不用（旧代码不读，旧代码写入的题 `figures` 为空）。

### 上线步骤（待用户指示，按 B07 流程；以下都尚未执行）

1. 核对生产 `app_schema_migrations` v28 checksum = `d6e44cc5…`；Supabase `apply_migration` 只执行仓库 v29 SQL 原文，写入 `app_schema_migrations(29, cfd0433a…)`；核对两张新表 RLS 开启且强制、只授权 `app_web`、`figures` 约束存在。**绝不对生产运行 `pnpm accounts:migrate`。**
2. 合并到 main 并推送 tokyo；构建 web/worker 镜像（Worker 无改动，可只换 web，但按惯例两者同版本）；备份 env 与 compose；compose 换成仓库版本（多一行透传）；env 加 `ZHIYU_STUDY_EXTRACTION_ENABLED=1`；apply；readiness 与 capabilities `extraction: true`。
3. 用户登录后在生产上传一份文字版习题 PDF，提取、核验、入库并组卷验收；需要时验证一次“模型整理”。

### 下一批前置条件

- B09：提取出的主观题候选已有 `content.type = 'open'` 与 `referenceAnswer`，开放 `short_answer` 入库后可直接让这些候选可入库（`candidateQuestion`/`isCommittable` 处放开即可）。
- B11：`study_exam_papers.mode` 已允许 `ai`/`mixed`；模型生成题的来源必须是 `ai_generated`，不能复用 `material_extracted`。

## B07 结构化题库、规则组卷与客观题测试（2026-10-11）

### 范围与起点

- 分支 `learn/b07-bank-exams` 从 main `cc8866cd`（= `tokyo/main`）创建；生产为 release-20261009c、accounts v27。
- 范围：方案 B07 第 1–9 条——JSON 导入（预览、逐题错误定位、人工修改与核验、去重）；版本化题库与平面知识点；来源与核验状态分开；只读官方题包与私有副本；规则组卷（题型/数量、知识点、课程、难度偏好、避开做过的题、是否包含未核验题、官方题包、随机种子）；预览与缺口报告；冻结试卷快照；服务器上的作答（自动保存、revision 冲突、刷新/第二设备恢复）、交卷幂等与服务器判分；报告（解析、只看错题）与历史试卷；学习记录；新开关 `ZHIYU_STUDY_EXAMS_ENABLED`。
- 不包含：Excel/任意文件导入（只支持 JSON）、主观题（B09）、PDF 习题提取（B08）、AI/混合组卷与补题按钮（B11）、提示功能（`hint_used` 仍无生产者）、错题本（B10）。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

- **全程不调用模型**：导入、组卷、作答、判分、学习记录都是规则代码；接口测试每个用例结束断言 `gateway.complete/stream` 未被调用；本地验收时所有模型密钥为空。
- **题库**（`lib/study/questions/contracts.ts` 纯函数 + `lib/server/study/questions/`）：每题属于一个学科；内容放在不可修改的版本里，编辑即新增版本（`baseVersion` 防覆盖，409 返回最新）。导入格式 `{ format: 'zhiyu-question-bank', version: 1, source?, questions: [...] }` 或题目数组，字段概念对齐 QTI/GIFT（题型、选项、答案、解析、知识点、难度、分值、来源、`verified`）；选项、答案接受几种常见写法。校验逐题给出“路径 + 代码”（例如 `options[2].label: option_empty`），前端翻译成中文。缺答案的题可存为草稿，`gradable=false`，不进入任何试卷，也不能标为已核验。
- **去重**：内容 hash（题型 + 题干 + 选项 + 答案，归一化后 SHA-256）；首次入库时记为 `source_fingerprint`，`UNIQUE(owner, 学科, fingerprint)`；同时比对当前版本的 hash。重复导入、并发导入都不会重复建题。官方题复制的 fingerprint 是 `pack:<id>@<版本>/<题号>`。
- **来源与核验分开**：`origin` ∈ `user_import / manual / official / public_source / ai_generated / material_extracted`；`verification` ∈ `unverified / user_verified / official_verified`。导入时学生选择“按文件标记 / 全部已核对 / 全部未核验”；官方副本改了题目内容后不再是官方核验。
- **官方题包**（`lib/study/questions/packs.ts`）：代码里的只读、带版本的公开目录，不是数据库行，没有任何账号能改；首个题包《高等数学基础：极限、导数与积分》v1，15 题，**智域团队原创**（CC BY 4.0，署名“智域团队编写”），答案已逐题核对，单测保证题目完整一致。没有使用 GAOKAO-Bench / C-Eval 等许可未确认的数据。组卷可直接选用，自己题库优先；复制到题库成为可编辑的私有副本。
- **组卷**（`lib/study/questions/blueprint.ts`，纯函数、确定性）：候选 = 题库中可判分的当前版本 + 允许的官方题（与自有题内容相同或已复制的不重复出现）；按种子洗牌，自有题在前，按难度偏好稳定排序；选了多个知识点时轮流取，先保证每个知识点都有题。不足时**不凑数**，返回每种题型“需要/可用”，以及因“做过”“未核验”被排除的数量，和没有可用题的知识点。预览返回种子，发布时用同一种子，保证发布的就是预览的那份；有缺口时发布返回 409 `STUDY_EXAM_INSUFFICIENT`。
- **试卷快照**：发布时逐题冻结题干、选项、分值、知识点名称、来源（含官方题包署名与许可），答案与解析放在单独的列；之后改题、删题都不影响已发布试卷。发布用幂等键，同键同请求返回同一份，同键不同请求 409。
- **作答**：每份试卷同时最多一个进行中的作答（部分唯一索引），第二设备打开即继续同一份；草稿按 revision 条件保存，过期的保存返回 409 和服务器上的最新答案，前端载入并提示，不静默覆盖；交卷时若发现别处有更新的答案，先停下让学生检查。交卷带每次作答一个的 key，重复、并发交卷只成功一次，其余返回已存结果（`alreadySubmitted`）。数据库的更新策略只匹配进行中的作答，交卷后即使代码出错也改不了。
- **不泄露答案**：交卷前的题目视图逐字段构造（`toItemView`），读取时根本不查答案列；交卷后报告才带答案、解析、每题结果。
- **判分**：复用课堂测验的 `arraysEqual`，判分前检查标准答案非空、在选项内、不重复、单选只有一个，学生答案同样检查；空答案永远不等于空标准答案；多选全对才得分（与课堂一致）；标准答案异常的题记为“无法判分”且不计入总分。
- **学习记录**：新事件 `exam_graded`（source `exam_attempt`，每次交卷一条，载荷含分数）；交卷后内联投影（失败不影响交卷，打开 Memory 页时补投影），遵守 Memory 开关；Memory 页显示“在「学科」完成测试《试卷》· 得分（服务器判分）”，近期状态加“学科测试：交卷 N 次，共得 x/y 分”（规则版本升到 `recent-state-rules-v2`）。
- **入口**：学科页标题区“题库与测试”；看完的课程旁边出现“测一测”，打开组卷并预选该课程。测试完全自愿，不影响课程完成。

### 偏离方案之处

按用户原则（与方案不同之处以实际代码为准，逻辑相同或相近即可），保留如下：

- 知识点表暂不建 `aliases` 列：同一学科内按归一化名称唯一，导入时按名称自动创建；需要别名时再加列。
- 题目与课程的关系放在题目上（可选的一门课，须是该学科已关联的课程），没有单独的多对多表；导入时可给整批题选课程。
- 来源多一个 `manual`（编辑器录入），与“导入”区分。
- 官方题包放在代码里而不是数据库：只读与版本天然成立，也没有“不属于任何账号的行”需要额外的 RLS 规则；上线新题包 = 发新版本代码。
- 作答答案与判分结果存在作答行（JSON，≤12 KB / 16 KB）上，没有单独的 `exam_answers`、`grading_records` 表：客观题一次判定、交卷即冻结；B09 主观题需要“重新批改产生新版本”时再加评分记录表。
- API：报告并入 `GET /api/study/attempts/[id]`（交卷后才带报告），开始/继续作答是 `POST /api/study/papers/[id]/attempts`；导入预览与提交共用 `/api/study/question-bank/imports`（`commit: true`）；另有 `concepts`、`packs`、`packs/[id]/copy`。
- “避开做过的题”指在本学科**已交卷**的试卷中出现过的题（按题目 id、内容 hash 或官方题号匹配）；只生成未作答的试卷不算做过。
- 选了却没有可用题的知识点也算缺口，阻止发布（方案只写了“报告缺口”）。
- 课堂没有“课程完成界面”，自愿测试入口放在学科页（看完的课程旁的“测一测”）。
- 删除题目是真删除（连同版本）；已发布试卷有完整快照，不受影响。方案回退里“保留题库版本”对现存题目仍成立。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-exams.ts`（v28）、`migrations.ts`、`sql-accounts.ts`（版本 28）、`lib/server/study/schema.ts`（旧式自迁移安装同样建表）、`lib/server/accounts/deletion.ts`（删账号时删六张新表）。
- 纯逻辑：`lib/study/questions/{contracts,blueprint,packs}.ts`、`lib/study/assessments/{contracts,client}.ts`。
- 服务端：`lib/server/study/questions/{repository,service}.ts`、`lib/server/study/exams/{repository,service}.ts`；`lib/server/study/{flags,route}.ts`（开关、`studyExamsRoute`、`readStudyBody` 可传上限）；错误码加 11 个。
- 接口：`app/api/study/question-bank/**`、`exams/preview`、`papers/**`、`attempts/**`；`capabilities` 加 `exams`。
- 学习记录：`lib/study/memory/{contracts,projection,recent-state}.ts`、`lib/server/study/memory/{projector,repository}.ts`、`components/study/memory/MemoryPage.tsx`。
- 界面：`components/study/exams/*`（题库、导入、编辑器、官方题库、组卷、试卷记录、作答与报告）、`app/study/[spaceId]/{practice,attempts/[attemptId]}`、学科页入口、`components/quiz/QuizMathText.tsx`（从课堂测验抽出的公式渲染，课堂与试卷共用）。
- 其他：`public/examples/zhiyu-question-bank-sample.json`（导入示例，单测保证能解析）、12 种语言文案、`.env.example`/`.env.hosted.example`/`docker-compose.supabase.yml` 新开关、`lib/study/spaces/client.ts` 能力解析改为按键表生成。

### 数据迁移

- accounts **v28**，checksum `d6e44cc538842b1cbe0c6d963f3bb889a43dcb7140f21f8a26fa1f5def4e314f`；只新增，不改旧迁移：`study_concepts`、`study_questions`、`study_question_versions`、`study_exam_papers`、`study_exam_items`、`study_exam_attempts`。子表都用 `(owner_id, 父 id)` 外键引用父表并级联删除；学科删除时题库与试卷一起删除（删除学科的确认文案已更新）。
- 六张表强制 RLS，`anon/authenticated/PUBLIC/app_worker` 无授权；`app_web` 按 owner：知识点、题目可查插改删；题目版本、试卷题目只能查插（不可修改）；试卷可查插删；作答可查插改，且更新策略只匹配进行中的作答。
- 本地一次性 PostgreSQL 17（vector + pgroonga 镜像）用全新 bootstrap 执行到 v28，核对六张表 `relrowsecurity = relforcerowsecurity = true`；迁移单测在真实 PostgreSQL（一次性 `*_rls_proof` 库，127.0.0.1:55432，用后删除）通过。

### 测试

- 新增：`tests/study/question-bank-logic.test.ts`（各种导入写法、逐题错误路径、缺答案草稿、文件级错误、去重键只看题型/题干/选项/答案、示例文件能解析、官方题包完整且带出处；组卷确定性、自有题优先、缺口与排除原因、知识点轮流覆盖与未覆盖、课程与难度偏好、blueprint 校验；判分不接受空/异常标准答案、单选/多选、只算可判分题、答案格式校验、交卷前视图不带答案）、`tests/server/study-exams-migration.test.ts`（v28 可重复执行、强制 RLS、Data API 与 Worker 无授权、Web 隔离、版本与试卷题目不可修改、一个进行中作答、交卷后不可修改；**用 `app_web` 身份直接跑作答仓储**：草稿冲突、交卷一次、重复交卷识别、交卷后拒绝草稿、他人看不到；真实 PG 上另测两个连接同时交卷只有一个成功）、`tests/api/study-exams-routes.test.ts`（开关；33 题文件预览 30 可导入/1 草稿/1 错误/1 批内重复、导入 30 题、重复导入 0 新增；8 单选 + 2 多选发布即预览的那份、同键重放与冲突、缺口 409；作答不含答案、第二设备继续、过期草稿 409、非法答案 400、交卷判分 8/10、重复交卷、交卷后草稿 409、改题删题后报告不变、避开做过的题、学习记录载荷、再做一次；官方题只读、自有优先、复制幂等、改内容后核验状态变化；账号隔离）。
- 调整：`study-memory-migration`（版本断言放宽为 ≥27）、`account-deletion-lifecycle`（六张新表只删本人）、三个 capabilities 断言（加 `exams`）、`memory-logic`（规则版本 v2）。
- 调整：`principal-mode`（迁移版本列表加 28）。
- 全量 Vitest（`--maxWorkers=4`，不加载 `.env.local`）：**880 个文件通过、17 个跳过；9078 项通过、94 项跳过、1 项失败**——失败的是 `principal-mode` 的迁移版本列表（未加 28），补上后单独重跑 25 项全部通过。`tsc --noEmit` 通过；改动的 TS/TSX 文件 ESLint 0 问题、Prettier 通过；`check:i18n-keys`（12 个语言文件）通过；`build:worker` 通过。
- 真实 PostgreSQL（一次性 `*_rls_proof` 库）：`study-exams-migration` 9 项（PGlite 4 + PostgreSQL 4 + 登记 1）通过。

### 浏览器验收（2026-10-11，本地托管模式，不配置任何模型）

环境：一次性 PostgreSQL 17（`zhiyu-b07-acceptance-pg`，127.0.0.1:56433，全新 bootstrap 到 v28）、假 Supabase 登录、`next dev`；Web 以 `zhiyu_app_web` 登录（RLS 生效）；所有模型密钥与地址为空（`make-env.mjs` 把 `.env.local` 里的 145 个变量置空）。用后删除容器与临时 env 文件。

1. 学科“算术练习”→“题库与测试”。导入 32 题文件（30 道已核对、1 道选项不足且答案不在选项里、1 道缺答案）：预览“30 题可导入，1 题缺答案（存为草稿），1 题有错误”，错误题显示“选项：至少需要 2 个选项 / 答案：答案里有不存在的选项”。在编辑器里给第 31 题补一个选项并点 B 为正确答案 → 服务器重查后变为可导入；导入后题库“共 32 题 · 可判分 31 · 已核验 30 · 草稿 1”。同一文件再导入：0 新增、31 重复。
2. 组卷 8 单选 + 2 多选 → 预览“共 10 题，10 分”；“生成试卷并开始”后作答页的 10 题与预览完全一致；作答接口响应里没有 `answer`、解析或标准答案字段。
3. 自动保存：连点 3 题合并为一次保存（revision 2）。“第二设备”（127.0.0.1 源、单独登录同一账号）打开同一作答，看到相同的 3 个答案；在第二设备改第 3 题、答第 4、9 题（revision 3）；回到第一设备（仍是 revision 2）答第 5 题 → 服务器 409，页面载入第二设备的答案并提示“答案已在其他设备或标签页更新”。
4. 第二设备交卷（9/10）；第一设备再点交卷 → 显示同一份结果（`alreadySubmitted`）。新开一份作答，同时发 3 个交卷请求 → 1 个交卷、2 个返回已交卷。
5. 编辑题库中出现在该试卷里的一道题（版本 2，改题干和答案）并删除另一道 → 历史报告逐题不变。
6. 组卷要 12 道多选 → “多选题：需要 12 题，可用 10 题”，“生成试卷”按钮不可用。
7. Memory 页显示两条“在「算术练习」完成测试《算术练习 · 10 题练习》”及“9/10 分 · 答对 9/10 题（服务器判分）”等，近期状态“学科测试：交卷 2 次，共得 9/20 分”。
8. 课程看到最后一页后，学科页该课程旁出现“测一测”，链接到组卷并预选该课程。
9. 375 px 宽度下题库页与作答页没有横向滚动；报告页“只看错题和未答”正常。服务器日志没有任何模型/网关调用，没有服务端错误。

### 验收中发现并修复的问题

- **重复交卷返回 404**：交卷与保存草稿原来用 `SELECT … FOR UPDATE` 读作答；在 RLS 下，加锁读取会同时套用 UPDATE 策略，而该策略只匹配进行中的作答，于是已交卷的作答“看不见”，重复交卷得到 `STUDY_ATTEMPT_NOT_FOUND`（PGlite 接口测试以超级用户运行，没有暴露）。改为先普通读取判断状态、再只对进行中的作答加锁（`lockOpenAttempt`）；新增以 `app_web` 身份直接运行仓储的回归测试（PGlite 与真实 PG 都跑），并在验收库里确认 `app_web` 普通读取 1 行、加锁读取 0 行。

### 第二轮验收（2026-10-11 晚，用户要求补验后上线）

本地环境同上（重建，用后删除），账号 A 在 localhost、账号 B 在 127.0.0.1（各自登录，互不共享 cookie）。

- **官方题“复制到我的题库”（浏览器）**：A 在“官方题库”对话框勾选 3 题 → “已复制 3 题（0 题之前已复制）”，题库“共 3 题 · 可判分 3 · 已核验 3”，标“官方核验 / 官方题库”；编辑其中一题只改解析 → 仍为官方核验；改题干 → 变为“已核验”（学生自己核对），来源仍指向题包 `lim-01`；题包原题不变；再次复制同一题 → 0 新增、1 重复。组卷 5 道单选并勾选官方题包 → 先用自有的 2 道，再用题包补 3 道。
- **第二个账号逐页越权（浏览器）**：B 直接打开 A 的 `/study/<A 的学科>/practice` 与 `/study/<A 的学科>/attempts/<A 的作答>` → 都显示“找不到”。B 对 A 的资源调用 18 个接口（题库列表、知识点、读/改/删题目、在 A 的学科新建题目、导入预览与提交、复制官方题到 A 的学科、组卷预览与发布、试卷列表/读取/删除、开始作答、读作答、保存草稿、交卷）全部 404，与“资源不存在”相同。数据库核对：A 的 3 道题、题目版本 4、1 份试卷、作答 `in_progress` revision 1 都未变，B 没有写入任何行。
- **发现并修复**：保存题目时对全文做了 Unicode NFKC 规范化，把中文全角标点改成半角（“（改编）”变成“(改编)”，“等于多少？”变成“?”）。改为原文保存，只在比较时（去重 hash、知识点名比较、选项字母/答案字母）做宽度折叠；浏览器复验全角标点保持原样。单测相应调整（全角答案字母“ｂ”仍识别为 B）。

### 上线记录（2026-10-11，用户指示“补验后上线”）

1. 只读核对生产：`app_schema_migrations` v27 checksum = `62c3e9d2…`（与仓库一致），v28 的六张表不存在；服务器 `docker-compose.supabase.yml` 与上一版仓库一致（新版只多 `ZHIYU_STUDY_EXAMS_ENABLED` 透传一行），`docker-compose.production.yml`、`scripts/supabase-compose.sh` 与仓库一致；磁盘 58%；生成任务与学习任务全部为终态。
2. Supabase `apply_migration`（`accounts_v28_study_exams`）执行仓库 v28 SQL 原文（导出文件 sha256 = `d6e44cc5…`），写入 `app_schema_migrations(28, d6e44cc5…)`。核对：六张表 `relrowsecurity = relforcerowsecurity = true`；授权只有 `app_web`（知识点/题目查插改删、版本与试卷题目查插、试卷查插删、作答查插改），`anon`/`authenticated`/`PUBLIC`/`app_worker` 无授权。未运行 `pnpm accounts:migrate`。
3. main 快进到 `e7d654cd` 并推送 tokyo；镜像 `release-20261011`（web `6ea82e7c`，worker `39df214a`）装入服务器；备份 `*.bak-20261011-pre`（→ release-20261009c）；compose 换成仓库版本；env 改镜像标签并加 `ZHIYU_STUDY_EXAMS_ENABLED=1`；apply。`readiness` `ready:true`、`accountsVersion 28`、2/2 Worker，三个容器 healthy；公网 capabilities 含 `exams:true`，未登录访问试卷接口 401；磁盘 68%。本次也带上了此前未上线的 apple-touch-icon 修复。
4. **生产验收中发现公式渲染问题并热修**：题库页沿用课堂测验的公式渲染，它对单个 `$…$` 很保守（课堂题目由模型生成，可能含美元金额），导致 `$AB$`、`$3x$`、`$(x^{3})'$`、矩阵等显示成原文（官方题包第 7 题也受影响）。给渲染函数加可选的 `trustDelimiters`，题库、编辑器、导入、组卷、作答与报告页面都开启（`MathText`），课堂行为不变；单测覆盖该选项，并检查官方题包所有题干、选项、解析都没有残留的 `$`（`2a5f08cb`）。只重建并发布 Web 镜像 `release-20261011b`（`217df0af`），Worker 仍为 `release-20261011`（无服务端改动）；备份 `*.bak-20261011b-pre`（→ release-20261011）。`readiness` 正常，磁盘 69%。

### 生产登录验收（2026-10-11，用户自行登录的非管理员账号，role = user）

- **越权**：用该账号对管理员账号的两个学科调用 16 个接口（题库列表、知识点、新建题目、导入、复制官方题、组卷预览与发布、试卷列表）全部 404 `STUDY_SPACE_NOT_FOUND`；直接打开管理员学科的题库页显示“找不到这个学科空间”。
- **主流程**（测试学科“B07 上线验收（测试）”）：官方题库对话框勾选 2 题复制 → 题库 2 题“官方核验”；导入公开示例文件 → “3 题可导入，1 题缺答案”，导入后“共 6 题 · 可判分 5 · 已核验 5 · 草稿 1”，全角“？”保留；组卷 4 单选 + 1 多选并启用官方题包 → 先用自有 3 道单选，题包补 1 道，“共 5 题，6 分”；发布后作答页与预览一致，作答接口无答案字段；作答后自动保存，刷新页面答案全部恢复；交卷 → 5/6（只有故意答错的第 4 题错），报告含正确答案、解析与“智域团队编写 · CC BY 4.0”署名；再次交卷返回同一结果（`alreadySubmitted`）；Memory 出现“完成测试”记录（5/6）。热修后报告页 37 处公式全部渲染、无残留 `$`，题库列表同样。
- **还原**：删除测试学科（级联删除其题库、试卷、作答与那条学习记录）；生产六张新表与 `exam_graded` 记录数均为 0，账号的学科列表恢复为空。

### 未验证

- 深色模式未检查（用户 2026-10-11：暂不查看，之后会重做 UI）。
- 没有新增 Playwright 用例（与前几批一样做人工浏览器验收）。

### 回退

- 运行时止损：Web 的 `ZHIYU_STUDY_EXAMS_ENABLED` 置空后 apply——题库、组卷、作答接口 404，入口消失；Memory 中已有的测试记录仍可查看；B01–B06 不受影响；数据保留。
- 版本回退：回到 release-20261009c 镜像；v28 的表保留不用（旧代码不读，Memory 的记录列表在旧代码里不关联试卷表）。

### 下一批前置条件

- B08：提取的题目以 `origin = 'material_extracted'` 写入同一题库；答案证据（原文答案、模型建议）需要扩展 `verification` 的 CHECK（新迁移）；资料版本引用放在题目的 `source`。
- B09：`study_question_versions.qtype` 已允许 `short_answer`；试卷快照与判分需扩展；重新批改需要评分记录表（新迁移）。
- B10：错题来自 `study_exam_attempts.grading` 中 `incorrect` 的题与冻结快照；`exam_graded` 事件可作为来源。
- B11：`study_exam_papers.mode` 已允许 `ai`/`mixed`；补题沿用 `selectQuestions` 的缺口结果。

## B06 基础学习事件、可编辑偏好与 Memory 控制（2026-10-09）

### 范围与起点

- 分支 `learn/b06-memory` 从 main `6afcbe70`（= `tokyo/main`）创建；生产为 release-20261007d、accounts v26（仓库 v26 checksum `354fbeed…` 与生产记录一致）。
- 范围：方案 B06 第 1–7 条——小型版本化学习事件（来自服务端已保存的事实、source 唯一键去重、可重放）；明确偏好与目标编辑；Memory 页面（事实/偏好/近期状态，带来源与时间，更正、删除、全局与按学科开关）；所有学伴共用同一份 Memory、按学科少量注入；关闭/删除语义与抑制标记；规则聚合的近期状态（零模型调用）并给 B12 留 `sourceWatermark`/`inputHash` 接口；新开关 `ZHIYU_STUDY_MEMORY_ENABLED`。
- 不包含：embedding、OCR（见“全部批次完成后再做”）、模型自动抽取记忆（mem0 式）、B12 的摘要与复习规则、IM 渠道。课堂实时发言按用户选定的方案 A 只注入讲解偏好（见“课堂实时发言”）。
- 网关修复分支 `claude/adoring-villani-afd3ce`（d677b860）**未合并**：与 B06 无依赖，单独变基、补 12 种语言文案、跑全量测试后另行上线更清楚。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

- **三类数据分开保存**：学习记录（`study_learning_events`，描述发生了什么）、学生明确设定的偏好与事实（`study_learner_preferences`、`study_memory_facts`）、规则聚合的近期状态（不落库，每次按记录计算）。看课只产生“观看记录”，界面每条都标注“观看记录，不代表已掌握”，任何字段、文案都不出现“已掌握”判断。
- **事件 = 已保存事实的规则投影**（`lib/study/memory/projection.ts` 纯函数 + `lib/server/study/memory/projector.ts`）：
  - B01 进度 `study_progress` → `course_started`（首次保存位置）、`course_progressed`（最远页，每页一个 source key）、`course_finished`（看到最后一页结尾）。
  - 课堂测验 `runtime_sessions/records`（kind = `quizAttempt`）→ `quiz_submitted`、`quiz_graded`。课堂在浏览器里判分，记录里的分数不可信：服务器按**课程库里存的原题**重新判选择题，只有题干与答案都没变时才记 `server_checked` 的选择题得分，否则记 `unverified`、不出分；主观题的 AI 评分照课堂记录标注为“来自课堂记录”。
  - B05 课后答疑：`study_companion_chats` + 会话事件 `user_message` → 每条提问一个 `companion_question`（去掉讨论选项封装，保留 ≤60 字预览）。
  - `hint_used`、`review_done` 只定义类型与载荷（提示/复习功能在 B07+/B12），没有生产者，不虚构历史。
  - 去重：`UNIQUE (owner_id, source_key)` + `ON CONFLICT DO NOTHING`；被删除/清除的 source key 写入抑制表，插入时跳过。因此任何投影都能重放。
  - 时机：进度写入与答疑发消息后**内联**投影（各在一个事务里、失败只记日志，不影响原请求）；Memory 页面打开时**补投影**全部来源（每账号 15 秒节流；并发请求等待进行中的那次）。课堂测验走通用存储接口，没有内联钩子，打开 Memory 页面时补上。
  - 开关语义：全局关闭时不投影；每个开关记录 `enabled_since`，重新打开后**关闭期间发生的事实不补录**；学科开关按“事件所属学科”判断（答疑按会话学科；课程按其所在学科，在多个学科中只要有一个开着就记录；不在任何学科的课程只看全局开关）。
- **偏好只能明确写入**：`explanation_length`（简短/适中/详细）、`example_order`（先例子/先定义）、`hint_mode`（先提示/直接解释）、`learning_goal`（≤200 字），可设“所有学科”或某学科（学科优先）。来源 `settings`（Memory 页面）或 `confirmed_prompt`（答疑中确认）。**确认提示**由纯规则识别（零模型调用）：只有带“以后/每次/我更喜欢…”等长期意愿词的明确表达才弹出“要记住这个讲解偏好吗？”，点“记住（所有学科）/只在「某学科」”才写入，并保存原话与会话 id 作为来源；“这题先举个例子”这类一次性请求不弹。
- **事实**：学生自己写的（`manual`）可更正（revision 冲突返回 409）和删除；对某条学习记录的“更正”是附在记录旁的说明（`correction`，记录本身保留），删除记录时一并删除。更正只作展示（给 B12 用），不注入答疑。
- **注入**（`lib/server/study/memory/context.ts`）：B05 的每轮服务端解析里多读一份 Memory——全局开关、学科开关、全局 + 本学科偏好、全局 + 本学科事实（不含更正）、学科的目标与考试日期（B01 已有字段）。选择顺序：偏好（学科覆盖全局）→ 学科目标 → 事实（本学科优先、最新优先），上限 8 条 / 事实 4 条 / 约 300 token。渲染成系统提示里的一段，明确“由学生本人填写或确认、所有学伴共用；本轮另有要求以本轮为准；不能当作已掌握的证据”。被邀请的讨论学伴拿到同一段。每轮的 `study_companion_turn` 事件记录 `memory: {state, refs, tokens}`，这就是“注入了什么/没注入”的证据；聊天页页头据此显示“本轮参考了你的 Memory：偏好 N 条、事实 M 条”或“Memory 已关闭”。读 Memory 出错或表不存在（v27 之前）时 `unavailable`、照常回答。
- **关闭与缓存**：Memory 上下文每轮现读，没有任何跨轮缓存，持久的会话记录里也不保存系统提示，所以关闭后**下一轮**立即不再注入（“清除模型上下文缓存”在本实现中没有需要清的对象）。会话历史（最近 8 轮原话）照 B05 保留——那是学生自己的对话，不属于 Memory。
- **删除与抑制**：删除偏好写入 `preference` 抑制（同一取值不再被建议）；拒绝建议写入 `suggestion` 抑制；删除/清除学习记录写入 `event` 抑制（同一来源事实不再投影）；`summary` 类型预留给 B12。
- **清除**：Memory 页面“清除…”可分别勾选偏好、事实、学习记录；**“同时删除原始课堂测验的作答与成绩”单独一项、默认不勾**，勾选后删除该账号的 `quizAttempt` 运行时会话（课堂里恢复为未作答）。
- **近期状态**（`lib/study/memory/recent-state.ts`）：最近 14 天按规则统计看课数/看完数/最远页、测验提交与批改次数、服务器核对过的选择题正确数、无法核对次数、答疑次数（按学伴）。每份结果带 `sourceWatermark`（最大事件 seq）、`inputHash`、`policyVersion`；`summaryNeedsRefresh()` 是 B12“有变化才更新”的接口，B06 不写摘要。
- **开关**：`ZHIYU_STUDY_MEMORY_ENABLED`（Web 与 Worker 都读；依赖学科空间）；`/api/study/capabilities` 增加 `memory`；关闭时页面与接口 404、runner 记 `unavailable` 不读取、进度与答疑的内联投影不执行。

### 偏离方案之处

用户 2026-10-09 确认：与方案不同之处以实际项目代码为准，逻辑相同或相近即可。逐条复核后保留如下（理由附后）：

- 方案 3.2 的 `learner_preferences / memory_entries` 拆成偏好、事实两张表，另加 `study_memory_controls`（开关）与 `study_memory_suppressions`（抑制标记）；`memory_summaries` 本批不建表（B12 再建），只在近期状态里先算好 watermark/hash。理由：偏好是“每个键一个值”、事实是自由文本，约束与唯一性不同，分表后各自的 CHECK 与唯一索引更直接；摘要表的形状要等 B12 的生成规则定下来再建，避免空表迁移。
- 学习事件不在 B07 之前的每个写入点都内联写入：课堂测验没有可挂的服务端钩子，靠 Memory 页面补投影（幂等、可重放，满足“投影失败可以重放”）。理由：课堂测验写入走通用的运行时存储（`runtime_sessions/records`），在那里挂学习逻辑会让持久层依赖学习模块；B06 只有 Memory 页面使用学习记录，打开时补投影即可，B12 用到时同样先调用 `syncLearningEvents`。
- 课堂测验分数不直接采用课堂记录，而是服务器按课程原题复判选择题；无法核对的不出分。
- 学习记录与近期状态本批**只展示、不注入**答疑（方案第 5 条只要求偏好/事实）；近期状态的注入留给 B12 的短摘要。理由：原始记录条目多、价值密度低，直接注入会挤占 token 上限，也容易被模型误读成“已掌握”。
- 方案的“关闭后清除模型上下文缓存”：实现里 Memory 每轮/每次请求现读，没有跨轮缓存，持久会话里也不存系统提示，关闭后下一次回答即生效——逻辑等价，没有需要清的缓存。
- API：方案表列了 `/api/study/memory`、`/preferences`；另加 `/api/study/memory/controls`、`/facts`、`/facts/[id]`、`/records/[seq]`、`/suggestions`、`/clear`，各自只做一件事。

### 课堂实时发言：只注入讲解偏好（用户 2026-10-09 选定方案 A）

候选为 A（只注入三项讲解偏好）、B（不注入）、C（与答疑一样全部注入）；用户选 A。实现：

- **读什么**（`resolveClassroomMemoryContext`，`lib/server/study/memory/context.ts`）：只读 `explanation_length`、`example_order`、`hint_mode` 三项，**不含**学习目标、事实、学科目标和学习记录——课堂里多个角色同时发言，个人信息不应被复述。按课程所在学科取值（`classroomPreferenceScope`）：课程不在任何学科 → 只用全局偏好；在一个开着 Memory 的学科 → 该学科覆盖全局；在多个开着的学科 → 只用全局（无法判断哪个学科的选择适用于这门课）；所在学科全部关闭 → 不注入（`space_off`）；全局关闭 → `off`。与答疑共用 `effectivePreference`（学科覆盖全局）和同一套开关语义；每次请求现读、不缓存，读失败或表不存在 → `unavailable`、照常回答。
- **怎么进请求**（`lib/server/study/memory/classroom.ts` 的 `applyClassroomMemory`，形状与 B04 的 `applyClassmateSpeechRules` 相同）：两条路由在说话规则与学伴模型解析之后调用；先删掉客户端传来的 `learnerPreferences`，再写入服务端读到的段落（`StatelessChatRequest.learnerPreferences`，与 `addressedAgentId` 一样“只能由服务端设置”）。未登录、功能关闭、无课程 id 时不查库。每次请求记一行日志 `classroom memory {state, refs, tokens}`（只有引用，不含文字），作为课堂的注入证据。
- **进哪些提示词**：LangGraph 各角色的系统提示（`buildStructuredPrompt` 的学生信息段之后）；Pi 的旧版与原生子 agent 提示（`buildChildPrompt`、`buildNativeChildPrompt`）。导演（决定谁发言）不需要、不注入。段落是英文（与课堂其他提示一致，回答语言仍由课程语言规则决定），约 60–90 token，写明“由学生在 Memory 里设定或确认、对所有老师和同学生效；在各自角色与长度限制内调整；本轮另有要求以本轮为准；不要说出这些设定”。
- 整课预生成的讲解内容不变；Memory 页面开关说明同步改为“课堂按讲解偏好、答疑另参考少量事实和目标”（12 种语言）。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-memory.ts`（v27）、`migrations.ts`、`sql-accounts.ts`（版本 27）、`lib/server/study/schema.ts`（旧式安装）、`deletion.ts`（账号删除）。
- 服务端：`lib/server/study/memory/{repository,projector,context,service}.ts`、`lib/server/study/{flags,route}.ts`、`lib/server/study/spaces/repository.ts`（错误码）、`lib/server/study/companion/context.ts`（提示词接 Memory 段）、`lib/server/agent-runtime/companion-run.ts`（每轮解析、邀请学伴、turn 事件）。
- 接口：`app/api/study/memory/{route,controls,facts,facts/[factId],records/[seq],suggestions,clear}`、`app/api/study/preferences`、`app/api/study/capabilities`；内联投影接到 `app/api/study/progress/[stageId]`、`app/api/study/classmates/[classmateId]/chats`、`app/api/study/companion-chats/[sessionId]/messages`。
- 共享/前端：`lib/study/memory/{contracts,projection,recent-state,overview,client}.ts`、`lib/study/companion/contracts.ts`（turn 事件加 `memory`）、`lib/study/spaces/client.ts`（capabilities）、`components/study/memory/{MemoryPage,CompanionMemory}.tsx`、`app/study/memory/page.tsx`、`components/study/companion/CompanionChatPage.tsx`（确认提示、页头 Memory 说明）、`StudyShell` 导航“学习记忆”、12 个语言文件（`study.memory.*`）。
- 配置：`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml`（新开关透传）。
- 课堂注入（方案 A，`99bbac27`）：`lib/server/study/memory/classroom.ts`（新）、`lib/server/study/memory/context.ts`（`resolveClassroomMemoryContext`）、`lib/study/memory/contracts.ts`（`effectivePreference`、`classroomPreferenceScope`、`selectClassroomPreferences`、`renderClassroomPreferenceBlock`；答疑与课堂共用偏好选择）、`lib/types/chat.ts`（`learnerPreferences`，仅服务端设置）、`app/api/chat/route.ts`、`app/api/chat/pi/route.ts`、`lib/orchestration/{director-graph,prompt-builder}.ts`、`lib/chat/pi/prompts.ts`、12 个语言文件（开关说明）、`scripts/dev-fake-model-server.ts`（探针对所有请求生效、支持多个短语）。

### 数据迁移

- accounts **v27**，checksum `62c3e9d21e242b0d31ddb3573386e2a920bd49ba169dc96d8f0068024e277550`；只新增，不改旧迁移：
  1. `study_learning_events`：`seq` 自增主键（水位）、`UNIQUE (owner_id, source_key)`、`stage_id` → `document_stages` 级联、`(owner_id, space_id)` → `study_spaces` 级联、载荷 ≤4000 字节。`app_web` 只能查/插/删（不可修改），插入时若带课程必须是本人未删除的课程；`app_worker` 无权限。
  2. `study_learner_preferences`：`(owner_id, COALESCE(space_id,''), pref_key)` 唯一；键限定 4 种；来源限定 `settings`/`confirmed_prompt`。
  3. `study_memory_facts`：≤200 字；`correction` 必须带 `corrects_key`；`(owner_id, space_id)` 级联。
  4. `study_memory_controls`：全局一行 + 每学科一行（唯一索引），`enabled_since`。
  5. `study_memory_suppressions`：`(owner_id, kind, target_key)` 主键，`app_web` 只能查/插/删。
  - 五张表强制 RLS，`anon/authenticated/PUBLIC` 无授权；`app_web` 按 owner；`app_worker` 只读偏好、事实、开关（查询都显式带 owner，同 B04/B05）。
- 已在本地一次性 PostgreSQL 17（vector + pgroonga）用全新 bootstrap 按生产顺序执行 v1–v4、v8–v27，核对：五张表 `relrowsecurity = relforcerowsecurity = true`；授权与上面一致（`app_worker` 对事件与抑制表无权限）。
- 2026-10-09 补验：迁移单测在真实 PostgreSQL 17（一次性 `*_rls_proof` 库，127.0.0.1:55432，tmpfs，用后删除）上通过（PGlite + PostgreSQL 各 3 项）。

### 测试

- 新增：`tests/study/memory-logic.test.ts`（长期意愿识别与一次性请求、已设置/已抑制不再提示、学科覆盖全局、条目与 token 上限、更正不注入、进度/测验/答疑的 source key、服务器复判与改题后不出分、AI 评分标注、开关与 `enabled_since`、近期状态无“掌握”字段且 hash 只随记录变化）、`tests/server/study-memory-migration.test.ts`（v27：可重复执行、强制 RLS、Data API 无授权、Web 隔离、事件不可修改且只能挂本人未删除课程、他人学科不能引用、Worker 只读三张表、无权读事件与抑制；设 `TEST_STUDY_MEMORY_DATABASE_URL` 可在真实 PG 上重跑）、`tests/api/study-memory-routes.test.ts`（PGlite + 真实会话存储：开关、三类来源投影与重放不重复、浏览器自称 2/2 而服务器判 1/2、删除后重放不复活、关闭停止投影与读取、关闭期间不补录、学科开关、偏好/事实编辑与冲突、更正、清除默认保留原始测验、账号隔离；每个用例结束断言 `gateway.complete/stream` 未被调用）、`tests/agent-runtime/companion-memory.test.ts`（真实 `prepareCompanionRun`：两个学伴拿到同一段 Memory 且人设各自不同、学科覆盖、他人账号读不到、关闭/学科关闭/功能关闭/表缺失时不注入且 turn 记录状态）、`tests/server/study-memory-projector.test.ts`（并发补投影等待进行中的那次、节流、按账号独立）。
- 调整：`principal-mode`（迁移版本到 27）、`account-deletion-lifecycle`（五张新表只删本人）、`study-companion-migration`（版本断言放宽为 ≥26）、三个 capabilities 断言（加 `memory`）。
- 全量 Vitest（`TEST_LOAD_LOCAL_ENV=0`，`--maxWorkers=4`）：首轮 **876 个文件通过、17 个跳过；9029 项通过、94 项跳过、0 失败**；验收修复（`8b402502`）后复跑 **877 个文件通过、17 个跳过；9030 项通过、94 项跳过、0 失败**。`tsc --noEmit` 通过；改动的 TS/TSX 文件 ESLint 0 问题；Prettier 通过；`check:i18n-keys`（12 个语言文件）通过；`build:worker` 通过且 Worker 正常启动。
- 课堂注入新增 `tests/server/study-classroom-memory.test.ts`（PGlite：课程所在学科覆盖全局、只给讲解偏好不给目标/事实/他人偏好、不在学科的课程用全局、学科关/全局关/功能关/表缺失；请求钩子丢弃客户端值、未登录/关闭/出错时不设置；LangGraph 与 Pi 旧版/原生子 agent 提示都带上该段），`memory-logic` 增加课堂选择与学科判定用例。全量 Vitest：**878 个文件通过、17 个跳过；9041 项通过、94 项跳过、0 失败**；`tsc`、改动文件 ESLint、Prettier、i18n 均通过。
- 真实 PostgreSQL（`TEST_*_DATABASE_URL` 指向一次性 `*_rls_proof` 库）补跑：`study-memory-migration`、`account-deletion-lifecycle`（postgres 后端 8 项）、`study-{spaces,materials,knowledge,classmates,companion}-migration`、`study-knowledge` 共 64 项。发现 1 项**既有**失败：B03 的 `study-knowledge-migration` 仍断言 Worker 不能执行 `study_knowledge_search`，而 B05 的 v26 已按设计授予 Worker 执行权（课后答疑检索资料）；该断言只在带 vector/pgroonga 的真实库上运行，以前没被跑到。已改为符合 v26 的断言（`2e090ed5`），复跑通过。

### 浏览器验收（2026-10-09，本地托管模式，先假模型、后真实模型）

环境：一次性 PostgreSQL 17（端口 56433，`zhiyu_app_web`/`zhiyu_app_worker` 登录角色，RLS 生效）、假登录、假 S3；临时环境文件把 `.env.local` 的变量全部置空，无真实密钥或生产地址（真实模型阶段 DeepSeek 密钥只由启动脚本在内存中导出）。课程《导数入门》（2 页讲解 + 1 页 2 题测验）用真实的 owner-bound 文档存储以 `app_web` 身份写入，挂到学科“高数”（目标“期末数学 85 分以上”、考试 2026-12-20）；另有学科“物理”、学伴“小林”（人设：喜欢用生活中的例子）与“小周”（人设：喜欢先讲概念）。验收后已停止全部服务并删除数据库容器、临时环境文件与测试账号密码文件。

1. **看课只记观看、不显示掌握**：在真实课堂页面切到第 2 页、测验页 → 进度写入时内联生成“开始观看 / 看到第 2/3 页 / 看到第 3/3 页 / 看完（共 3 页）”，每条都标“观看记录，不代表已掌握”；全页没有任何“已掌握”判断，近期状态写“看过 1 门课，其中看完 1 门”。
2. **测验由服务器核对**：在课堂里第 1 题答对、第 2 题故意答错并提交 → 打开 Memory 页补投影出“提交课堂测验（2 题）”“批改完成 · 选择题 1/2 正确（已按课程原题在服务器核对）”。
3. **确认提示写入偏好**：在“高数”问小林“以后先举个例子再讲：导数是什么？”→ 出现“要记住这个讲解偏好吗？‘先举例子，再讲定义’”；点“记住（所有学科）”→ 偏好保存为 `confirmed_prompt`，来源记下原话与会话 id，Memory 页显示“在答疑中确认 · 时间”和原话。
4. **注入探针（假模型 `FAKE_MODEL_PROBE` = 注入文字“先举一个具体例子”）**：确认前两次调用 `probe=absent`，确认后小林的下一轮 `present`；小周在同一学科的新对话也 `present`。两位学伴的 turn 记录同为 `refs: ["pref:example_order@global","goal:space"]`（共用同一份 Memory，人设各自不同）。
5. **关闭开关后不注入**：在 Memory 页关掉全局开关 → 小周下一轮 `probe=absent`，turn 记录 `{"state":"off","refs":[],"tokens":0}`，页头显示“Memory 已关闭，本轮没有使用你的偏好”；这一问**没有**生成学习记录。重新打开后（`enabled_since` 已记录）等节流过后补投影 `recorded: 0`，关闭期间那条提问也没有补录。
6. **删除后不复活**：删除“看完”和“看到第 3/3 页”两条记录（提示“之后不会再自动恢复”）→ 重新进课堂看到最后一页（进度 revision 升到 5、内联投影再次运行）→ 两条仍不存在，抑制表有两条 `deleted`；Memory 页补投影 `recorded: 0`。删除“先举例”偏好后再说“以后都先举个例子吧”→ 不再弹提示、该轮注入 0 条偏好；另一句“以后讲得简短一点”照常弹出，点“不用了”后记入 `suggestion` 抑制。
7. **页面编辑**：用按钮设“详细”“先给提示”（所有学科）和“高数”覆盖“简短”，物理显示“跟随所有学科（详细）”；添加并更正事实（revision 递增）；给测验记录写更正“第 2 题是手滑点错的”，显示在记录下方；把“物理”的学科开关关掉。
8. **清除**：弹窗默认勾选偏好、事实、学习记录，“同时删除原始课堂测验的作答与成绩”默认不勾；只勾“学习记录”清除 → 记录 0 条（更正随之删除）、原始测验会话仍在（1 个）、9 条 `cleared` 抑制；补投影 `recorded: 0`。
9. **账号隔离（真实 RLS）**：另一个 origin 登录账号 B → Memory 页 0 记录/0 偏好/0 事实/0 学科；用账号 A 的事实 id、记录 seq、学科 id 删除/修改/设置偏好/设开关，全部 404。
10. **零模型调用**：全部 Memory 操作（打开页面、投影、补投影、编辑、清除、开关）之后，`usage_events` 只有答疑本身的调用：假模型阶段 12 次（6 条提问 × 检索+回答）全部 `source=study-companion`，没有任何其他来源。

### 真实模型验收（DeepSeek V4.1 Flash，平台默认；约 0.0035 美元）

同一问题“链式法则是什么？请给我讲一下。”问小周（人设“喜欢先讲概念”），每次开新对话（避免历史影响）：

| 条件 | turn 记录 `memory` | 回答结构 |
| --- | --- | --- |
| 未设偏好 | `on`，`["goal:space","fact:…"]` | 先“一句话”定义和公式，再给 4 个例子；结尾引用了事实“函数部分想稳一点” |
| 设“先举例子，再讲定义”（Memory 页按钮） | `on`，`["pref:example_order@global","goal:space","fact:…"]` | 开头即“先看个具体例子，再上定义”，第一节“先看例子”（$(2x+1)^3$ 展开与链式两种算法对照），第二节才是定义——偏好压过了“先讲概念”的人设 |
| 关闭全局 Memory | `off`，`[]` | 回到先定义后例子，且不再提学生的事实或目标 |

`usage_events`：`study-companion` 平台调用 5 次（输入 5990 / 输出 2042 token，约 0.0035 美元）；Memory 相关调用 0 次。

### 第二轮验收（2026-10-09 下午：课堂注入与补验）

环境同上（新建的一次性库，v27 全新 bootstrap；课程《导数入门》挂到“高数”，《函数极限》不在任何学科；账号 B 有自己的《英语语法》）。假模型阶段平台默认文字模型（DeepSeek）指向本机假服务器、假密钥；探针 `FAKE_MODEL_PROBE` = 课堂段的“Start with one concrete example”与答疑段的“先举一个具体例子”。每次课堂请求的服务端日志 `classroom memory {state, refs, tokens}` 是注入证据。

假模型（`/api/chat`，LangGraph；课堂页真实界面提问 + 同源 API 请求）：

| 情况 | 日志 | 子 agent 调用探针 |
| --- | --- | --- |
| 未设偏好 | `on`，`[]` | absent |
| Memory 页按钮设“先举例子”（所有学科） | `on`，`["pref:example_order@global"]`，93 token | present（导演调用 absent，按设计不注入） |
| “高数”设“先讲定义”覆盖 → 高数的课 | `on`，`["pref:example_order@space"]`，89 token | absent（学科值生效） |
| 同时 → 不在学科的课 | `on`，`["pref:example_order@global"]` | present |
| 关掉“高数”学科开关 → 高数的课 / 不在学科的课 | `space_off`，`[]` / `on`，global | absent / present |
| 关掉全局 | `off`，`[]` | absent |
| 全局关 + 请求里伪造 `learnerPreferences`（含探针文字） | `off`，`[]` | absent（客户端值被丢弃） |
| 账号 B 请求账号 A 的课 | —（未到 Memory 读取） | 404 |
| 账号 B 自己的课（A 的偏好开着） | `on`，`[]` | absent |

Pi 路径（`NEXT_PUBLIC_PI_CHAT_ENABLED=true` 重启后，课堂页真实界面提问）：`POST /api/chat/pi` 200，日志 `on`，`["pref:example_order@global"]`；子 agent 调用 present，Pi 导演两次 absent。

真实模型（DeepSeek，平台默认；生产使用 `/api/chat`）：

- **课堂**（不在学科的《函数极限》，老师“启衡”，问“极限是什么？请给我讲一下。”）：设“先举例子”时开头为“好，先从具体例子看。比如数列 1/2…”，另一次为“先看个具体的：x 越来越接近 2 时，2x+1 会越来越接近多少？”并在白板画出 x→2 的取值表；删除偏好后为“极限，说白了就是‘无限接近’的那个目标值……”；关闭 Memory 后为“简单说，极限就是：当自变量无限接近某个值时……”——都是先定义。
- **课后答疑，小林**（人设“喜欢用生活中的例子”，高数，问“链式法则是什么？请给我讲一下。”，每次新对话）：设“先举例子”时 turn 记录 `on`，`["pref:example_order@global","goal:space"]`，回答小标题“先看一个具体例子”（$y=(3x+1)^5$）后才讲公式；关闭 Memory 后 turn 记录 `{"state":"off","refs":[],"tokens":0}`，页头显示“Memory 已关闭，本轮没有使用你的偏好”，回答先“一句话版本”和公式。与第一轮小周的结果合起来，两位学伴都在真实模型下验证了偏好效果。
- `usage_events`（整轮，含假模型阶段）：来源只有 `chat-adapter*`、`pi-chat-*`、`study-companion`，没有任何 Memory 来源；真实模型花费约 0.008 美元。

验收后已停止全部服务（Worker 按 PID）、删除数据库容器、临时环境文件、测试账号密码文件与假 S3 数据；Worker 日志与临时文件中未发现真实密钥。

### 验收中发现并修复的问题

- **补投影与并发读取的竞态**：开发模式 React 会执行两次页面 effect，第二个请求撞上按账号节流直接读取，读在第一个请求的投影提交之前，页面少显示了测验记录。改为并发请求等待进行中的那次补投影（`8b402502`，新增单测）。
- **“开始观看”排在“第 2 页”之后**：开始时间取的是进度行插入时间（服务器），第 2 页取浏览器观察时间，两者差几秒。改为取二者较早者（同一提交）。

### 未验证

第一轮列出的四项已在第二轮补验（课堂注入、真实 PG 迁移单测、真实 PG 账号删除、小林真实模型）。仍未验证：

- 生产只验证了一个账号的单个老师角色与一个学伴；账号隔离与删除不复活在生产未重复（本地真实 RLS 已验证）。
- 课堂多角色同时发言时（老师 + 多个学伴）真实模型是否都按偏好调整：本地只验证了单个老师角色；每个角色的提示都带该段由单测与假模型探针保证。

### 回退

- 运行时止损：Web 与 Worker 的 `ZHIYU_STUDY_MEMORY_ENABLED` 置空后 apply——Memory 页面与接口 404、导航入口消失，答疑与课堂都不再读取 Memory（turn 记录 / 课堂日志 `unavailable`），进度与答疑不再投影；资料答疑、课堂、B01–B05 功能照常；数据保留。
- 版本回退：回到 release-20261007d 镜像；v27 的表保留不用（旧代码不读）。

### 上线记录（2026-10-09，用户指示“选 A，做完后上线”）

1. 只读核对生产：`app_schema_migrations` v26 checksum = `354fbeed…`（与仓库一致），v27 的五张表不存在；服务器 `docker-compose.supabase.yml`（去掉 CRLF 后）、`docker-compose.production.yml`、`scripts/supabase-compose.sh` 与仓库一致。
2. Supabase `apply_migration`（`accounts_v27_study_memory`）执行仓库 v27 SQL 原文（本地导出文件 sha256 = `62c3e9d2…`，与迁移登记一致），写入 `app_schema_migrations(27, 62c3e9d2…)`。核对：五张表 `relrowsecurity = relforcerowsecurity = true`；授权只有 `app_web`（事件/抑制表查插删，其余三表查插改删）与 `app_worker`（偏好/事实/开关只读）；`anon`/`authenticated`/`PUBLIC` 无任何授权。未运行 `pnpm accounts:migrate`。
3. main 从 `6afcbe70` 快进到 `bb6684a1` 并推送 tokyo；本机构建 web 与 worker 镜像，标记 `release-20261009`（web `91b4c9cd`，worker `1ca8dad8`），`docker save | gzip | ssh docker load` 装入。服务器磁盘 79% → **89%**（剩 4.3 GB），未删除任何旧镜像（现存 20261006d/e/f、20261007b/c/d、20261009）。
4. 生成任务与答疑会话全部为终态（0 个进行中）；备份 `.env.hosted.local.bak-20261009-pre`、`docker-compose.supabase.yml.bak-20261009-pre`（指向 release-20261007d）；compose 换成仓库版本（只多新开关透传一行）；env 改镜像标签并加 `ZHIYU_STUDY_MEMORY_ENABLED=1`；`supabase-compose.sh apply --tier 4 --mode background --accept-jobs --confirm-writes`。
5. 结果：`readiness` = `ready:true`、`accountsVersion 27`、`liveWorkers 2/2`；三个容器 `release-20261009` healthy；Web 与 Worker 容器内开关为 1；公网 `/api/study/capabilities` 含 `memory:true`，未登录访问 `/api/study/memory` 为 401；重启后 Web 日志无错误。
6. 回退：恢复两个 `*.bak-20261009-pre` 后 apply（v27 的表保留不用）。
7. 用户同意后删除旧镜像 20261006d、20261006e、20261007b（web + worker），磁盘 89% → 58%（剩 17 GB）；保留 20261006f、20261007c、20261007d、20261009。

### 生产登录验收（2026-10-09，用户自行登录账号 2470034737@qq.com）

- **Memory 页**：正常显示新开关说明、“高中数学”学科目标；首次打开补投影出 6 条既有记录（5 条课后答疑提问、1 条“开始观看《声音是怎么传播的》”，标“观看记录，不代表已掌握”），近期状态“看过 1 门课，其中看完 0 门”，全页没有“已掌握”。
- **课堂 `/api/chat`**（《声音是怎么传播的》，问“声音为什么能在空气里传播？请给我讲一下。”，平台默认 DeepSeek）：Web 容器日志依次为 `on/[]` → `on/["pref:example_order@global"]/93` → `off/[]`；回答分别为“空气里挤满了分子……”（先讲机制）、“先想一个画面：你敲一下鼓……”（先举例）、“好问题！关键在空气分子之间……”（先讲机制）。
- **课后答疑**（小林，高中数学，聊天页真实界面）：turn 记录 `on`，`["pref:example_order@global","goal:space"]`，142 token；回答先举 $y=(x-2)^2+3$ 的例子再给一般式。注意：模型开头说了“我先按你的偏好，从例子讲起”，提示词要求不复述设定，模型仍点了一句，影响很小，记为观察项。
- **零模型调用**：验收窗口内 `usage_events` 只有 `chat-adapter-stream` 3 次、`study-companion` 1 次（共约 0.0025 美元），没有 Memory 来源。
- **还原账号**：删除测试设的“先举例”偏好；删除偏好产生的 `preference` 抑制标记（否则以后真说“以后先举例”不会再弹确认）；删除测试开关时留下的全局开关行（关→开会写入 `enabled_since`，按规则之后不会再补录此前尚未整理的事实），账号恢复为默认“开启、无起始时间”。留下 1 个测试答疑对话（“二次函数的顶点是什么？”，高中数学）。

### 网关修复随后单独上线（release-20261009b）

- 2026-10-07 评审过的 `claude/adoring-villani-afd3ce`（`d677b860`：配额/权益等“请求发出前”的后端失败不再被文字模式误判为 `MODEL_AUTH_FAILED`，改为 `MODEL_GATEWAY_UNAVAILABLE` → `PRO_MODEL_UNAVAILABLE`、HTTP 503、资料索引可重试）在当前 main 上无冲突地重放为 `7f033752`；补 `study.companion.errors.PRO_MODEL_UNAVAILABLE`（12 种语言，`e1ab2823`）。全量 Vitest **878 个文件通过、17 个跳过；9050 项通过、94 项跳过、0 失败**；`tsc`、ESLint、Prettier、i18n 通过。无迁移。
- 生产托管模式 Web 不跑 agent runner，原问题在生产没有出现过；本次上线是防止以后同类后端故障被误报成“凭据无效”。
- 上线（2026-10-09）：main 快进到 `e1ab2823` 并推送 tokyo；镜像 `release-20261009b`（web `6da56182`，worker `5d1a4471`）；0 个进行中任务；备份 `*.bak-20261009b-pre`（→ release-20261009）；只改镜像标签后 apply。`readiness` `ready:true`、v27、2/2 Worker，三个容器 healthy，Web 日志无错误；磁盘 68%。冒烟：课堂 `/api/chat` 正常回答；小林追问正常完成（turn 记录只剩 `goal:space`，与已删除测试偏好一致）。

### 后续修复与新图标（release-20261009c）

- 用户决定先不做行为偏好推理（“观察到的倾向”），只修当前问题。
- **关→开不再丢失更早的事实**（`4b8caa3c`）：原规则“开启时间之前的事实不再整理”会让关闭前还没补投影的课堂测验永久丢失（不只是关闭期间）。新增 `switchMemory`（`lib/server/study/memory/service.ts`）：关闭全局或学科开关前先强制补投影一次（失败不阻止关闭），再写开关；“关闭期间不补录”的语义不变，无迁移。新增回归用例（测验未补投影 → 关 → 开 → 测验记录仍在；去掉修复时该用例失败）。同一提交顺带删除了未被引用的旧 `public/zhiyu-{mark,lockup}.svg`。
- **措辞**：答疑与课堂的 Memory 段改为“直接按偏好讲，不要说‘按你的偏好’之类的话”（生产验收时小林说过一句）。
- **新图标**（`c46c2784`、`ada6acb9`）：用设计师最新版（绿色翻开的书）生成 `public/zhiyu-mark.png`（512，透明圆角，网站图标与页头）、`public/zhiyu-lockup.png`（只换左侧标志，文字不变）、`app/apple-icon.png`（180，铺图标自身浅绿底，避免 iOS 把透明角显示成黑色）、`app/favicon.ico`（16/32/48）。原 `favicon.ico`、`apple-icon.png` 还是上游 OpenMAIC 的紫色图标，Next 会自动输出，一并替换。PNG 用调色板压缩（标志 212 KB → 70 KB）。`themeColor` 仍是旧深绿 `#356B59`，未改。
- 全量 Vitest：877 个文件通过、1 个失败（`study-materials.test.ts` 的重复上传断言；单独重跑两次均通过——两次生成“同样的”PDF 跨秒时内嵌时间不同，属既有时序抖动），9050 项通过；`tsc`、ESLint、Prettier 通过。该测试由另开的会话修复（`7bde15c3`：只生成一次 PDF、三次上传同一份字节，顺带让“B 的副本不算重复”真正检验账号隔离），已并入 main，本地连跑 3 次通过。
- 上线（2026-10-09）：镜像 `release-20261009c`（web `c7bae189`，worker `d8496458`，构建自 `ada6acb9`）；0 个进行中任务；备份 `*.bak-20261009c-pre`（→ 20261009b）；只改镜像标签后 apply。`readiness` `ready:true`、v27、2/2 Worker、healthy、Web 日志无错误；磁盘 79%。生产 `/zhiyu-mark.png`、`/zhiyu-lockup.png`、`/favicon.ico` 与仓库字节一致，页头显示新图标。
- 上线后发现：布局元数据把 `apple-touch-icon` 指向透明角的 `zhiyu-mark.png`，`app/apple-icon.png` 没被用上（iPhone 添加到主屏幕时角会显示黑色）。已改为显式指向 `/apple-icon.png`（本地核对页面头部），随下一次上线生效。
- 未在生产重复验证：开关修复（避免改动用户账号状态，由回归用例保证）；“不要说按你的偏好”的措辞效果（模型行为，概率性）。

### 下一批（B07 / B12）前置条件

- B07 交卷/批改：在各自事务里调用 `recordLearningEvents`（source 类型 `exam_attempt` 已预留），事件类型沿用 `quiz_submitted`/`quiz_graded` 的载荷思路或新增类型（`event_type` 只校验格式，不需改表）；提示使用写 `hint_used`。
- B12：摘要表与生成任务另起迁移；用近期状态的 `sourceWatermark`/`inputHash`/`policyVersion` 与 `summaryNeedsRefresh()` 决定是否调用模型；删除/更正后已有抑制标记（`event`/`summary`）可直接复用；注入时沿用 `resolveMemoryContext` 的条目/token 上限与开关语义。

## B05 学伴课后答疑与持续会话（2026-10-07）

### 范围与起点

- 分支 `learn/b05-companion-chat` 从 main `98c42e9c`（= `tokyo/main`）创建；生产为 release-20261007c、accounts v25（仓库 v25 checksum `d6bdefd1…` 与生产记录一致）。
- 范围：方案 B05 第 1–7 条——复用持久 Agent 会话与 SSE 恢复；按用途选择提示词与工具；每轮服务端解析学伴版本、资料授权与模型策略；学伴独立模型策略（课后答疑 + 课堂实时发言）；课堂“继续问这个学伴”入口；默认单学伴回答、用户主动选择时多学伴讨论；恢复/取消/撤权/归档/模型失效/声音状态提示；新开关 `ZHIYU_STUDY_COMPANION_CHAT_ENABLED`。
- 不包含：embedding、OCR（见“全部批次完成后再做”）、IM 渠道、逐角色重新生成整门课、文字答疑的语音朗读。
- 开始时已有的未提交改动（ADR 0019、模型网关计划各 1 行，`docs/competition/`、两份 2026-09-27 规划文档）保留、未纳入本批提交。

### 设计决策（实际实现）

- **会话 = 现有持久 Agent 会话 + 一行应用层绑定**：新表 `study_companion_chats`（session_id 主键、学科、学伴、用途 `after_class_qa`、课堂来源 origin）。开新对话时先把会话建成不可认领状态，写入绑定行，再由开场消息把会话排队——runner 不可能在绑定写入前认领。之后的事件流、`Last-Event-ID` 续传、取消都用现有 `/api/agent/sessions/*`；不需要先建空课程。
- **runner 按绑定切换用途**（`lib/server/agent-runtime/companion-run.ts`）：认领每个会话时都查绑定（开关关闭也查），有绑定就绝不走 Pro：不加载 skill、不做 Pro 生成就绪预检，只注册学伴工具集——`search_materials`（关键词检索）、`read_material`（原文阅读）、`list_space_courses` / `read_course_page`（只读课程，仅限本学科课程与来源课堂）；只有当条消息用户勾选了讨论对象时才再加 `invite_classmate`。课程写入、网页抓取、Skill 编辑、生成任务等 Pro 工具都不注册。
- **每条用户消息一次 run**：学伴会话关闭 mid-run steer，运行中到达的消息在结束后由现有的 settle 重排逻辑开新 run。因此每轮都重新解析：学伴**当前**模板与版本、资料范围（学科资料 ∩ 学伴授权 ∩ 有效索引）、模型策略。每轮开始写入 `study_companion_turn` 事件（版本、人设指纹、可用资料、被隐去的资料、检索方式、模型标签、讨论对象）。
- **设定变更只影响之后的回答**：界面按 `study_companion_turn` 比较人设指纹（名字/角色/人设/陪学方式），变化时插入“学伴设定已更新（vX → vY）”；历史回答保留当时的名字和版本，持久记录不改写。
- **撤权后重新过滤历史**：资料工具的结果把片段结构化保存在 `details`，模型看到的文字始终由 `details` 渲染。每轮构建模型上下文时按**当前**授权重新渲染：失权或已删除资料的片段（连同标题）替换为“已隐去”，结构化副本也剔除；持久的 entry tree 不变（只读视图）。提示词同时提醒模型不要再使用已隐去内容。工具每次调用都重新解析范围，运行中撤权也立刻生效。
- **只带必要上下文**：模型上下文只保留最近 8 个用户回合（在用户消息处截断，工具调用与结果保持成对）；课堂来源只带课程/页面引用和 ≤600 字的问题原话，页面内容由 `read_course_page` 按需读取（≤4000 字）；资料片段 ≤700 字/段、每次检索 ≤6 段。
- **模型策略**（`lib/server/study/companion/model-policy.ts`）：`study_classmates.model_policy`（空 = 继承）。自定义只能引用现有连接：平台文本默认（`zhiyu-default-text`）、账号里已登录的凭据（`credentialId`，校验归属、状态、服务商）、服务器配置的服务商（排除平台默认的后备服务商）；不存任何 key。保存时与每次使用时都校验（可用性、凭据就绪；课后答疑还要求支持工具调用）；失败一律 `STUDY_CLASSMATE_MODEL_UNAVAILABLE:<原因>`，**不回退到其他模型**。继承模式使用会话的模型连接（浏览器当前 Home 模型每条消息同步），走新的 `study-companion` 阶段（运营方可单独路由，不受 Pro 驱动路由影响）。费用控制：网关的服务商配额 + 每账号每小时 60 条学伴消息上限 + 受邀学伴单次回复 ≤600 token。
- **课堂实时发言接同一策略**：`/api/chat`（LangGraph）与 `/api/chat/pi` 在发言规则之后解析课堂中学伴的**当前模板**策略：可用则该学伴用自己的 binding（LangGraph 按 agent 选 binding，Pi 子 agent 同样），不可用则本次把该学伴移出并通过新的 `notice` SSE 事件提示（界面 toast）；若它是唯一角色，只返回提示，不用别的模型代答。整课预生成不变，表单写明“只作用于课后答疑和课堂实时发言”。
- **多学伴**：默认一个学伴回答；用户在输入框旁勾选讨论对象（最多 2 位）时，主学伴可调用 `invite_classmate`，次数 = 现有回合策略 `getReplyPolicy` 的轮数 − 1（普通问题 1 位，明确要求“深入讨论”2 位，单纯致谢 0 位），每位最多一次。受邀学伴用自己的人设、资料范围（同一学科）与模型策略各回复一次，回复作为独立气泡显示。
- **Pro 列表隐藏学伴会话**：`GET /api/agent/sessions`、`/status`、owner 事件流都过滤掉；通用消息接口拒绝学伴会话（409），学伴消息只走 `/api/study/companion-chats/[id]/messages`（先校验学伴/学科状态与小时上限）。
- **界面**：`/study/classmates/[id]/chat`——历史对话列表、学科选择（来自课堂时预选课程所在学科）、引用 [M1] 跳转阅读器（失权后划线不可点）、检索/阅读过程行、讨论对象选择、停止按钮、连接状态、用量行（回答数 · 工具调用数）。状态提示：排队、思考中、已取消、连接中断、学伴/学科已归档（输入框禁用）、独立模型不可用（带“去学伴设置”）、无授权资料、声音不可用、“文字答疑不自动朗读”、头像加载失败自动换默认头像。学伴卡片新增“课后答疑”入口；课堂里学伴的每条回复下有“继续问 XX”（新标签页打开，带课程/页面/角色版本/问题原话）。
- **语音**：文字答疑不合成 TTS，也没有朗读按钮；页面仅用 B04 的 `roleVoiceBinding` 判断该学伴的声音在当前平台默认语音下是否可用并提示，不改动任何音色设置。
- **开关**：`ZHIYU_STUDY_COMPANION_CHAT_ENABLED`（Web 与 Worker 都读，依赖学伴开关；Web 侧还需要 Agent runtime）；`/api/study/capabilities` 增加 `companionChat`。开关关闭时学伴会话不会被当成 Pro 运行，而是明确失败“课后答疑功能当前未开启”。

### 偏离方案之处

- 方案 API 表只列了 `/api/study/classmates/[id]/chats`；实际另加 `/api/study/companion-chats/[sessionId]`（对话头信息）与 `/messages`（经校验的发消息），因为通用消息接口不检查学伴/学科状态和小时上限；`/api/study/classmates/model-options` 列出可选连接。
- 方案 3.2 的 `study_chat_bindings` 实际叫 `study_companion_chats`，没有“会话角色版本”列：每轮都用学伴当前版本，并在事件流里记录该轮用的版本（`study_companion_turn`），满足“显示变更、只影响后续”。
- 模型策略不放进不可变版本快照，而是模板上的应用策略：改模型立即作用于所有课堂与对话的后续实时回答，与“人设冻结在课堂快照”区分。
- 讨论模式由主学伴调用 `invite_classmate` 工具实现（在同一 run、同一条持久记录里），而不是像课堂那样由客户端循环多次请求。
- 每条消息一次 run（关闭 steer）：比 Pro 多一次认领，但保证每轮重新解析。
- 检索只用关键词（与 B03 默认一致，embedding 延后）。

### 实际改动模块

- 迁移：`lib/server/accounts/sql-study-companion.ts`（v26）、`migrations.ts`、`sql-accounts.ts`（版本 26）、`lib/server/study/schema.ts`（旧式安装）、`deletion.ts`（账号删除）。
- 服务端：`lib/server/study/companion/{repository,turn,tools,context,model-policy,classroom-models,service}.ts`、`lib/server/agent-runtime/{companion-run,runner,agent-driver-model,model-errors,dsl-tools}.ts`、`lib/server/study/{flags,route}.ts`、`lib/server/study/classmates/repository.ts`、`lib/server/study/spaces/repository.ts`（错误码）、`lib/server/model-routes.ts`（`study-companion` 阶段）、`lib/orchestration/{director-graph,stateless-generate}.ts`、`lib/chat/pi/{director-loop.ts,tools/call-agent.ts}`、`lib/types/chat.ts`（`notice` 事件）。
- 接口：`app/api/study/classmates/[classmateId]/chats`、`app/api/study/classmates/model-options`、`app/api/study/companion-chats/[sessionId]{,/messages}`、`app/api/study/classmates{,/[classmateId]}`（保存时校验模型策略）、`app/api/study/capabilities`、`app/api/chat{,/pi}`、`app/api/agent/sessions{,/status,/[id]/messages}`、`app/api/agent/owner-events`。
- 前端：`lib/study/companion/{contracts,fold,client}.ts`、`components/study/companion/{CompanionChatPage,CompanionAnswer}.tsx`、`app/study/classmates/[classmateId]/chat/page.tsx`、`components/study/classmates/{ClassmateModelPolicyField,ClassmateFormDialog,ClassmatesPage}.tsx`、`components/chat/{continue-with-classmate.tsx,chat-session.tsx,use-chat-sessions.ts}`、`lib/study/{classmates/contracts,spaces/client}.ts`、12 个语言文件（`study.companion.*`、`study.classmates.model.*`）。
- 依赖：`remark-math`、`rehype-katex`（下午为学伴回答的公式渲染新增；KaTeX 本身已是依赖）。
- 配置与工具：`.env.example`、`.env.hosted.example`、`docker-compose.supabase.yml`（新开关透传）；`scripts/dev-fake-model-server.ts`（假模型可驱动学伴检索/引用/邀请，`FAKE_MODEL_PROBE` 报告某句话是否进入模型上下文）。

### 数据迁移

- accounts **v26**，checksum `354fbeed15c498318fd54b8bb9c2c1b242d0a1b743b69173549af242a2155cdc`；只新增，不改旧迁移：
  1. `study_companion_chats`：强制 RLS；`app_web` 按 owner 查/插/删（没有 UPDATE，对话不能换学科或学伴）；`app_worker` 只读；anon/authenticated 无授权；外键（owner_id, space_id）→ `study_spaces`、（owner_id, classmate_id）→ `study_classmates`，均级联删除。
  2. `ALTER TABLE study_classmates ADD COLUMN IF NOT EXISTS model_policy jsonb`（可空，空 = 继承）。
  3. Worker 只读授权与策略：`study_spaces`、`study_space_materials`、`study_space_courses`、`study_classmate_materials`（查询都显式带 owner，同 B04 方式）；`study_knowledge_search` 函数的 EXECUTE（仅在函数存在时授予，DO 块判断）。
- 已在本地一次性 PostgreSQL 17（vector + pgroonga）用全新 bootstrap 执行 v1–v26，核对：版本 26、`study_companion_chats` 强制 RLS、`app_worker` 有检索函数 EXECUTE。**生产尚未执行。**

### 测试

- 新增：`tests/server/study-companion-migration.test.ts`（v26：可重复执行、强制 RLS、Data API 无授权、Web 隔离且对话不能移动、Worker 只读且能读资料范围、随学伴级联删除；设 `TEST_STUDY_COMPANION_DATABASE_URL` 可在真实 PG 上重跑）、`tests/study/companion-logic.test.ts`（消息选项封装、事件折叠的去重/续传一致性、人设/资料/模型标记、历史重渲染与隐去、历史窗口、提示词、模型策略解析）、`tests/server/study-companion-tools.test.ts`（每次调用重新解析范围、撤权后不能读、课程限制、邀请次数与去重）、`tests/server/study-companion-model-policy.test.ts`（凭据缺失/需重登/服务商不符、平台与服务器服务商不可用、凭据未就绪、工具不支持、不回退；课堂按 agent 绑定、不可用时移出并提示、唯一角色时只提示、无学伴或开关关闭不查库）、`tests/server/study-companion-turn.test.ts`（教材 A/B、两个学科不串、撤权/删除即时生效、归档与跨账号）、`tests/api/study-companion-routes.test.ts`（PGlite + 真实 Agent 会话存储：开关、开对话写绑定后排队、拒绝他人/归档/他人课程/错学伴角色、后续消息与小时上限、通用消息接口 409、Pro 列表过滤、归档后拒绝但可读）、`tests/agent-runtime/runner-companion-chat.test.ts`（绑定会话只拿学伴工具与提示词、不加载 skill、不做 Pro 预检、写 turn 事件、去掉选项封装；失败码保留且不重排；Pro 会话不变）。
- 调整：`principal-mode`（迁移版本到 26）、`account-deletion-lifecycle`（新表只删本人）、`study-classmates-migration`（仓储读取新列）、`classmates-logic`（解析结果含继承策略）、三个 capabilities 断言。
- 全量 Vitest（`TEST_LOAD_LOCAL_ENV=0`，`--maxWorkers=4`）：**872 个文件通过、17 个跳过；9000 项通过、94 项跳过、0 失败**。下午修复后重跑：**872 个文件通过、17 个跳过；9004 项通过、94 项跳过、0 失败**，`tsc`、改动文件 ESLint（0 错误）、Prettier、i18n、`build:worker` 均通过。`tsc --noEmit` 通过；本批改动的 68 个 TS/TSX 文件 ESLint 0 错误（唯一警告 `use-chat-sessions.ts` 的 `GuidedInteractionMode` 未使用为既有问题）；Prettier 通过；`check:i18n-keys`（12 个语言文件）通过；`build:worker` 通过且 Worker 启动后 runner 正常认领。

### 浏览器验收（2026-10-07，本地托管模式）

一次性 PostgreSQL 17（vector + pgroonga，端口 56433——55433 已落入 Windows 保留端口段）、假登录、假 S3、假模型（不产生任何费用）、Worker 跑 Agent runner；临时环境文件把 `.env.local` 的 145 个变量全部置空，无真实密钥或生产地址。资料：教材 A = 高等数学讲义（calc），教材 B = 数据结构课堂笔记（ds）；学科“高数”含 A、B，学科“数据结构”只含 B；学伴“小林”初始只授权 A，“小周”授权 A+B。浏览器面板处于隐藏状态时页面报告 `visibilityState=hidden`，聊天页（与 Pro 一样）暂停事件流，因此验收时在页面里覆盖了 `visibilityState`；这也被用来模拟断线。

1. **只授权教材 A 不能引用教材 B**：在“高数”问“栈和队列有什么区别”→ 检索后“资料中没有找到”（B 在学科里但未授权）；问“导数”→ 引用 [M1] 跳转 calc 第 3 页。
2. **授权变更与撤权过滤历史**：给小林加授权 B（v2）→ 引用 [M3]（ds 第 1 页）；此时假模型探针报告 B 的原文“括号匹配”在模型上下文中 `present`。撤销 B（v3）→ 下一轮显示“1 份资料已取消授权或删除，相关的历史资料片段已隐去”，旧的 [M3] 变为划线“该资料已不在授权范围内”，资料行只剩《calc-v1》，B 的问题回到“资料中没有找到”，探针报告 `absent`。
3. **同一学伴两个学科不串**：再给小林授权 A+B，在“数据结构”开新对话：问“导数”→ 未找到（A 不在该学科）；问栈 → 引用 ds。
4. **SSE 断线无重复**：发问后 200ms 把页面切为 hidden（关闭事件流），5 秒后恢复 → 按 `lastEventId` 续传，只多出 1 条回答和 1 条检索行（用户 7 / 回答 6 / 工具 6）；整页刷新全量回放后计数完全相同。
5. **设定变更只影响后续**：对话中把小林改名“小林同学”（v5）→ 新回答前出现“学伴设定已更新（v4 → v5）”，新回答署名“小林同学 · v5”，之前的回答仍是“小林 · v4”。
6. **多学伴讨论**：勾选小周并问“请深入讨论一下栈的应用”→ 小周作为“受邀补充”回复一次（带自己的引用），小林随后总结；未勾选时都只有一个学伴回答。
7. **独立模型**：表单“高级：回答模型”列出继承、平台默认（本地未配置显示不可用）、服务器提供的服务商；保存不存在的账号凭据被拒（422 `credential_missing`）；保存服务器 openai 后对话头显示“独立模型：openai:gpt-4o-mini（只作用于实时答疑）”。在数据库里把策略改成已断开的账号（模拟保存后断开）→ 下一轮明确失败并显示“学伴的独立回答模型当前不可用，没有改用其他模型…去学伴设置”，没有任何模型调用。
8. **课堂实时发言**：同一失效策略下，课堂 `/api/chat` 点名小林 → 返回 `notice`（CLASSMATE_MODEL_UNAVAILABLE）且只有老师回答；只有小林一个角色时只返回提示。恢复有效策略后点名 → 小林用自己的 binding 发言。
9. **从课堂跳转**：课堂里问“小林同学，导数是什么？”→ 小林回复下出现“继续问小林同学”（新标签页链接，带课程、页面、`cm-…-r6`、问题原话）→ 打开后问题已预填、显示“来自课堂的问题”、学科自动选中“高数 · 这门课所在的学科”→ 发送后对话记录“本对话从课堂《导数入门》打开”。
10. **重新打开可继续**：离开到学伴页 → 点卡片“课后答疑”→ 历史列表打开该对话 → 记录完整，继续追问正常回答。
11. **取消、失败后续聊、归档**：运行中点“停止”→ 保留已输出部分并显示“已取消本次回答”；早先因本机配置失败的对话再次提问正常回答；归档小林后发消息 409 `STUDY_CLASSMATE_ARCHIVED`，页面显示归档提示、输入框禁用，恢复后可继续。
12. **轮数与工具调用可核对**：Worker 日志每条消息一行 `session … -> succeeded (attempt 1, N tool calls)`（讨论那一轮为 2）；数据库中三个对话的 run 数与用户消息数一致（7/7、6/6、3/3）；`usage_events` 中 29 次调用全部记为 `source=study-companion`、`funding=operator`。Pro 会话列表与状态接口返回 0 条（学伴对话被过滤）。
13. 验收后停止全部服务，删除数据库容器、临时环境文件、测试账号密码文件、假 S3 数据与 PDF。

### 真实模型验收与修复（2026-10-07 下午，用户同意调用真实模型）

环境与上午相同（一次性 PostgreSQL 17、假登录、假 S3），模型换成真实的平台默认文本模型（DeepSeek V4.1 Flash）：`.scratch/b05-acceptance/make-env-real.mjs` 把 `.env.local` 的其余变量全部置空，`DEEPSEEK_*` 不写入任何文件——Next 开发进程从 `.env.local` 读取，Worker 由启动脚本在内存中导出。本地 `.env.local` 没有 OpenRouter 密钥，所以 OpenRouter 只能在生产上用用户自己的账号验证。全部调用约 0.02 美元（`usage_events`：`study-companion` 37 次、`pi-chat-director` 5 次、`pi-chat-child` 2 次，均为 `funding=platform`）。

已用真实模型验证：

1. **检索与引用**：问“导数的定义和几何意义”→ 检索 2 次后回答，引用 [M1] 指向 calc 第 3 页，并按“苏格拉底式”陪学方式以提问收尾。
2. **只授权 A 不能用 B**：问栈/队列 → 检索 3–4 次均未命中（B 未授权），回答明确写“资料中没找到，以下是补充说明”，没有任何 B 的引用。
3. **授权 → 引用 → 撤权**：授权 B 后引用 ds 第 1 页；撤权后再问“把原话念一遍”→ 出现“1 份资料已取消授权…已隐去”提示，旧引用划线，模型说明该资料已不在授权范围、不复述原文，只保留自己上一条的概括。运行中撤权也立即生效（工具每次调用重新解析范围，有时间戳为证）。
4. **两个学科不串**：同一学伴在“数据结构”问第二个重要极限 → 只检索到 ds，回答“资料里没找到”。
5. **多学伴讨论**：勾选小周并要求“深入讨论”→ 小林回答后调用 `invite_classmate`，小周用自己的检索结果补充一次（带自己的引用），小林收尾。
6. **独立模型（平台默认）**：小林设为独立“平台默认”→ 页头显示“独立模型：DeepSeek V4.1 Flash（只作用于实时答疑）”，回答正常。
7. **课堂 Pi 路径**（`NEXT_PUBLIC_PI_CHAT_ENABLED=true`，真实课堂界面发问）：导演 `call_agent` 点名小林（`cm-…-r11`），小林用自己的 binding 回答；把策略改成已断开的账号后，老师与小林同在时返回 `notice`（`CLASSMATE_MODEL_UNAVAILABLE`）且只有老师回答，只有小林时只返回提示、不调用模型。
8. **从课堂继续问**：带课程/页面/角色版本/问题原话打开 → 问题预填、学科预选“高数 · 这门课所在的学科”→ 模型先 `read_course_page` 读课堂页，再检索资料作答。
9. **流式中断线**：回答流式输出时切到后台 12 秒（连接显示“正在重新连接…”）再切回 → 续传后与整页回放完全一致（回答 2、工具 2、字符数 982）。
10. **轮数可核对**：10 个对话的 run 数、`study_companion_turn` 数、`session_end` 数都等于用户消息数。

真实模型暴露并已修复的问题：

- **提示词让模型凭资料标题跳过检索**：原规则“涉及学生资料里的内容时先检索”，模型只看得到标题，就凭“calc”判断栈不在资料里。改为“每个新的知识性问题都先检索，不要凭标题或之前的检索结果断定资料里没有”。
- **撤权被模型理解成“我引用错了”并道歉**：隐去占位文字改为“学生已取消这份资料的授权…当时基于它的回答并没有错，不用更正或道歉；只是现在不能再引用或转述它”，系统提示的撤权说明同步。修改后模型只说明资料已不在授权范围。
- **聊天页按纯文本显示 Markdown**：真实模型大量使用加粗、列表、表格和 LaTeX，页面原样露出 `**` 与 `$$`。新增 `components/study/companion/CompanionAnswer.tsx`，用工作台同款 Streamdown（CJK 友好强调、`.wb-prose` 样式）渲染，并加入 `remark-math` + `rehype-katex`（KaTeX 已是依赖、样式已全局加载；新增的只是这两个插件及其依赖链）。引用 [M3] 先转成 Markdown 链接，再在链接组件里渲染成阅读器链接或划线；独占一行的 `$$…$$` 规范为块级公式。提示词改为“公式用 LaTeX，行内 `$…$`，独立成行 `$$…$$`”。
- **流式中途渲染残留 `[blocked]`**：输出到 `[f(b)-f(a` 时，未闭合的方括号被补成链接并被安全检查拦下，结束后 Streamdown 沿用了中间渲染结果。回答结束时重新挂载渲染器（按流式/完成切换 key）。
- **引用的授权状态不随页头刷新**：Streamdown 缓存已渲染的块，撤权或重新授权后旧引用的划线状态不变。引用解析函数改由 React Context 传入（Context 变化会穿透缓存）；页头也在每轮的 turn 事件和回答数变化时重新读取，事件成批到达时也不会漏掉。
- **工具调用附带的过渡语**（DeepSeek 常在调用检索时附一句英文 “I'll search the materials first.”，提示词约束无效）：与检索/阅读工具在同一条消息里的文字改为灰色过程行（与“检索资料：…”同样式），不再作为一次回答显示；带邀请工具的那条（正文 + 邀请）仍是回答。
- **“N 次回答”数的是模型消息条数**：过渡语也被计入，改为按成功结束的 run 计数（失败轮不算）。
- **对话列表标题露出讨论选项封装**：首条消息带讨论对象时，列表标题显示 `[[companion-options…`；改为解码后取问题原文。
- **模型选项会列出 embedding 模型**：服务器服务商的模型列表现在排除 `STUDY_EMBEDDING_MODEL`，只剩 embedding 模型的服务商不再出现；保存/使用时服务器服务商的模型也必须在配置列表内，否则 `model_unresolvable`。

排查结论：

- **上午 Next 开发进程内 runner 失败的根因**：runner 的模型调用要经过网关的服务商并发槽位（`acquireDeploymentQuota` → `PostgresGenerationLimiter`，表 `generation_provider_slots`），Web 进程用的是 `app_web` 连接，没有该表权限（`42501 permission denied`），网关再按错误文本把它误判为 `MODEL_AUTH_FAILED` →“模型凭据缺失或无效”。托管模式下 Web 进程本就不应持有 Worker 凭据或运行 runner（`instrumentation.ts`），生产 compose 也确实没有给，因此不影响生产。网关把这类非服务商错误误判为凭据错误是共用代码的问题，已单独记为后续任务，B05 不改网关。
- 验收中途发现用后台任务停止 Worker 并未结束其 node 进程（Git Bash 下 `exec` 不替换进程），一度有多个旧代码 Worker 同时认领会话；之后全部按 PID 停止、只留一个，受影响的提示词检查（检索、撤权、公式、过渡语）都在单一新 Worker 上重测，上面的结论以重测结果为准。
- 课堂里小林说“我查过人教版教材”：来自本次测试人设“会主动指出自己引用的资料”，课堂发言没有资料工具，属于 B04 课堂人设的已知局限，未改。

### 发现的问题

- **本地套件让 Web 进程也跑了 Agent runner**：B04 的本地环境脚本给 Web 也设置了 `WORKER_DATABASE_URL`，Next 开发进程于是也启动 runner；本次第一条消息被 Web 进程认领，调用前失败（`PRO_MODEL_AUTH`，假模型未收到请求），同一连接在 Worker 进程里调用正常。生产 compose 的 Web 不设置 `WORKER_DATABASE_URL`（runner 只在 Worker），因此不影响生产；B05 套件已改为与生产一致。根因见上节“排查结论”（Web 连接无服务商槽位表权限，网关误判为凭据错误），生产不受影响。
- 浏览器在服务重启时会放弃事件流（EventSource 进入 CLOSED），聊天页原本不会重连；已改为 3 秒后用最后的事件 id 重新连接。
- 模型选项会列出只用于 embedding 的服务器服务商：已在下午修复（见上节）。

### 未验证

- 服务器配置的服务商作为独立模型的真实调用：生产与本地都只有平台默认的后备服务商（不提供选择），上午用假模型验证过该路径。
- 账号删除清单中新表的删除只在 PGlite 夹具中验证。
- 生产环境：见下方“上线记录”与“生产登录验收”（已通过）。

### 回退

- 运行时止损：把 Web 与 Worker 的 `ZHIYU_STUDY_COMPANION_CHAT_ENABLED` 置空后 apply——课后答疑入口与接口消失（404），课堂里学伴恢复用请求模型（独立模型策略不再读取），已存在的学伴会话不会被当成 Pro 运行（runner 仍识别绑定并明确失败）；历史数据保留。
- 版本回退：回到 release-20261007c 镜像；v26 的表和列保留不用（旧代码不读 `model_policy`，也不认绑定表——旧 runner 会把学伴会话当 Pro 会话，但旧版没有入口创建新消息，旧版 Pro 列表会显示这些会话）。

### 上线记录（2026-10-07）

1. 只读核对生产：v24/v25 checksum 与仓库一致，`study_companion_chats` 与 `model_policy` 尚不存在。
2. Supabase `apply_migration`（`accounts_v26_study_companion_chats`）执行仓库 v26 SQL 原文（本地导出并核对 sha256 = `354fbeed…`），写入 `app_schema_migrations(26, 354fbeed…)`。核对：`study_companion_chats` 强制 RLS；授权只有 `app_web` 查/插/删、`app_worker` 只读（anon/authenticated 无）；`app_worker` 可读 `study_spaces`/`study_space_materials`/`study_space_courses`/`study_classmate_materials` 且有对应策略；`app_worker` 可执行 `study_knowledge_search`；`study_classmates.model_policy` 为 jsonb。**未运行 `pnpm accounts:migrate`。**
3. main 快进到 `62ba7ede` 并推送 tokyo（`98c42e9c..62ba7ede`）；本机构建镜像 `release-20261007d`，`docker save | gzip | ssh docker load` 装入服务器。装入前磁盘 68%，装入后 78%，未删旧镜像。
4. 确认 0 个进行中的生成任务；备份 `.env.hosted.local.bak-20261007d-pre`、`docker-compose.supabase.yml.bak-20261007d-pre`（均指向 release-20261007c）；服务器 compose 换成仓库版本（与旧版只差新开关透传）；env 改镜像标签并加 `ZHIYU_STUDY_COMPANION_CHAT_ENABLED=1`；`supabase-compose.sh apply --tier 4 --mode background --accept-jobs --confirm-writes`。
5. 结果：三个容器 healthy；readiness `accountsVersion 26`、`liveWorkers 2/2`；Web 与 Worker 都读到新开关；`/api/study/capabilities` 返回 `companionChat: true`；Worker runner 正常启动，日志无错误。
6. 回退：恢复两个 `*.bak-20261007d-pre` 后 apply（回到 release-20261007c）；或只把开关置空后 apply。v26 的表和列保留。

### 生产登录验收（2026-10-07，用户已登录 admin 并连接 OpenRouter）

在用户的 admin 账号上，用学科“资料功能验收（可删除）”里已建索引的《二次函数讲义-验收》（英文讲义）和课程《光合作用原理》：

1. 给学伴“小林”授权该讲义 → 课后答疑页学科自动选中、没有“声音不可用”提示（B04 音色绑定有效）。用平台默认（继承）提问：只用中文关键词时检索不到英文讲义，回答如实说明并给补充说明（关键词检索的已知局限，B03 未做语义检索）；用 vertex / parabola 检索后引用第 1、2 页，公式由 KaTeX 渲染，中文过程说明显示为灰色过程行。
2. 独立模型：保存“OpenRouter 凭据 + providerId=deepseek”被拒（422 `credential_provider_mismatch`）；保存“OpenRouter 凭据 + `deepseek/deepseek-v4-flash`”通过（v3）。下一轮出现“回答模型已变为：openrouter:deepseek/deepseek-v4-flash”，页头显示独立模型；`usage_events` 中该轮记为 `openrouter:deepseek/deepseek-v4-flash`、`credential_kind=vault`、`funding=subscription`（用户自己的账号），之前各轮为 `platform:zhiyu-default-text`。
3. 课堂实时发言：对《光合作用原理》调用 `/api/chat`（请求模型为平台默认），点名小林 → 小林发言记为 `chat-adapter-stream` + `openrouter:deepseek/deepseek-v4-flash`（vault），即课堂里也用了它自己的独立模型。
4. 从课堂继续问：带课程/页面/角色版本/问题打开 → 问题预填、显示来源课程；该课程未挂到任何学科，所以学科不预选（正确）；选学科后先 `read_course_page` 读课堂页再回答。
5. 撤权：撤销讲义授权后回到第一个对话再问“把原文再念一遍”→ 出现“已隐去”提示，7 个旧引用全部划线，`read_material` 被拒，模型说明资料已不在授权范围、不道歉、不复述原文。
6. 核对：两个对话的 run 数 = 用户消息数（4/4、1/1），无失败；本次生产验收共约 0.003 美元（平台约 0.0016，用户 OpenRouter 约 0.0016）。
7. 验收后把小林恢复为原设置（继承模型、无授权资料，版本升到 v5）；两条测试对话保留在该账号里。

观察：页面刚加载、尚未就绪时点击发送，有一次没有发出去（输入框保留了文字，再点一次正常），未深究。

### 下一批（B06）前置条件

- B05 合并上线（或至少合并）。B06 的学习事件可以从 `study_companion_chats` + 会话事件（`user_message`、`study_companion_turn`、工具结果）派生“课后答疑”记录；偏好（如讲解方式）可在 `companionSystemPrompt` 中按同样“每轮服务端解析”的方式注入。
- 记忆/偏好进入学伴上下文时沿用本批规则：只带摘要与引用，按当前授权重新过滤，不改写历史消息。

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

### 上线后修复：角色音色切换（2026-10-07，用户报告）

用户报告：平台默认语音（MiniMax Speech 2.8 Turbo）下，首页“课堂角色配置”切换老师音色后显示“无可用音色”、设置里的默认语音模型被取消、生成课程报 `MEDIA_CONFIG_KEY_REQUIRED`；音色框里还列出 2.8 HD、2.6 HD 等不属于默认模型的同名音色。

- **原因 1（老师）**：老师音色框点选时调用 `setTTSProvider`，把平台默认改成“用户自配 MiniMax”，而用户没有 MiniMax key → 可用列表为空、生成缺密钥。
- **原因 2（同学/学伴）**：同学和学伴的选择一律存为“用户自配”，试听也固定走用户凭据；在平台默认下同样无法使用（后台生成会把它冻结进课程）。
- **原因 3（音色范围）**：音色框按厂商列出全部模型分组；选到非默认模型的音色同样需要用户自己的 key。
- **原因 4（刷新丢失）**：每次加载同步服务端配置时，按用户自己的配置校验 TTS 服务商，MiniMax 无 key 被判无效、音色被重置成 `default`，随后平台默认只恢复了服务商、没有恢复音色——老师音色每次刷新都丢。
- **修复**（`dac9a82d`、`073b8161`）：平台默认 TTS 选中时，该服务商只提供平台模型的音色并带平台绑定（`scopeProvidersToPlatformTTS`，首页角色栏、课堂讨论语音、学伴表单、自动生成的可选音色、旁白兜底共用）；老师点选只改音色；同学/学伴的选择与试听带平台绑定；已保存的、用户自己配置无法提供的旧选择在播放与生成时回退，不再冻结进新课（`roleVoiceBinding`，用户自己有该厂商 key 时保留原选择与计费归属）；加载同步保留平台服务商上的音色，`default` 修复为平台默认音色。
- 测试：`tests/audio/platform-tts-selection.test.ts`（范围、平台绑定、旧选择回退、自有 key 保留）、`tests/store/settings-server-sync.test.ts`（刷新保留老师音色，修复前失败）；全量 Vitest 865 文件通过、8955 项通过、0 失败；`tsc --noEmit`、改动文件 ESLint 通过。
- **生产验证**（release-20261007，用户账号，不产生费用）：老师音色框只剩“MiniMax TTS · Speech 2.8 Turbo”一组 10 个音色；连续两次切换老师音色（温润男声 → 精英青年）后仍是平台默认；预设模式下 5 个系统角色和学伴小林都有音色，改知微、小林的音色均保存为平台绑定（`speech-2.8-turbo`）；拦截试听请求确认学生音色走 `modelSource: platform`（未实际发送）。同时发现刷新后老师音色被重置（原因 4），修复后以 release-20261007b 再次上线：刷新后残留的 `default` 自动修复为平台默认音色，切换后刷新仍保留。
- **补充**（`7e8f7333`，release-20261007c）：平台默认音色 `male-qn-qingse` 原本不在 MiniMax 音色目录里，音色框显示原始 ID，切走后无法再选回默认男声；已加入目录（“青涩青年”，放在列表末尾，不影响按序号自动分配的音色）。生产验证：显示“青涩青年”→ 切到电台男主播 → 刷新仍是电台男主播且仍为平台默认 → 切回青涩青年。
- **上线**：三次都没有迁移，只换镜像标签（备份 `.env.hosted.local.bak-20261007-pre`/`-20261007b-pre`/`-20261007c-pre`，compose 与仓库一致未改）；每次切换前确认 0 个进行中任务，切换后三个容器 healthy、readiness ready（accountsVersion 25、2 个 Worker）。磁盘到 89% 后经用户同意删除 release-20261007、20261005c、20261006 镜像，当前 68%；保留 20261007c（当前）、20261007b、20261006f、20261006e、20261006d。
- 验证后首页恢复为“自动生成”、老师音色恢复为默认“青涩青年”、清除测试中设置的同学/学伴音色。
- **生产真实生成验证**（2026-10-07，用户要求）：首页预设模式，老师改为温润男声、知微改为御姐音色、勾选学伴小林并改为温暖少女，开课“声音是怎么传播的”（2 页讲解）→ 越过原来报错的“生成课程大纲”，后台任务 `e3c5ca96…` 一次成功：2/2 页、0 警告、约 66 秒。任务冻结的输入：旁白 `source: platform / zhiyu-default-tts / Chinese (Mandarin)_Gentleman`；知微 `female-yujie`、小林（`cm-be8857466f44d41b-r1`）`Chinese (Mandarin)_Warm_Girl`，都是平台绑定 `speech-2.8-turbo`；未改音色的悦扬不带绑定，由平台按序分配。16 段讲解全部有音频（16 个 audio/mpeg 资源），课堂打开显示 2 页与启衡、知微、小林、悦扬，播放时音频加载 200。离开课堂后首页仍是“预设模式 + 小林”。验证后首页恢复为“自动生成”、默认老师音色、清除测试音色；新课“声音是怎么传播的”保留在账号中。

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
- 依赖：`remark-math`、`rehype-katex`（下午为学伴回答的公式渲染新增；KaTeX 本身已是依赖）。
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
