# Supabase 存储迁移与并发验收记录

记录日期：2026-09-21，最新接续 2026-09-23，Asia/Shanghai。状态：**按用户最新范围，数据库迁移与核心功能验收已收口；原完整 T8、T9 均未完成，尚未正式上线。** 当前结论见[数据库功能验收收口](2026-09-23-supabase-database-functional-acceptance.md)；以下保留各时点原始记录，不将此前待验状态或局部结果改写为全矩阵通过。

依据：[实施计划](../plans/2026-09-20-supabase-storage-and-generation-capacity.md)、[T0 基线与备份](2026-09-21-supabase-storage-capacity-t0.md)、[本机部署运行手册](../guides/supabase-local-compose.md)。本记录按已取得的证据填写；后续实测结果应追加时间、对象标识、操作与结果，不以配置、健康检查或单测替代真实功能验收。

## 已核实的数据迁移结果

下表来自本次接续任务对 Supabase 的实时 SQL 核对。迁移账本的完成状态只证明账本所覆盖的迁移步骤，不代表 T8/T9 功能与负载验收完成。

| 检查项 | 已取得的结果 | 说明 |
| --- | --- | --- |
| `storage_migration_runs` | `complete` | `completed_at = 2026-09-21T07:26:06.444897Z`，即北京时间 15:26:06 |
| 已验证对象 | 1,484 | 迁移账本中的 verified 对象 |
| 已验证对象字节数 | 511,178,031 | 与 T0 资产字节总数相符 |
| 课程 stages | 116 | 原始基线 115 + 先前验收新建 1；不能将多出的 1 门误报为迁移数量不一致 |
| 场景 scenes | 459 | 与原始基线相符 |
| 匿名课程归属 | 0 | 旧匿名课程迁移后不再保持匿名归属 |
| 删除状态 | 64 条 deleted | 与 T0 tombstone 数量相符，未将已删除课程恢复为正常课程 |
| Storage buckets | 3 个，均 `public = false` | 资产、材料、课堂数据的 bucket 均保持私有 |

此处未附带凭据、连接串、私有对象签名 URL、真实管理员标识或用户资料。对象总量对账不替代逐条业务引用、账号隔离、素材读取及删除生命周期的功能验收。

## 本机运行与就绪检查

2026-09-21 **21:49（北京时间）**，Tier 4 聚合 readiness 通过，取得以下结果：

| 项目 | 结果 |
| --- | --- |
| Account schema version | 18 |
| Generation schema version | 4 |
| Worker replicas | 2 个，均有有效心跳 |
| 私有 bucket 访问 | 3 个通过 |
| 当前容量档 | Tier 4；不是 16 并发验收 |

readiness 说明数据库架构、worker 心跳和 bucket 可访问。它不证明课程生成完成、不证明 UI 可操作，也不证明持续负载下的连接等待或模型配额符合要求。

## Web 连接失败的诊断与最小修复

本次排查发现 Web 日志含 `timeout exceeded when trying to connect`，并出现明确的 `getaddrinfo EAI_AGAIN`。在 Web 容器内独立执行 Supabase pooler 域名 DNS lookup，曾在 5,009 ms 后返回 `EAI_AGAIN`，默认解析器为 Docker 的 `127.0.0.11`。同一域名在 worker 中 8 ms 返回成功；Web 直接查询 `223.5.5.5` 与 `119.29.29.29` 均成功。默认 Docker 解析器随后也曾恢复，表明故障具有间歇性。

Web 默认路由正常；当时数据库活动连接以 idle 为主，无长事务证据。代码检查显示 hosted provider 初始化跳过 DDL，owner-bound queryable 使用单连接事务并在 `finally` 释放。现有证据指向 DNS 故障，不能仅凭连接超时就归因为 Web `max=5` 连接池耗尽。

修复位于 `scripts/supabase-compose.ps1`：

- 当仓库存在 `docker-compose.dns.local.yml` 时，所有 Compose 操作加载这个已有本地覆盖文件，避免重建新栈时丢失已配置的 DNS。
- 新增 `Apply` 操作，使用已有镜像应用运行时配置，保持两 worker；需要修改源码或构建期变量时仍执行构建流程。
- `Apply` 与 `Start` 使用相同的写入门禁，不取消 `AcceptJobs` / `ConfirmWrites` 检查。

用于应用上述运行时配置的命令如下；执行时必须保持实际需要的容量与前台/后台模式。命令本身不是功能验收通过的证据：

```powershell
./scripts/supabase-compose.ps1 -Action Apply -CapacityTier 4 `
  -GenerationMode Background -AcceptJobs -ConfirmWrites
```

修复验证：PowerShell 语法解析通过，`-Action Config` 通过，`tests/config/supabase-compose-contract.test.ts` **10/10 通过**。测试使用 Codex bundled Node 运行；系统默认旧 Node 启动 Vitest 时缺少 `node:util.styleText`，未将该环境失败计为测试通过。

### DNS 恢复后的延迟与连接复用修复

Web 容器独立探测的三组结果：数据库 DNS 313/604/471 ms，Supabase API DNS 450/632/566 ms，JWKS HTTPS 请求约 1.7/2.6/2.3 秒，均返回 200。PG 新连接耗时约 8.14/9.98/5.68 秒，随后 `SELECT 1` 为 710/424/899 ms。另一组分阶段观测为 TCP 1.88 秒、TLS 2.629 秒、完成认证至 ready 6.483 秒；复用连接连续查询为 461–863 ms。上述是探测样本，不是 P95 或完整业务请求延迟统计。

根据握手成本，将 hosted 连接池空闲保留时间从 10 秒调整为 60 秒，以减少 UI 操作间隙的重复建连；Web/worker 池上限仍为 5/3，connect/checkout deadline 仍为 10 秒，legacy idle 仍为 10 秒。未延长 worker 租约或心跳等待，未更改鉴权策略。`with-owner` 仅记录固定的 DNS、timeout、SQLSTATE、connection、unknown 分类及受限错误码，不输出原消息、堆栈或连接串。三个相关测试文件共 21 项通过；部署后的真实请求改善仍需实测记录。

### 已撤回的认证查询优化与真实 PG 反证

曾尝试将 hosted 账号与 session 状态合并为一次裸 SQL 读取，模拟测试共 48 项通过，但随后在真实 Web `app_web` 连接探测时得到 **0 行**。这不是优化通过：`app_accounts_web_select` 的 RLS 条件为 `owner_id = app_internal.current_owner_id()`，裸查询未绑定 owner，因此无法看见账号。模拟数据库返回固定行，没有覆盖该 RLS 行为；不能据此宣称一次查询优化已生效，也不能把空结果上的 `every(...)` 布尔值当作撤销校验通过。

本轮已撤回该快路径及其专用模拟测试，保留原有 `session.ts` 认证查询和 fallback 行为；没有放宽 RLS、增加权限或仓促增加认证 RPC 迁移。已验证的连接复用与脱敏日志改动独立保留。后续如优化授权查询，须使用正确 owner 绑定并补真实 PostgreSQL/RLS 集成证据，不能仅用 mocked query 验收。

## T8：五类独立真实功能验收（未完成）

### 2026-09-21 接续验收现场记录

- Chrome 普通后台真实提交：job `da675064-7478-4600-bf26-f61ff2e28c09`，course `8d67b109-e0c3-4ee8-842d-288dcb76ec4f`，北京时间 21:53 提交，模型快照 201、媒体配置 200、生成提交 202。已操作“后台继续并返回”，刷新后恢复进度。第 1 页内容、动作、媒体、语音检查点成功；第 2 页 TTS 步骤最终失败，`GENERATION_STEP_FAILED`，worker 最终日志记录 `lease_lost`、执行约 1,120 秒。该日志可能覆盖最初步骤错误，根因仍在核查，不能将第 1 页成功视作后台验收通过。
- 旧首页一次并发读取 52 门课程封面，导航后仍继续请求，曾阻塞页面。`getFirstSlideByStages` 改为最多 3 路，首页先显示课程列表、异步补封面，并在导航/账号更换时停止安排旧任务。相关缩略图与全局页面测试共 12 项通过，TypeScript 通过。
- 22:12 仅替换 Web 容器以保留运行中 worker，Web image `sha256:8df6aab559418b4199ef6b87f6a5864971cf3e32436c0f4d92bddf538f3af4d8`。构建已完成 Web 与 worker，但此时新 worker 尚未应用，不把构建成功写成容器更新成功。
- 新 Web 上 Pro 材料 `supabase-pro-material.txt`（本次生成的 290 字节无敏感测试文本）上传返回 201，material `mat_mcvt6njkfc9n20gsa8g0tndm0c`，服务器记录约 40.6 秒。已创建独立 Pro session `817cf825-aa1b-4ee2-b710-42b08cd0181a`，工作台进入“进行中”；完成/课堂验收仍待记录。
- 同一 Pro 会话在 22:32:27.412 请求取消，worker 于 22:34:40.510 记录 `cancelled (attempt 3, 1 tool calls)`，从取消请求至收尾日志约 133 秒。此前 22:31:03–35 反复出现心跳连接池 checkout 超时，旧 attempt 收尾与新 attempt 领取重叠；不能把最终取消成功当作取消延迟合格或 Pro 生成完成。随后实时 SQL 确认会话为 `cancelled`，普通 generation jobs 的 running/queued/cancelling 数为 0，agent sessions 的 running/queued 数为 0，取得无活动生成任务的部署窗口。本次检查未重启容器或强制终止外部请求。
- 七项指定课堂/教会学伴测试文件共 42 项通过；storage 包本轮 1,016 项通过、125 项跳过；真实隔离 PostgreSQL 并发/删除测试 4 文件 37 项通过，详见 [PG 验证报告](2026-09-21-capacity-deletion-pg-verification.md)。这些均不替代下列浏览器及真实 provider 验收。
- 根仓库全套 8,491 项：8,423 通过、67 跳过、1 项默认 5 秒超时。定位到 `database-chat-cutover` 竞态测试把昂贵动态导入计入正文限时；已将该用例冷加载移至局部 `beforeEach`，保留隔离、锁门闩及全部断言。修复后文件 40/40 通过，定向用例连续三个全新 Vitest 进程通过；未扩大 timeout 或跳过测试。
- 同 job 的多个 lease 事务会占用连接后等同一行锁。新增 `GenerationTransactionQueue`，在 checkout 前按 job 排队，心跳优先，外部调用保持队列外。相关 58 项测试通过；隔离 PostgreSQL 两连接池成功复现旧问题，修复后 2 项行锁验证及 1 项完整三场景流水线验证通过。真实课程恢复仍待新版容器验证。
- 22:25 左右确认多标签页 SSE 槽位问题：Web 6 条 HTTP 入站，PG 无长事务/锁等待；关闭独立 Pro 标签页后积压 runtime 请求成批返回、旧课程加载完成。已完成 owner/session/freshness 三通道隐藏时关闭流与时钟、恢复时按 cursor 或 manifest 追平的修复，相关 60 项测试逐轮通过，含隐藏启动、未应用 backlog 重放、高精度 cursor、迟到快照、重连和卸载清理；新镜像应用后的多标签真实复验待完成。
- 代表性旧课程 `94c0ee87-31af-4db5-af39-93f7eb414220`（二元一次方程入门）完整课堂已打开：四页导航和内容可见；实际点击“无整数解”预设后显示 `2x+4y=7`、`y=1.25`、无整数解，白板可打开/最小化；PPTX 导出显示“导出成功”。播放按钮可切换，但媒体完整播放、刷新重建后复验尚未完成。
- 教会学伴实际从讨论入口选择学伴并开始；RuntimeStore session 创建 201、记录写入 201；`POST /api/learning/teach-back` 返回 503，错误为 `permission denied for table generation_provider_slots`。该权限故障正在修复，教会学伴不能标为通过。失败活动为 `teach-back:tb-XC0si8fghFurg0C65W4E5`，关联本次后台课程。
- 云端临时管理员删除验收脚本已完成默认零写入 dry-run，但本机私密配置缺 `SUPABASE_SECRET_KEY`；已请用户在私密文件补齐，未要求聊天发送密钥。尚未创建或删除云端测试账号，真实管理员保持不变。

必须按实施计划第 9.1 节，分别使用真实登录账号、Supabase 数据和私有 Storage 验收。以下状态截至本报告初稿均为**待完成**，不沿用历史通过结论，也不把一条后台任务当成多类证据。

| 保护项 | 当前状态 | 待填写的独立实测证据 |
| --- | --- | --- |
| 普通前台生成 | 未验收 | 前台配置；实际生成、进度、取消/失败处理；课程/媒体落库；进入课堂、刷新重开；课程 ID 与时间 |
| 普通后台生成 | 未验收 | 提交、排队/执行、关闭再返回、完成、取消及恢复；任务/课程 ID；worker 状态；课堂刷新实测 |
| Pro 生成 | 未验收 | 现有工作台材料与模型配置、会话事件、确认/取消/恢复、内容与媒体落库、打开课堂；会话/课程 ID |
| 完整课堂 UI | 未验收 | 三类新课程及代表性旧课程；布局、导航、播放、媒体、聊天/白板、练习/反馈、已启用编辑/导出；刷新及容器重建后再打开；截图/操作清单 |
| 教会学伴 | 未验收 | 完整选择至结束流程、追问/反馈/引用、暂停恢复、失败重试、历史与刷新、账号隔离；`teach-back:*` 事件与 learner/课程关联；旧记录抽检 |

T8 还需记录新业务数据只写入 Supabase、旧源库未新增写入的核对证据。任何保护项失败或未验证时，T8 保持未完成。

## T9：4 → 8 → 16 真实容量验收（未完成）

当前只取得 Tier 4 readiness，尚未取得符合计划的 16 根任务真实负载报告。保持两 worker，逐档记录；通过前一档完整 T8 回归后再推进下一档，不将配置值当作实际达成吞吐。

| 档位 | 目标全站根任务 / 每用户 | 每 worker 并发 | readiness | 真实负载及五类复验 |
| --- | --- | --- | --- | --- |
| 4 | 4 / 2 | 2 | 2026-09-21 21:49 通过 | 待完成 |
| 8 | 8 / 2 | 4 | 待记录 | 待完成 |
| 16 | 16 / 2 | 8 | 待记录 | 待完成 |

| 必须采集的指标或场景 | 结果 / 证据位置 |
| --- | --- |
| 16 根任务至少一轮真实 provider 完成数、失败率、实际运行峰值 | 待采集 |
| 普通后台 + Pro 混合负载；前台同步入口共享全局/个人额度 | 待验收 |
| 每用户不超过 2、全站不超过档位上限、无饿死/重复提交 | 待验收 |
| P95 排队时长、完成时长、数据库池等待 | 待采集 |
| 429、供应商配额/并发限制、重试与重复收费 | 待采集；如受限，记录实际供应商与限制，不宣称真实 16 通过 |
| CPU/RSS、Docker 内存峰值、OOM、租约丢失、连接耗尽 | 待采集 |
| 负载期间课堂与教会学伴可操作性和延迟 | 待验收 |
| Tier 16 五类保护能力的独立复验 | 待完成 |

计划中的内存峰值低于分配值 75%、池等待 P95 小于 1 秒等数值是验收目标，本文不将其写成实测结果。

## 旧源与回退保护

旧项目及其原数据库、持久卷、备份仍是受保护的回退来源。在 T8 完整通过前不得删除或覆盖旧源；本次 DNS 修复只作用于独立的 `openmaic-supabase` Compose 项目，未修改旧源数据。不得使用 `down -v`、卷清理、删除真实管理员或清空旧库完成切换。

T0 已记录数据库 dump 的独立恢复校验与备份哈希，详见 [T0 报告](2026-09-21-supabase-storage-capacity-t0.md)。私有备份目录为 `D:\ZZGG_Innovation_Project\OpenMAIC-main-backups\t0-20260921-095639`；其中包含私有配置的归档继续留在仓库外，不上传或写入本报告。

验收后如考虑回退，须先盘点 Supabase 切换后的新增写入，避免恢复旧快照而丢失新增课程。本文未执行数据回滚，也不授权丢弃新数据。

## 后续更新规则

逐条补入实际操作时间、模式、脱敏对象 ID、结果、日志或截图位置及失败原因。只有 T8 五类全部通过、T9 真实容量与扩容后复验完成，才将本文状态更新为整体通过；外部额度不足或其他无法验证项须明确保留为未完成。

## 2026-09-23 重启后的接续实测

用户重启 Docker 后，以 `scripts/supabase-compose.ps1 -Action Start -CapacityTier 4 -GenerationMode Background -AcceptJobs -ConfirmWrites` 顺序重建并替换 Web/两台 worker。首次聚合 readiness 因探针容器未继承本地 DNS 覆盖而失败；为本地 `docker-compose.dns.local.yml` 的 `supabase-readiness` 补同样的两个 DNS 后，schema v19、两个 worker 心跳与三个私有 bucket 的 readiness 通过。此时 Web/worker 容器实际镜像分别为 `sha256:a57e9d8ef70bb2ce63d0d250f10347173ee5ecb483da100b3d93cd3c5f248248` / `sha256:0bd881f33ee4443dd8b6a66f3df381da9bd703c680acbbc2769dc29f740b616e`；构建日志见 `.temp/supabase-restart-build-20260923.log`。

普通后台 Chrome 实测第一次任务 `b856a998-1d97-4ace-b0d8-f5b34034bd85` 因测试提示强制只生成一个教师，模型输出不满足应用的 2–5 角色校验而在 `agents` 步骤失败；该失败不是容量或 Storage 故障。修正提示为一位主讲教师加一位安静助教后，job `0c4303fd-8a9b-4361-b02a-cd9c01430c9a`、stage `3edb7d54-c8b0-4e2f-965f-00b156c589f5` 于 01:19:57 UTC 成功，1/1 页就绪。六个 TTS 子步骤及图片生成步骤成功；`generation_job_assets` 七个引用均有私有 `zhiyu-assets` 对象。Chrome 从新 URL 重开课堂显示一页内容，生成图片对应 `img.complete=true`、自然宽度 1280，图片和语音资产接口均返回 200，播放按钮实际进入暂停状态。首页卡片曾在原标签页保持旧的 0 页快照；重开课堂的读取成功是单独验证，不把旧标签页当成刷新恢复证据。

代表性旧课堂 `94c0ee87-31af-4db5-af39-93f7eb414220` 在新容器里再次显示四页，实际操作“无整数解”预设、配对得分与暂停。教会学伴新活动 `teach-back:tb-9es-ZLykwBMk9ilh80fe7` 的准备/评价接口均返回 200；提交一次解释后，页面显示逐项依据、未涉及知识点和学伴反馈，该轮正常结束。继续提问产生 `teach-back:tb-cFacVMHLcS5xjtH9JhzYR`；刷新课堂后，学习反馈异步读取四个活动，显示三条已结束和一条等待解释，实际出现“恢复练习”。读取过程因四组记录串行往返较慢，等待完成前的“没有记录”文案不能当成最终空历史。两个新活动分别有 6/2 条云端 runtime 记录，解析与投影均有效。

该过程中，旧课堂的临时语音请求 `POST /api/generate/tts` 在后台模式返回 409 `BACKGROUND_GENERATION_REQUIRED`，浏览器 `DiscussionTTS` 报错。已将这一独立媒体请求设为后台可用，仍经过原有用户认证、来源检查及 PostgreSQL 全站/个人独立任务租约；普通课程生成入口仍为 409。守卫回归 7/7 通过，TypeScript `--noEmit` 通过；新镜像部署后的语音实际复验仍待记录。

云端账号删除生命周期已真实通过。预检确认私有 bucket、Auth Admin 凭据可用、原管理员 1 位，零写入。之后仅创建两位随机、带本次 run 标记的临时管理员、两门 fixture 课程及两个专属对象（其中一个由两位共同引用）。A 删除时注入 Storage 回调故障并确认持久化重试，实际删除后 B 共享对象仍可按原字节下载；注入 Auth 回调故障后按本次临时邮箱恢复并重试。B 删除后两个对象均回收、两位临时 Auth 用户均消失、tombstone 保留，原管理员仍在。网络抖动中按同一精确 manifest 恢复，没有创建第三位账号。最终本地清单 `.scratch/cloud-deletion-proof-30191821-0185-4a2b-ab70-3fdaf02c084d.json` 的 `phase=complete`、两位 `completed=true`，复核说明见 `.scratch/cloud-deletion-lifecycle-proof-review.md`。该凭据曾在聊天中提供，验收结束后应轮换。

根仓库全套测试的本轮第一次结果为 8,510 项中 8,439 通过、70 跳过、1 失败；失败文件是语音守卫测试，它在运行中读取到修改前模块。修改完成后该文件单独 7/7 通过；需在代码不再变动后完整重跑，不能将首次全套退出 1 记作通过。容量仍是 Tier 4；普通前台、Pro、Tier 8/16 实际负载与扩容后五项回归尚未完成。

### 2026-09-23 第二次接续：语音实测及 Pro 材料复用缺陷

主机约 10:38 重启，打断一次进行中的全套测试和 Chrome 会话。重启前 Docker 构建已将语音修复写入 Web/worker 新镜像；恢复后实际容器镜像为 Web `sha256:a87883550769e055418c37244a3721e91321aae1c54a26d2c81f3f8bc08436b1`、两台 worker `sha256:18982f55990fdaaf7ef874885e93d89630bc6189094a2565744c4a0c1fa71cd3`。聚合 readiness 返回 `ready=true`、账号 schema v19、生成 schema v4、两台 worker 心跳有效、三个私有 bucket 可达。

使用私密测试账号通过 Supabase Auth password grant，在后台模式向本地新版 Web 的 `/api/generate/tts` 提交独立、无课程根任务的中文语音请求。平台默认 MiniMax TTS 返回 HTTP 200、MP3 58,740 字节，错误码为空；此前的 `BACKGROUND_GENERATION_REQUIRED` 409 已在真实 API 路径消失。请求后云端同步任务槽无活动租约。由于重启后的 Windows 浏览器自动化无法可靠识别 Chrome URL 并停止操作，这项是**真实 API 证据**，不冒充课堂播放按钮的 UI 复验。

同一私密测试账号使用原 Pro 工作台已保存的模型引用及先前上传的材料 `mat_mcvt6njkfc9n20gsa8g0tndm0c` 提交独立 Pro 会话。第一次缺模型引用的请求按现有预检返回 400 `PRO_MODEL_CONFIGURATION_REQUIRED`，未创建会话；补回原有引用后请求因会话材料表的全局 `id` 主键冲突返回 500（SQLSTATE `23505`）。失败会话 `26a8303b-3b62-49cb-b5cb-64d9b3cc8bab` 已软删除，关联材料行数为 0。根因是绑定同一 owner 上传材料到新会话时沿用原材料 ID；修复改为按会话 ID 和原材料 ID 生成稳定的 128 位 `mat_` 会话材料 ID，旧会话已有绑定继续按原 ID 读取。PGlite 跨会话复用、重复绑定和旧记录兼容实测 8/8 通过，TypeScript `--noEmit` 通过。

修复镜像已部署：Web `sha256:e670a04d34ce662cca4c39280cb389b4d79e72ca1740c830104a700dd4d28527`，两台 worker `sha256:84e063048d23dadc0f819acace695c8e778f4b4c0c78a4b2a5fa5c5bfa379c5b`。再次提交同一材料及已保存的模型/媒体配置返回 HTTP 202，新会话 `cf9e2e00-73db-4ae1-ab96-4691a48770ee`，会话材料成功生成独立 ID 且对象键限于该会话。实际生成任务 `d6aec5ca-67ac-4034-86d1-557d2e7cd5ac`、课程 `c561682b-a4d1-4cae-8bc7-ca3e49a70ef7` 已进入 worker 执行。主机约 12:08 再次重启后，会话以 attempt 2、任务以 lease epoch 3 恢复；任务曾记录 `WORKER_LEASE_EXPIRED`，之后继续推进到 TTS 并写入首个场景和 5 条素材引用。Chrome 新会话页面显示“进行中”。此时仍须等待终态、核对全部对象和课堂读取，不能记为 Pro 验收通过。

后续任务 `d6aec5ca-67ac-4034-86d1-557d2e7cd5ac` 到达 `succeeded/finalizing`，3 页场景落库，全部 generation steps（含 14 个 TTS 子步骤）为 `succeeded`。14 条 `generation_job_assets` 输出引用均对应 `asset_entries`、`asset_blobs` 及私有 `zhiyu-assets` 的 `storage.objects`。Chrome 直接打开新课程 `c561682b-a4d1-4cae-8bc7-ca3e49a70ef7`：3 页加完成页可见；第一页讲解播放后显示“暂停”，第二页验证 `3/10` 显示分母不可相加的提示，第三页点选 `1/5`、`2/5`、`3/5` 后显示正确反馈。刷新该课程后第三页、讲解文字和互动框重新加载，页面内容仍可读取。用户提示要求一页，Agent 实际规划并产出三页，此提示遵循度也未达到要求。Pro 会话截至本次核查仍为 `running`、attempt 2、心跳有效，尚未收到终态；因此只记课程生成成功，不将整个 Pro 会话验收标为通过。

根仓库全套的第二次运行：8,510 项中 8,438 通过、70 跳过、2 项超时（`entry-points-restore` 和 `native-child-route-wiring`）。两个超时用例连同材料测试定向重跑共 33/33 通过；由于运行中代码仍有改动且全套退出 1，该结果不记为全套通过。代码稳定后的完整重跑记录在 `.temp/supabase-full-tests-final-20260923.log`：8,512 项中 8,442 通过、70 跳过，Vitest 退出 0；`tsc --noEmit` 再次退出 0。

Chrome 在修复镜像上重新打开原管理员已登录页面，能看到新 Pro 会话“进行中”。同一浏览器切换代表性旧课 `94c0ee87-31af-4db5-af39-93f7eb414220` 时，工作区和独立课堂链接均长时间显示“正在加载课堂”；独立链接的文档和四组学习记录请求最终均为 HTTP 200，页面随后展示四页、导航、讨论及播放控件。这是明显的前台等待，不能按正常加载速度验收。独立课堂讨论里实际发出一条关于 `2x+4y=7` 的提问后，`POST /api/chat` 在浏览器网络记录为 `net::ERR_ABORTED`，Web 日志记载 `Request was aborted`，问答只保留用户问题并结束，没有得到教师回答，也没有触发 `/api/generate/tts`。该轮讨论失败，需定位立即中止的原因。

随后在同一课堂重试另一条相同主题的简短提问，`POST /api/chat` 返回 HTTP 200，页面展示教师的奇偶性解释；Chrome 确认随后实际请求 `/api/generate/tts` 并返回 HTTP 200，控制台未出现 `DiscussionTTS` 报错。故 409 修复已有真实课堂按钮路径的成功证据；首次问答立即中止仍是未解释的可靠性问题，不能把一次重试成功记为完整课堂通过。

Pro 会话在课程生成成功后，从 04:34:05 UTC 的 `stage_link` 到 04:47 未再写入 Agent 事件；同一时段会话保持 `running` 和有效心跳。04:47 通过原工作台追加“只总结并结束”的消息，未收到回应；随后在 UI 点击停止，04:48:14 UTC 写入 `session_end cancelled`。课程、任务及 14 条媒体引用保持成功状态，Pro 会话终态为取消而非成功。这暴露了生成工具完成后 Agent 收尾无进展的问题，不能将 Pro 验收记为通过。

在无运行中普通/Pro 根任务时，使用 Compose 脚本将现有 Tier 4 Web 切至 `Foreground`；readiness 再次确认账号 schema v19、生成 schema v4、两台 worker 心跳及三个私有 bucket。Chrome 原管理员实际提交一门独立普通前台课，课程 `mWZdQO5OFn` 于约 04:50–04:53 UTC 完成，1 页 `document_scenes` 和 18 个教学动作落库；浏览器进入课堂，讲解播放按钮切换到暂停，语句依次显示。该课程有 speech 动作，但本次查询未发现 04:49 UTC 后新增 `asset_entries`，故仅证明内容和动作成功，不将预生成语音/私有 Storage 记为通过。生成页媒体弹窗随后确认 TTS 开关为开启、默认模型显示 MiniMax Speech 2.8 Turbo；已另行提交带简短语音要求的普通前台课程以定位媒体链路。

第二门独立普通前台课 `ECAZz-G_Fa` 于约 05:00–05:04 UTC 生成成功：1 页、21 个动作，其中 11 个 speech 动作；Chrome 已进入课堂。但 11 个 speech 动作均无 `audioId`，浏览器未发出 `/api/generate/tts`，再次确认预生成语音被静默跳过。浏览器账号设置持久化记录（仅核查非密钥字段）显示 `ttsEnabled=true`、平台默认 `zhiyu-default-tts` 可用且指向 `minimax-tts`，而该供应商的用户配置没有 API Key、`isServerConfigured=false`。`GenerationSessionController` 的前台首场景门槛直接检查该用户配置，因而返回不可用；同文件的角色语音列表也忽略平台可用性。已改为通过现有 `withPlatformTTSAvailability` 解析平台默认后再用于角色与 TTS 门槛，未放松服务端鉴权或写入租约。定向 26/26 测试及 TypeScript 检查通过；新镜像的浏览器语音与 Storage 实测仍待完成。

修复镜像已实际替换：Web `sha256:ac3107c4304cc62447982d43a7d0175726d3cfa5c9002bd8e94da6249df34f86`，两台 worker 均为 `sha256:53719bd831817fcb42ae8b66c0bce4f6427e89fb08f941dea8e8d58b99af0292`。第一次 readiness 在容器刚启动时只有 1 台 worker 心跳，随后重复探针 `ready=true`，2/2 worker、schema v19/v4、三个私有 bucket 均通过。Chrome 明确开启图像生成、保留 TTS 开启，提交第三门普通前台课程 `vHBYP3ju4V`；一页课程生成并进入课堂，网络记录 7 次 `/api/generate/tts` 与一次 `/api/generate/image` 均 HTTP 200，图片显示，播放按钮实际进入暂停。修复确认了前台语音请求不再静默跳过。

但第三门课的 Supabase 场景里，7 个 speech 的 `audioId` 仍是 `tts_s1_...` 浏览器本地 ID，图片 `src` 仍为 `gen_img_...` 占位引用；05:15 UTC 以来 `asset_entries` 尚无新增资产。代码核查发现前台 `generateAndStoreTTS` 仅写 Dexie `audioFiles`，`media-orchestrator` 仅写 Dexie `mediaFiles` 并以 object URL 展示，未将这些新媒体分配到已配置的 Supabase 资产池。因此本轮只证明同一浏览器即时展示，不证明私有 Storage、换浏览器或重建后可读；普通前台验收继续保持未通过，须修复媒体持久化后重测。

## 2026-09-23 前台媒体与语音来源接续实测

前台 TTS 改为在 server-backed 资产池中分配 `ast_` ID，并将其写入场景 `audioId`；图片/视频编排改为上传生成字节、把大纲与场景里的生成占位引用改为资产 ID，并持久化文档。前台 LLM/媒体生成请求的用量记录现在沿已验证账号上下文写入 `usage_events`。`tsc --noEmit` 及媒体/TTS/用量定向测试通过。第一次镜像更新为 Web `sha256:bd833abbd2d89e2ef58bcc91904798698453eaf34fcd835fcddafed949563716`、worker `sha256:304ec97fd89388cad1d2a96232b5b9d26f340c6666f5cb4737cbb20605f0f431`，Tier 4 Foreground readiness 为 `ready=true`、worker 2/2、私有 bucket 3/3。

真实前台课程 `koRzwJsBsL` 的第一页生成并保存 6 条 `ast_` 语音引用，每条都对应非空 `asset_blobs` 和私有 `zhiyu-assets` 对象；本次新增 `usage_events` 出现大纲、角色、内容、动作、TTS 的 owner 归属。课程第二页两个 TTS 请求返回 400 `MISSING_API_KEY`：第一页使用平台默认来源，而发布后载入的 LLM 角色 `voiceConfig` 缺少来源标记，被旧角色兼容规则正确视为用户密钥，但该账号未配置该供应商用户密钥。第二页未落库，故该课程不计为完成。生成角色的新增绑定现在只有在匹配本次广告的可用平台声线且无显式来源时，才标为 `source=platform`、保存默认 ID 与修订号；历史无来源绑定仍保留原权限语义。TypeScript 与新增/相关 35 项测试通过。第二次镜像更新为 Web `sha256:de7e38d2e85515026e4c856885e2a876ea3cdaf564817c2a21e8f6ab8a137dcd`、worker `sha256:688497df30656dd8d785321b8c4eccc6e6c7728d9b9b46f941298f6b78d74592`，readiness 再次通过。

新镜像课程 `eWvZikE21k` 一页内容成功发布，3 次 `/api/generate/tts` 与 3 次资产上传均成功；场景 3 条 `audioId` 是 `ast_`，对应私有对象字节数为 133044、51828、30516。角色配置已在 Supabase 文档中保存 `source=platform`、`zhiyu-default-tts` 与修订号。Chrome 刷新课堂后内容重新加载，点播放进入“暂停”，资产内容 GET 返回 200。这一轮证明前台语音在刷新后可用；其大纲请求因 UI 图片开关为 `false` 没有安排图片，不能计作图片验收。随后在 UI 明确将 Image 开关从 0 改为 1，下一轮大纲请求头实测 `x-image-generation-enabled=true` 且响应含 `mediaGenerations`/`gen_img_`；该图片加第二页语音课程仍在执行，结果待补。

图片加语音的独立前台课程 `bK4mbbRke1` 随后生成完成。大纲请求实际开启图片；`/api/generate/image` 和生成结果下载均返回 200，上传资产返回 201。Supabase 的两个 `document_scenes` 均已落库：第一页图片 `src` 从 `gen_img_Y3oGDYWa` 转为 `ast_7gfajfr7nfyx5xhzdpbzjc9qm0`，其 `asset_blobs.byte_size=81716` 且对象位于私有 `zhiyu-assets`；两页共七条语音 `audioId` 均为 `ast_`。全部第二页 TTS 请求实际带 `modelSource=platform` 并返回 200。Chrome 刷新课堂后加载两页内容和完成页，返回第一页可见红苹果图片，新的图片资产内容 GET 返回 200。因此普通前台的内容、图片、语音与刷新读取已有真实 hosted 证据。刷新课堂加载耗时偏长，仍需在完整课堂 UI 验收中单独观察。课程 ID 与媒体引用仅用于脱敏追踪，未在报告暴露凭据。

新增媒体写入触发 `asset-url-boundary` 静态守卫：资产池的直接入口原先限定在共享模块。现已在 `lib/media/asset-pool.ts` 封装新增写入与替换，前台媒体、TTS 和失败回收统一调用封装；相关 32 项定向测试和 `tsc --noEmit` 通过。代码稳定后全套 `vitest run --maxWorkers=4 --testTimeout=15000` 再次退出 0：812 个测试文件通过、14 个跳过，8,446 项通过、70 项跳过；日志 `.temp/supabase-full-tests-post-media-20260923.log`。此封装改动尚未重新构建运行容器，但与上述实测使用的资产池操作语义相同。

## 2026-09-23 Pro 互动组件兼容性复测

Tier 4 已切回 Background 并更新前台资产池封装镜像；Web 为 `sha256:438ad0d7d91b71c9e077db737a0dd0aa0a617a40fc2b794ca05ed201120c2b22`，两个 worker 为 `sha256:248dbdc6a25a8a6e2d4aa9ce6b209e40fd2385f338da2f3994072d708df10734`。readiness 为 `ready=true`，两个 worker 心跳、schema v19/v4、三个私有 bucket 均通过。

Chrome 通过现有 Pro 工作台提交会话 `b1361d54-348a-4d55-a6ae-ed91cee759a0`，Agent 完成提交并正确结束会话；生成 job `0753feb8-22ac-4769-94dc-814f3e567347`、stage `37f70df6-5b14-4e7f-bf1f-01359a650468` 在 `content:p1` 失败。再次使用现有 retry API 后 run 2 仍在同一步失败，不能把会话结束或任务重试当作 Pro 成功。SQL 检查已保存 plan：互动提纲的 `widgetType=fractionVisualizer`，而当前 widget 生成器仅支持 `simulation`、`diagram`、`code`、`game`、`visualization3d`、`procedural-skill`，遇到未知类型会在任何 LLM 子步骤前返回空内容；该 job 确实没有 `content:p1:call:*` 外部步骤。`applyOutlineFallbacks` 现将此类模型提出但尚未实现的互动类型降为 `simulation`，保留概念、描述和交互要点。包内回归 15/15、根 TypeScript、包 TypeScript 检查通过；新镜像重试及课堂验收正在进行，Pro 项继续保持未通过。

## 2026-09-23 15:39 起：Pro 重试完成与课程元数据权限修复

接续时互动组件兼容性镜像已启动：Web `sha256:0a14bd5ddc087a0fc3883e78d043e5bf72d86c72163f106a9e8507f407e28c4d`，worker `sha256:ab15d38da3dbbdb64a5b05c3c41fe5498ca3439b41b950b097a0ccaa99c69391`。15:39 聚合 readiness 为 `ready=true`，schema v19/v4、worker 2/2、私有 bucket 3/3。未重复提交正在运行的重试任务。

Pro job `0753feb8-22ac-4769-94dc-814f3e567347` 的 run 3 最终 `succeeded/finalizing`，1/1 页落库，`last_error_code=null`；Agent session `b1361d54-348a-4d55-a6ae-ed91cee759a0` 为 `succeeded`。三个 TTS 子步骤成功，资产 `ast_hxbm16p0ss3n4krz811zdb50fr`、`ast_qpfrdgfrrd4kngr4k8yssrhff8`、`ast_y8bwkjx2tktxjsmjyzkfa4b5d4` 均有对应私有 Storage 对象，字节数分别为 124404、147444、92724。该轮没有独立生成图片资产，不能用互动 canvas 图形替代计划所需的图片生成证据。

Chrome 新标签页打开并刷新课程 `37f70df6-5b14-4e7f-bf1f-01359a650468`，显示单页互动课堂与完成页；点击“先涂1份”显示 1/4，再点击“再涂2份”显示 3 份及 `1/4 + 2/4 = 3/4，分母不变、分子相加！`。点击播放后进入“正在讲解”和“暂停”。页面加载等待仍偏长，不能据此记为完整课堂性能验收通过。

浏览器同时暴露 `/api/stage-meta/:id` 返回 404。云端课程和 `stage_meta` 行存在、未删除、生成完成、owner 与 job 一致；代码中的裸 pool 查询没有事务级 `app.owner_id`。通过实际 Web 容器的 `app_web` 连接只读复现：未绑定 owner 返回 0 行，正确绑定返回 1 行，ROLLBACK 后再次返回 0 行。脚本 `.scratch/stage-access-db-probe.cjs`；没有修改 RLS、角色权限或课程归属。

修复让课程元数据、hosted 课程状态和取消公开接口使用已有 `getOwnerBoundStageAccessDb(ownerId)`；legacy 的公开状态读取契约不变。TypeScript 通过，相关两个测试文件 16/16 通过；互动组件包内回归 15/15 通过。15:47 确认普通/Pro 活动任务均为 0 后启动镜像重建。运行镜像的 HTTP 正反例、完整测试与后续 UI 结果待下文补入；这一段不构成部署已完成的声明。

15:53 的额外核对：Supabase 共 127 门课程、472 个场景，旧匿名 owner 数为 0；`zhiyu-assets`、`zhiyu-materials`、`zhiyu-classrooms` 三桶均非公开。旧 `zhiyu`/`zhiyu-worker` 分别自 2026-09-21 07:37:42 UTC 起停止，旧 PostgreSQL 自当日 02:06:29 UTC 起停止，本轮没有启动或修改旧源。新课程增长发生在 Supabase。

安全 Advisor 未返回 RLS 缺失的错误；返回 migration ledger 无 policy 的 INFO、`reserved_admin_lifecycle_snapshot` 可由 authenticated 执行的 WARN，以及泄露密码保护未启用的 WARN。已只读检查该 SECURITY DEFINER 函数：要求非空 `auth.uid()`，目标邮箱必须属于当前 caller，且账号必须为 active admin；未擅自删除已有自查功能或更改 Auth 设置。参见 [函数告警说明](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) 与 [密码保护说明](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。

本轮全套第一次结果为 8,446 通过、70 跳过、1 个聊天 Native Child 用例 15 秒超时（构建同时进行）；该文件随后独立复测 11/11 通过。不将首次全套失败写为全套通过。

16:01 新镜像就绪：Web `sha256:cc1d0892153f38a742ac90ad86049e043dfd356b1e03917c3ed00e8d9b658478`，worker `sha256:f63cf1889d77f7efe1121109a4555376ddcf7d7da4e9e4305e3b71b487c0ec86`，readiness 再次全部通过。管理员通过真实 Supabase 登录后，元数据、状态、取消公开、文档和语音内容均 HTTP 200；元数据含 `isOwner=true`、`generationComplete=true`。另一现有测试账号对同一五项均为 404，不能读取或操作管理员课程。结果分别在 `.temp/stage-access-admin-20260923.jsonl`、`.temp/stage-access-user-a-20260923.jsonl`。取消公开作用于本来就是 private 的验收课，没有公开任何课程。

稳定代码的最终全套测试：812 个文件通过、14 个跳过，8,447 项通过、70 项跳过，Vitest 退出 0（337.26 秒，`--maxWorkers=2 --testTimeout=15000`），日志 `.temp/supabase-full-tests-stage-meta-final-20260923.log`。Chrome 在新容器后刷新同一 Pro 课堂，单页内容恢复，播放进入暂停，白板正常展开。

本轮只读网络样本：Web 到 Supabase 新连接 3621 ms，复用连接五次 SELECT 1 为 426/367/462/367/359 ms。管理员文档 GET 34353 ms、语音 GET 35564 ms；这只是带少量并行验收请求的样本，不是 P95，不是 16 并发性能结果。长等待仍需解决，T8/T9 保持未完成。

补充图片/语音的独立 Pro 会话 `ba6c762b-8cce-400a-ba74-1bc0843d9471` 已返回 202 并进入 attempt 1。使用同一现有模型/媒体引用与原上传材料，要求单页 slide 和独立图片生成；该任务终态及对象核对尚待记录。

匿名请求课程元数据及 hosted 状态均返回 401。Pro 补测任务为 `58decd01-993b-48f3-8d5e-c65e90243b78`，课程 `c5e508aa-f02e-40f0-b14b-0a09cf802534`；新会话的 source/extraction 两条材料均为 done，提取文本 108 字，说明跨会话材料绑定与读取路径可用。

## 2026-09-23 16:18 起：补充 Pro 媒体配置与读取往返优化

Pro 补测 session `ba6c762b-8cce-400a-ba74-1bc0843d9471` 与 job `58decd01-993b-48f3-8d5e-c65e90243b78` 最终均 succeeded，课程 `c5e508aa-f02e-40f0-b14b-0a09cf802534` 为 1/1 页。但该次验收复用了之前关闭图片的媒体快照：job 的 `enableImageGeneration=false`、`media={}`。尽管计划含 `gen_img_pizza_pro_acceptance`，worker 按冻结配置跳过图片；这次不能算图片成功，也不据此修改 worker 绕过用户配置。已通过正式 snapshot API 创建 image/TTS 均开启的 version 3 配置 `51063b9b-c8cd-410f-967e-e50317dff812` revision 1，并提交独立 Pro 会话 `bf96ad86-3a9d-4ff5-b832-5c5e5b615f82`、job `b167a802-feba-4b8f-9b1a-a432449f175f`、课程 `e48a0067-5d13-43fd-88db-041f30880af4`；终态待记录。

旧课堂的学习反馈在多次远程读取后显示四条 teach-back 历史，其中一条等待解释。实际点击恢复进入讨论区，再点击恢复练习，出现原问题和解释输入；已提交新解释，正在等待评价。这验证了新容器可以读取并继续先前活动，尚未把整个学伴矩阵标为通过。

定位到两项可减少的远程往返：`loadChatSessions` 在没有 legacy 数据时已取得 runtime views，却又完整读取一次 sessions/records；teach-back 历史串行读取每个活动。现改为复用同一次锁内、已完成 restore 清理的聊天快照，并将学伴历史限制为最多 4 个并行读取、保持相同排序和解析规则。相关 4 文件 89/89 测试通过（含新增往返次数和并行/顺序断言），镜像实测待完成。没有更改 Auth、RLS 或删除恢复契约。

旧课堂恢复活动 `teach-back:tb-cFacVMHLcS5xjtH9JhzYR` 已接受解释并返回逐条评价、依据引用与总结；云端事件出现 activity_resumed、explanation_submitted、evaluation_requested、turn_evaluated。其助教语音两次返回 400，错误为缺少 minimax-tts 用户 API key。只读核对该旧课三个 generatedAgentConfigs 都没有 voiceConfig；问题来自运行时自动声线选择：平台可用性被加入声线候选，但自动选出的 ResolvedVoice 丢失 source/defaultId，后续按无来源绑定判为 user。修复仅让自动回退声线继承选中平台候选的 source/defaultId/revision/modelId；显式角色与用户覆盖声线仍使用其原有来源，历史未标来源的显式绑定仍按 user 处理。29 项声线相关测试及 tsc 通过，含自动平台请求及 undefined/user/legacy-managed 显式绑定不借用平台凭据的测试；部署实测待完成。

普通前台验收课 `bK4mbbRke1` 在独立新标签页恢复两页、红苹果图片自然宽度 1280，讲解播放/暂停可切换。点击专业模式进入现有工作区编辑器，显示两页、完整画布工具及四条已配音讲解。为测试名称保存，将该验收课改名为“认识红苹果（前台迁移验收）”；持久化复核待记录。

读取优化的全套运行期间加入上述声线修复，导致新声线测试读到旧模块：8,452 通过、70 跳过、1 失败；该运行不记为稳定全套通过。修改停止后的新全套日志为 `.temp/supabase-full-tests-read-voice-stable-20260923.log`，结果待记录。

16:30 核查：独立 Pro 补测 session `bf96ad86-3a9d-4ff5-b832-5c5e5b615f82` 与 job `b167a802-feba-4b8f-9b1a-a432449f175f` 均 succeeded，课程 `e48a0067-5d13-43fd-88db-041f30880af4` 为 1/1 页，错误为空。图片 `ast_hde6jh95vthpwtrxn77bwzp3a0` 408179 字节；五条 MP3 分别为 103668、104244、105396、67956、76596 字节，六条资产全部有非空 blob 元数据及私有 Storage 对象。浏览器页面读取待新版容器启动后执行。

旧学伴恢复活动最终写入 `activity_finished`，浏览器显示已结束并回到课堂播放，随后手动暂停。前台课 `bK4mbbRke1` 的 `document_stages.data.name` 已确认保存为“认识红苹果（前台迁移验收）”。确认 active 普通任务及 Pro 会话均为 0 后，开始顺序重建 Web/worker，保持 Tier 4 Background；日志 `.temp/supabase-read-voice-build-20260923.log`。没有在活动模型请求中途重启。

稳定代码全套最终退出 0：812 文件通过、14 文件跳过，8453 项通过、70 项跳过（共 8523），311.05 秒。日志 `.temp/supabase-full-tests-read-voice-stable-20260923.log`；TypeScript 退出 0，日志 `.temp/discussion-platform-voice-tsc.log`。本次生成任务及会话均已终态成功，构建前没有遗留活动根任务。仍须验证最新镜像中的实际 UI；全套通过不替代 T8/T9。

16:39 新镜像已部署并通过聚合 readiness：Web `sha256:f6880800b9a8d7e7cd69a9dce49c800f84113c82df6a870abccc703c5e13416a`；两 worker 均 `sha256:6b60fbba152ed0037666c17aa2ad3a08dc9aa0975b6b49b8ff3d24f5b25b89b2`。账号 schema v19、生成 schema v4、worker 2/2、私有 bucket 3/3，`ready=true`。Chrome 新标签页冷启动 Pro 图片课程，后续 UI 结果继续追加。

新 Pro 课程在重建后的 Chrome 冷启动加载成功：图片自然宽度 1280、画面可见，图片 GET 200（26944 ms），首条语音 GET 200（30458 ms），播放进入暂停状态，白板展开/最小化正常；加载后点击暂停能回到播放状态。文档 GET 200 用时 24452 ms，单次 runtime session 列表 GET 200 用时 22751 ms，不再进行旧路径的重复首轮读取。这仍是明显等待，不是性能达标结论。图片虽然成功生成和保存，但视觉结果没有严格符合四等分要求，不能将对象存在等同于教学图片正确。

PPTX 通过课堂导出菜单实际下载，文件 463317 字节，ZIP 检查含 1 个 slide XML、2 个嵌入媒体文件。报告只记录本次导出路径通过，不将其冒充所有格式或三类课程全部导出验收。

### 2026-09-23 16:58 补充：教会学伴受控失败/重试与自动助教语音

- 浏览器临时阻断且仅阻断 `http://localhost:3000/api/learning/teach-back`，观察 `Network.loadingFailed.blockedReason=inspector` 与 UI「学伴暂时无法回复，已保存的解释仍在」。随后已恢复 `Network.setBlockedURLs({urls:[]})`，没有留下网络限制。
- 失败活动 `tb-KodUM9kfvt_j4xjeDVHXS` 保留 `prepare_requested`。通过原 UI「开始」重试后创建活动 `tb-ZwOedQ2RFALFEAcfjeJcD`，真实 prepare API 200，已持久化 `prepare_requested`、`activity_prepared`，界面进入第 1/3 次解释。当前产品重试会开始新活动，不声称是同一 activity 的续跑。
- 自动选声的「解探助手」真实请求 `/api/generate/tts` 携带 `modelSource=platform`、`platformDefaultId=zhiyu-default-tts`，HTTP 200；页面出现助教问题并完成播报进入「轮到你发言了」。此前的缺少 Minimax 用户密钥 400 已通过此实际路径复验修复。
- Pro 图片课堂其余四个音频对象实读均 200（103668、104244、67956、76596 bytes），六个图片/音频对象已全部读回；证据 `.temp/pro-media-bytes-after-rebuild-20260923.jsonl`。
- 普通后台入口已实测大纲准备阶段「返回首页 → 取消生成并返回」，回到首页，`generate-classroom` 请求 ERR_ABORTED，此时尚未创建后台根任务。仅算准备阶段取消，不算后台运行中取消。

### 2026-09-23 16:58 请求内认证重复核查修复（待重建实测）

- 持久化 adapter 先 `tryPrincipal(request)`，owner resolver 又创建新 Request，内部 Node adapter 再创建新 Request，导致同一请求最多重复三次 Auth/账号/会话校验。现有缓存以 Request 实例为键，所以此前没有命中。
- Hosted owner resolver 保留原 Request；embedded persistence authenticator 复用同一原 Request 的已验证身份。独立调用仍从 IncomingMessage 认证。仍检查 learner marker、owner/RLS、跨源请求；新 HTTP 请求不共享缓存，未改变账号/会话失败处理策略。
- 同时保留第一次认证刷新产生的 Set-Cookie，确保不因复用缓存丢失登录刷新。
- 新增 `tests/persistence/request-auth-reuse.test.ts` 覆盖单请求一次验证、刷新 cookie、后续请求会话撤销、外来 learner marker、跨站写入。相关 23 文件 / 214 测试通过；TypeScript 检查通过。初次测试中的 env fixture 名称和重复 Cache-Control 已修正。
- 仍有聊天全分区反复读取与操作等待较长的问题，不把此次局部优化当作整体性能通过。

### 2026-09-23 17:04 认证复用稳定回归与重建窗口

- 全套稳定通过：813 文件通过、14 跳过；8457 测试通过、70 跳过（8527 总计），389.98 秒，日志 `.temp/supabase-full-tests-auth-reuse-20260923.log`。此前 TypeScript 检查亦退出 0。
- 学伴重试活动 `tb-ZwOedQ2RFALFEAcfjeJcD` 最终持久化 seq 2 `activity_finished`，UI 显示「已结束」「准备就绪」及课堂播放按钮。没有遗留浏览器网络阻断。
- 构建前 SQL 核对 active 普通任务与 active Pro 会话均为 0。仅对 `openmaic-supabase` 顺序重建，配置为 Tier 4 / Foreground，用于下一步前台取消复验。旧 `openmaic-main-postgres-1` 的 FinishedAt 仍为 2026-09-21T02:06:29Z，旧 `zhiyu` 为 2026-09-21T07:37:42Z；未重启旧源或向其业务库写入。
- 实际账号数量为 app_accounts=3、auth.users=3、active=3（管理员 1、普通用户 2）。readiness 的 accounts=19 指 schema 版本，不能误写为 19 个用户。8-owner 真实压测尚需独立测试账号。

### 2026-09-23 17:08 后：核心数据库验收收口

用户明确要求先完成数据库迁移与功能验收，非阻断问题及性能优化后置。本轮按此范围收口，结论与完整证据索引见 `2026-09-23-supabase-database-functional-acceptance.md`；原完整 T8/T9 不标为通过。

- 17:08 新镜像已启动，17:14:52 用已有镜像恢复 Tier 4 / Background / 2 workers；17:16 readiness 全部通过。没有继续修改功能代码或启动新一轮优化。
- 普通前台课程改名在冷启动后保留，完整 ZIP 实际下载 715398 字节，包含 manifest 15114 字节、1 张 81716 字节图片、7 条 MP3。原完整文档的大纲完成但元数据镜像未完成，已通过既有鉴权 generation-complete API 补齐，返回 200；此项作为样本修复记录。
- 前台取消样本在大纲/角色准备后通过返回首页结束，未观察到后续页面生成调用；不声称该样本捕获了网络 ERR_ABORTED。
- 后台取消独立样本 job `5347b2ca-ce30-4bc5-9adc-4c0d7d62efc3`、stage `aeeb3d28-027e-4a7b-951f-08841938334e`：202 queued → running/researching → cancel 200；最终 cancelled，last_error_code 为空。
- 新镜像真实请求：管理员可读取旧课程及学伴 session/records；匿名及外来 learner marker 为 401；另一现有用户访问相同四项为 404。管理员单次读耗时约 8–19 秒，仍不作为性能通过。
- Pro 成功会话 `bf96ad86-3a9d-4ff5-b832-5c5e5b615f82` 在工作台恢复提示词、材料与工具执行结果；进入课程后恢复单页内容并进入讲解。结束时已回到准备就绪/播放状态，关闭验收标签页。
- 收口 SQL：documents=130、scenes=474、assetEntries=1548、assetBlobs=1548、entriesMissingBlob=0、blobsMissingPrivateObject=0；三桶 private。三种独立成功课程 generation_complete=true。活动生成任务=0、有效 provider slots=0；Pro sessions 31 succeeded / 5 failed / 3 cancelled，均已终态（历史失败记录未删）。
- 停止本轮优化与扩展矩阵。数据库迁移及已验核心功能通过；后续转入生产环境部署及该环境冒烟，不把本机验证表述为已正式上线。
