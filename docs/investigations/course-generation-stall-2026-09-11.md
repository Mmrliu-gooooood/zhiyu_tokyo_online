# 普通模式第 07 页停滞与 Pro 模式排查、实施方案

排查日期：2026-09-11；时间均为北京时间（UTC+8），原始数据库时间为 UTC。<br>
工作区：`D:\ZZGG_Innovation_Project\OpenMAIC-main`。<br>
状态：**排查完成，尚未实施修复。用户要求在新对话中实施本方案。**

## 1. 结论

本次现象由两部分叠加：**真实的外部调用失败让后台停止，而前端错误地继续显示第 07 页正在生成。**

1. 原课程第 7 页的讲解动作调用发生 DNS 解析失败，Worker 记录 `PROVIDER_REQUEST_NOT_SENT`。
2. 当时第 8、9 页的内容请求也处于执行中。现有事务将这些并发调用标为结果未知，并把整门课程置为 `needs_attention`，以避免自动重复付费。第 7 页本身仍保留 `retry_wait`，整门课程却已不在可自动领取的重试状态。
3. 课堂观察器只把页面级 `failed/needs_attention` 加入失败列表，没有覆盖这种“整门课程停止、当前页仍为 retry_wait”的组合。侧栏又只在 `paused` 时停止旋转。因此第 07 页继续转圈，且该页没有显示重试按钮。
4. Web 日志中的多条 `SERVER_OWNED_GENERATION` 是另外一条写入保护链路；其预期业务状态是 409，但存储 HTTP 层把它转换成 500/`INTERNAL_ERROR`，放大了错误表现。它不是已证实的 DNS 失败原因。

**不是固定的第 7 页限制，也没有证据表明 DeepSeek Flash 完全不可用或四类默认模型全部接错。** 在不修复、不重启、不修改运行配置的情况下，本次新建普通模式与 Pro 模式课程，均通过正式 API、真实模型调用完成 **8/8 页**。

Pro 的课程生成最终进入同一套后台 Worker，因此共享 DNS、并发结果未知、课堂进度显示等风险。本次 Pro 成功不等于已经修复这些风险。

## 2. 原故障的证据链

### 2.1 任务身份与时间线

原任务：`69a55c62-7478-4072-ac26-55efcbec29d5`。<br>
原课程：`06ec641d-cd06-484b-ae1b-25c4106a4615`。<br>
使用来源：`platform / zhiyu-default-text`，revision 为 `5da2aae2853d915b`。

| 北京时间 | 事实 |
| --- | --- |
| 13:27:12.887 | 创建任务，最终大纲 12 页 |
| 13:30:24.650 | 开始第 7 页内容调用 |
| 13:30:51.763 | 预生成第 8 页内容 |
| 13:32:46.973 | 第 7 页内容调用成功，耗时约 142.3 秒 |
| 13:32:47.031 | 开始第 9 页内容调用 |
| 13:32:47.039 | 开始 `actions:scene_7:call:0` |
| 13:32:52.058 | 第 7 页动作调用被记为 `safe_failure`，错误码 `PROVIDER_REQUEST_NOT_SENT` |
| 13:32:52.063 | 整门课程进入 `needs_attention`，保留 6 页已发布内容 |
| 13:39:41.670 | 后续读取时任务为 `cancelled`；用户确认已经删除课程 |

Worker 脱敏日志的关键字段：

```json
{
  "event": "job_stopped",
  "jobId": "69a55c62-7478-4072-ac26-55efcbec29d5",
  "category": "provider_request_not_sent",
  "code": "PROVIDER_REQUEST_NOT_SENT",
  "phase": "actions:scene_7:call:0",
  "elapsedMs": 308510
}
```

注意：`elapsedMs` 是 Worker 本轮执行的耗时字段，不能解释为第 7 页这一次 DNS 查询耗时；该步骤的数据库开始、失败时间相差约 5 秒。

数据库保存的状态组合：

| 对象 | 状态 | 错误 |
| --- | --- | --- |
| 第 1—6 页 | `ready` | 无 |
| 第 7 页 | `retry_wait` | `PROVIDER_REQUEST_NOT_SENT` |
| 第 8—9 页 | `needs_attention` | `EXTERNAL_RESULT_UNKNOWN` |
| 第 10—12 页 | `pending` | 尚未执行 |
| 整门课程，删除前 | `needs_attention` | `EXTERNAL_RESULT_UNKNOWN` |

整门课程摘要为：`A concurrent external request remained unresolved after the pipeline stopped.` 第 8、9 页在数据库中是“结果未知”，不是证明供应商没有生成，也不是证明已经收费。

原任务已记录成功：16 次 LLM、40 次 TTS、1 次媒体调用；另有 1 次 LLM 安全失败、2 次 LLM 结果未知。故障点属于文本动作生成，不是第 7 页 TTS 或视频轮询。

### 2.2 DNS 调查范围

两个容器当时均 healthy；Worker 使用 Docker 内置解析器 `127.0.0.11`，实际配置的上游 DNS 为 `1.1.1.1`、`8.8.8.8`；未配置 HTTP/HTTPS 代理。

本次探针结果：

- Worker 对 `api.deepseek.com`、`api.minimaxi.com` 各做 3 次 `dns.lookup`，全部成功。
- Web 对 `api.deepseek.com` 做 3 次 `dns.lookup`，全部成功。
- Worker 分别对 `127.0.0.11`、`1.1.1.1`、`8.8.8.8`、`223.5.5.5`、`119.29.29.29` 做 3 次 DeepSeek A 记录查询，共 15/15 成功，约 201—271 ms。
- 更早的 9 月 11 日 00:39（UTC 为 9 月 10 日）旧模型任务也保存过 `PROVIDER_REQUEST_NOT_SENT`，说明这一类故障并非仅在本次默认模型修改后才出现。

**能确认历史调用被应用按 DNS 失败分类；尚不能确认底层原因是 Docker Desktop、上游 DNS、VPN/网络切换、运营商，还是其他短时波动。** 现有日志没有保留原始 `EAI_AGAIN/ENOTFOUND`、失败 hostname 和连接阶段，不能进一步臆断。单次成功探针也不能证明长期稳定。

Docker 官方说明，自定义网络使用内置 DNS 并转发外部查询；Compose 支持服务级 DNS 配置。这些提供排查和修复入口，但不是本次更换 DNS 必然有效的证明。参见 [Docker DNS 文档](https://docs.docker.com/engine/network/#dns-services)、[Compose services 参考](https://docs.docker.com/reference/compose-file/services/)。

## 3. 源码定位与缺陷等级

### P1：后台已停止，当前页仍显示生成中

涉及：

- `lib/server/generation-jobs/repository.ts` 的 `failStep`、`projectSceneFailure`。
- `lib/hooks/use-generation-job.ts` 的 `useClassroomGenerationJob`。
- `components/stage/scene-sidebar.tsx` 的 `pendingFailed`、`Loader2`、重试按钮条件。
- `lib/server/generation-jobs/display-progress.ts` 的失败步骤选择。

`failStep` 的行为有明确防重复调用目的：并发请求未确认时，将任务升级成 `needs_attention`。问题是任务、页面、UI 的状态投影不一致。观察器根据页面状态生成 `failedOutlines` 时遗漏了第 7 页；侧栏使用 `generationStatus !== 'paused'` 作为动画条件，连 `error` 也会旋转。

最小复现用真实 `SceneSidebar` 组件渲染原故障状态，结果：

```text
期望：spinning=false, retryVisible=true
实际：spinning=true,  retryVisible=false
```

`generation-preview` 已有任务级 `needs_attention` 展示，但用户自动进入课堂后使用另一套观察器/侧栏，因此只检查预览页不够。

### P1：DNS 安全失败会被并发请求放大成需要人工处理

涉及：`lib/server/generation-pipeline/execution.ts`、`pipeline.ts`、`lib/server/generation-jobs/repository.ts`。

当前流程在单次 DNS 失败时立即调用 `failStep`，释放任务租约并将其他 running attempts 标为 uncertain，然后中止流水线。第 7 页可以安全重试，不代表第 8、9 页也可自动重试。因此不能直接把 `needs_attention` 全部改成自动重试。

内容预取和按顺序生成 actions 同时存在。**仅把 `PARALLEL_SCENE_CONCURRENCY` 改为 1，不保证整条生成链只有一个外部调用**：预取内容仍可能与当前页 actions 重叠。

### P2：预期的写入冲突被转换成 HTTP 500

涉及：

- `lib/server/generation-jobs/ownership.ts`：生成期间拒绝普通客户端写入，抛出 `GenerationJobError('SERVER_OWNED_GENERATION')`，默认 HTTP 409。
- `packages/@openmaic/storage/src/server/document.ts`：错误映射只识别其内部 `DocumentHttpError`，应用的 `GenerationJobError` 落入 500 分支。
- `app/api/persistence/[...path]/handler.ts`：应用与通用存储 HTTP 处理器的衔接位置。
- `lib/store/stage.ts`、`lib/utils/stage-storage.ts`：客户端脏数据与保存调度。

最小 HTTP 测试使用真实存储 handler，让 `putStage` 抛出同类业务错误，得到：

```text
期望：409 / SERVER_OWNED_GENERATION
实际：500 / INTERNAL_ERROR
```

原日志证明有客户端 `putStage` 与生成所有权冲突，但没有请求关联 ID，**无法确定用户当时是哪项操作触发这些写入**。不能据此断言“普通翻页必定写回整门课程”。源码中当前播放页通常走设备侧保存；角色修改、课程修改等另有文档写入路径。实施时应补充关联信息，并区分真实编辑和仅观察时的误保存。

### P2：平台模型丢失思考参数，可能增加耗时和费用

涉及：`lib/utils/model-config.ts`、`lib/server/agent-runtime/model-connections.ts`、`lib/generation/model-snapshot-client.ts`、`lib/server/generation-model-snapshots.ts`、`lib/server/resolve-model.ts`。

- `getCurrentModelConfig()` 的平台分支直接返回 `thinkingConfig: undefined`。
- `normalizeModelConnectionContext()` 的平台分支只保留来源、默认 ID、revision，即使请求显式传入禁用思考也会被丢掉。普通模式快照与 Pro 连接都调用它。
- `generationModelSnapshotContent()` 的平台分支再次只提取上述字段；`platformModelSchema` 是 strict schema，也未包含 `thinkingConfig`。因此只修复连接规范化仍不足以让偏好穿过普通模式快照。
- 当前 `LLM_THINKING_DISABLED` 未设置；旧成功任务快照包含 `mode: disabled / effort: none`，原故障任务平台选择中不再包含该偏好。
- 最小测试证实 `{ mode: 'disabled', effort: 'none' }` 经平台连接规范化后变成 `undefined`。
- 本次两个成功测试的 Worker 用量记录中，34 次调用全部为 `deepseek-flash`；累计输出 106,315 tokens，其中 reasoning 83,035 tokens，说明实际发生了较多思考输出。

这是本次默认模型分支引入的可确认行为差异。**它不是 DNS 失败的直接原因**；尚未做同一课程、相同网络下的开关思考 A/B 耗时比较，不能量化其对原故障的贡献。

### P2：`server-providers.yml` 实际是目录

涉及：`scripts/generation-compose.ps1`、`docker-compose.providers.yml`、`lib/server/provider-config.ts`。

宿主机 `server-providers.yml` 的 `PSIsContainer=True`；Web、Worker 都把它挂到 `/app/server-providers.yml`。加载时出现 `EISDIR`，随后从环境变量得到供应商配置，生成仍能成功。

部署脚本只检查 `Test-Path`，没有检查 `-PathType Leaf`。Docker 短语法绑定挂载在宿主机路径缺失时可能创建目录，因此“路径存在”不代表 YAML 文件有效。[Compose 官方 volumes 说明](https://docs.docker.com/reference/compose-file/services/#volumes)说明了此行为及 `bind.create_host_path: false` 的用途。

### P2：Pro 用量记录目录不可写，Worker 用量未持久挂载

涉及：`Dockerfile`、Compose、`lib/server/usage-storage.ts`。

Pro 真实测试时 Web 连续记录：`EACCES: permission denied, mkdir '/app/data/usage'`。只读核验：Web 进程 uid=1001；挂载的 `/app/data` 为 root:root、0755、不可写；`usage` 子目录不存在。

这是忽略型的用量记录错误，Pro 课程仍成功。但会影响费用统计。Worker 的 `/app/data/usage` 在本次能记录用量，`docker inspect` 显示 Worker 未挂载该数据卷，记录留在容器可写层，重建后有丢失风险。

## 4. 普通与 Pro 的真实测试结果

测试在原镜像和原配置上执行；通过当前用户所属分区的正式应用 API 新建测试课程，没有直接插入业务任务、篡改状态、恢复已删除课程或重启容器。认证信息只在容器进程内使用，不写入本报告。

| 项目 | 普通模式 | Pro 模式 |
| --- | --- | --- |
| 输入 | PostgreSQL 入门，要求 8 页简短幻灯片 | 同主题、8 页，通过真实 Pro 会话提交 |
| 任务 ID | `8c03a14d-92f3-4802-a21c-7dd2aa135413` | `2093d453-194d-4c40-b190-dc34ad77bf47` |
| 课程 ID | `5dc23c23-7af9-4b46-9046-39e06bef6a58` | `09c0e478-0c61-46ed-9f63-0c8b8ddb662c` |
| Pro 会话 | 不适用 | `b47252f8-c62d-4232-8f9d-8aa71a9c9b41` |
| 后台开始—结束 | 13:50:58.820—13:53:24.686 | 13:54:05.664—13:56:02.330 |
| 后台耗时 | 约 146 秒 | 约 117 秒，另有 Pro 驱动准备时间 |
| Worker 外部调用 | 17 次 LLM，全部成功 | 17 次 LLM，全部成功 |
| 完成结果 | `succeeded`，8/8 ready | `succeeded`，8/8 ready |
| 数据核验 | 8 页都有 content 和 actions | 8 页都有 content 和 actions |

测试课程仍保留，可在原登录身份下查看：

- [普通测试课程](http://localhost:3000/classroom/5dc23c23-7af9-4b46-9046-39e06bef6a58)
- [Pro 测试课程](http://localhost:3000/classroom/09c0e478-0c61-46ed-9f63-0c8b8ddb662c)

Pro 会话本身在 13:54:05 左右结束，不能当成课程完成；本报告另外跟踪了它提交的后台任务，直到 13:56:02 的 8/8 终态。

费用与范围：

- 按用户授权执行了真实付费文本调用。两次 Worker 合计 34 次、输入 205,027 tokens、输出 106,315 tokens；reasoning 已包含在输出中，不能重复相加。
- Pro 驱动还有额外 LLM 调用；Web 用量写入失败，因此上述数字不是完整账单。没有查询供应商账单，不提供未经核实的金额。
- 新课程显式关闭联网搜索、图像、视频和 TTS，以隔离第 7 页文本与动作问题。没有用这两次测试证明所有媒体端到端通过；原故障任务已有媒体、TTS 成功记录，但不能替代视频专项验收。
- 这两次是正式 API 到 Worker 到落库的端到端验证，并非人工浏览器全流程视觉测试。
- 不把普通与 Pro 的耗时直接比较成模式性能结论：大纲、内容长度和驱动路径并不完全相同。

## 5. 新对话中的实施顺序与具体要求

### 阶段 A：先修用户可见状态与错误反馈

1. 为课程生成建立统一的任务级展示投影，覆盖 `queued/running/awaiting_confirmation/retry_wait/needs_attention/failed/cancelled/succeeded`。在课堂观察器、侧栏和待生成页复用。
2. 只有任务确实处于执行状态时显示旋转动画。任务 `needs_attention/failed` 时，当前未完成页即使是 `retry_wait/pending` 也应显示“生成已停止，需要处理”，并提供任务级恢复入口。
3. 真正的任务 `retry_wait` 显示下次重试时间，不能和已停止任务的遗留页面状态混淆。取消时停止动画且不伪装成失败重试。
4. 展示原始触发错误和并发未知结果，例如“第 7 页连接失败；第 8、9 页请求结果未知”。已成功的 6 页继续可读，不清空内容。
5. 重试使用现有任务 ID、最新 `stateVersion` 和幂等命令。由现有恢复协议保留成功检查点，只重跑允许恢复的步骤。结果未知时保留费用确认语义；不能为了消除转圈而自动重复整门课程。

### 阶段 B：修复业务冲突到 HTTP 的错误映射

1. 在应用与存储 HTTP 的边界，为已知所有权冲突提供明确、类型受控的映射接口，使客户端收到 **409 / SERVER_OWNED_GENERATION**。
2. 不让通用 storage 包依赖应用私有 `GenerationJobError`，也不无条件信任任意异常上的 `httpStatus/code`。只映射明确定义的已知错误；未知异常仍返回安全的 500。
3. 客户端收到此冲突时读取权威任务/文档状态；区分“生成期间不能编辑”和网络失败，避免按网络失败无限重试脏写入。
4. 生成期间禁用会写文档的编辑入口，或提供明确的延后编辑行为。只读水合不能调度保存；播放位置等设备状态继续使用原有独立路径。
5. 保留服务端 ownership 校验。**不得删除写入锁、改 producer 冒充客户端、绕过租约检查。**
6. 增加脱敏 requestId、stageId、operation、业务错误码，定位实际触发写入的入口；不要先凭日志猜测是某个界面并重构无关功能。

### 阶段 C：降低网络瞬断导致整条任务停止的概率

1. 增加受控的出站诊断：providerId、主机名（不含 query/凭据）、步骤、DNS 错误码、是否已发送/收到响应、耗时和 attempt。错误链不得输出 Key、Authorization、完整请求体或提示词。
2. 对**单次尚未发出的 HTTP 请求**，仅在可确认的 DNS `EAI_AGAIN/ENOTFOUND` 条件下增加短暂、有上限、带退避的本地重试，例如最多补试 2 次，总等待不超过 10 秒，并遵守现有 abort/deadline。
3. 本地 DNS 重试发生在将任务 `failStep` 之前，保持当前 attempt 和租约。不得重跑包含多个请求的整个生成回调；不得把超时、断流、收到响应后的错误、媒体下载/轮询 DNS 错误套入“未发送”重试。
4. 若短重试耗尽，继续使用现有结果未知保护，并让阶段 A 的 UI 明确提示。
5. 暂不作为首批修复重写并发事务。如果后续要让其他在途请求正常收尾，必须设计“停止调度→保留租约→限时收集单个结果→原子决定重试或人工处理”，补充 PostgreSQL 并发、租约丢失、commit 失败和重启测试。不能简单撤销 uncertain 标记。
6. 对宿主机和两个容器进行持续、低频 DNS 探针，记录故障时的差异。当前备选 DNS 并未测出明显优势，因此本次不指定必须替换为某个公共 DNS。
7. 若后续证实当前上游不稳定，再通过统一 Compose 配置选择本网络实测稳定的解析器；同时确认 `postgres` 内部服务名仍可解析。不要硬编码供应商 IP 或通过 hosts 永久固定 CDN 地址。

### 阶段 D：补齐平台模型的思考参数契约

1. 把平台模型的“默认思考策略”与其“支持哪些思考参数”分开；为稳定 defaultId 定义服务端可配置策略，并纳入 revision。
2. 本项目强调低成本，建议新建平台默认课程采用显式关闭思考策略；保留有意启用思考的用户选择。此项是实施建议，不是本次已修改的配置。
3. 客户端获取、连接规范化、普通快照、Pro 快照、Worker 解析均保留合法的 `thinkingConfig`。同步扩展平台 strict schema 和 `generationModelSnapshotContent()` 的字段提取，并继续兼容没有该字段的旧快照。保留偏好不能同时恢复浏览器对平台 Key、baseUrl、实际 modelId 的覆盖权限。
4. 核查 `GenerationServices` 合并 `input.model` 与模型快照的顺序，不能让快照中的缺失/undefined 再次覆盖请求偏好。
5. 保留显式阶段路由的优先级。Pro 工具驱动继续遵守自己的协议限制，不能盲目恢复被移除的不兼容 effort；合法的 on/off 偏好必须保留。
6. 修改前后检查真实出站 payload，例如关闭时包含 `thinking: { type: 'disabled' }`，并做同条件小规模 A/B 验证耗时和 reasoning 用量。
7. 不全局改写旧任务快照；发布时排空任务并维护 revision/configVersion 一致性，不绕过配置变更保护。避免把设置全局 `LLM_THINKING_DISABLED=true` 当成平台专属修复，因为它可能影响其他调用。

### 阶段 E：修复部署与用量记录

1. `generation-compose.ps1` 对可选 YAML 区分三种状态：不存在→使用环境配置；普通文件→加载 override；目录或其他类型→明确报错并终止发布。
2. 绑定挂载改用长语法和 `bind.create_host_path: false`，防止路径拼写错误自动创建目录。加载器在读取前确认文件类型，日志准确区分 YAML 与环境来源。
3. 不直接递归删除现有 `server-providers.yml` 目录。先核实内容、备份和挂载；按实际采用的配置方式更正路径或移除不需要的挂载，并验证 Web/Worker 默认 revision 一致。
4. 为现有数据卷的 usage 子目录做一次范围明确的初始化，授予当前应用 UID/GID 必要的写权限；不对整个卷使用 `chmod 777`，不让 Web 永久以 root 运行。
5. 让 Worker 用量写入可靠的持久存储。可采用独立用量卷/目录，或项目已有数据库；若多个进程共享 JSONL，必须确认追加并发和文件轮换行为。
6. 以容器实际运行用户做目录可写检查和一条合成用量记录测试，不能只凭镜像层 chown 判定挂载卷权限正确。

## 6. 验收清单

| 场景 | 必须满足 |
| --- | --- |
| 原状态组合：6 页 ready，7 retry_wait，8/9 needs_attention，任务 needs_attention | 07 停止旋转、展示原因和恢复入口；后续未知页不被自动付费重试 |
| 任务真正 retry_wait | 显示有界重试状态/时间，到期后继续；没有假终态 |
| 任务 cancelled/failed/succeeded | 各自显示正确终态；刷新和重新进入课堂一致 |
| DNS 第一次失败、第二次成功 | 同一未发送请求有界重试；其他已成功检查点不重跑 |
| DNS 补试耗尽且有并发请求 | 状态一致、错误信息可读、不重复不确定的请求 |
| 媒体提交成功后下载 DNS 失败、LLM 超时/断流 | 不能误判为可无条件重发 |
| 生成期间普通文档写入 | HTTP 409 和稳定业务码；客户端不形成无限保存循环 |
| 已完成课程的合法编辑、播放页切换、角色编辑 | 保持原有行为，无无关回归 |
| 平台思考 on/off | 普通和 Pro 的客户端→快照→最终请求均一致，用户自配来源不受平台策略影响 |
| YAML 缺失/文件/目录 | 三种部署分支行为明确；无 EISDIR 假加载 |
| 用量持久化 | Web/Worker 可写且重建后记录仍在，没有 EACCES |
| 普通模式与真实 Pro 入口 | 各至少一门 8 页以上课程完成；验证任务终态、内容/actions 和页面进度，而非只看 Pro 会话结束 |
| 媒体后续验收 | 少量真实 TTS/单图测试；视频仅在需要验证视频路径时提交一次并复用 task_id 轮询 |

先以本次脱敏故障状态做自动化回归，再开展少量真实调用。不要只运行配置/模型单元测试就宣布课程链路通过。

## 7. 本次测试与可交接材料

已有针对性测试：**5 个文件、125 项通过**：

```text
tests/server/generation-worker-pipeline.test.ts
tests/server/generation-jobs.test.ts
tests/hooks/generation-job-observer.test.ts
tests/agent-runtime/agent-driver-model.test.ts
tests/generation-preview/zhiyu-generation-state.test.ts
```

新增的诊断复现全部位于 `.scratch/course-generation-diagnosis-20260911/`，不进入默认测试集合，不修改业务代码：

- `spinner.test.ts`：真实侧栏渲染，复现停止后第 07 页仍旋转且无重试入口。
- `ownership-http.test.ts`：真实存储 HTTP handler，复现 409 被映射成 500。
- `thinking.test.ts`：真实连接规范化函数，复现显式思考设置丢失。
- `vitest.config.ts`：独立诊断测试配置。
- `reproduction-results.log`：**3 项预期失败**，分别得到上述错误结果，运行约 2.18 秒。这是修复前的红色基线，不是已修复测试。
- `live-probe.cjs`：通过正式 API 创建/查看新测试课程的诊断脚本，无硬编码密钥。执行时依赖当前 Docker 环境、原任务所属分区和容器内测试状态文件，不宜作为通用生产脚本直接重复运行。

复现命令（PowerShell，在仓库根目录运行；本机默认 `node` 太旧，应使用已验证的随附运行时）：

```powershell
& 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  node_modules/vitest/vitest.mjs run `
  --config .scratch/course-generation-diagnosis-20260911/vitest.config.ts
```

此命令不调用真实供应商。实施时将修复后的永久回归迁入 `tests/` 合适位置，并扩展到状态观察器和租约/并发真实边界；不要只改快照字符串或删除断言使其变绿。

排查时镜像：

```text
Web:    sha256:f7aacee8bc1b60218454ce70a81729423d38ce82b52139c0b45dca2ef72c2eae
Worker: sha256:228318a3979d96867955cc278b6db00138940a5e878c80e1628d61c2f3d3c98c
```

本次保留既有工作区改动，未提交 Git、未修改业务源码、未发布镜像、未更改数据库 schema 或 DNS/凭据配置。只创建诊断材料和用户授权的测试课程；容器内另有临时诊断客户端及其测试 ID 状态文件。平台模型思考参数是本轮修改中可确认的差异；并发保护、课堂 spinner 条件和通用 HTTP 错误映射在当前工作区对 HEAD 没有差异，不能把所有问题都归为本次默认模型改动新引入。

## 8. 给新对话的实施指令

> 请读取 `docs/investigations/course-generation-stall-2026-09-11.md`，先运行其中 3 项诊断复现并核对当前工作区和 Docker 状态，再按阶段 A—E 实施。优先修复课堂停止后的状态展示和业务冲突错误映射，然后补齐 DNS 有界恢复、平台思考参数和部署问题。保留既有改动、所有权隔离、成功检查点、费用未知保护和配置 revision 校验。不要恢复用户已删除的原课程，不重跑已有成功媒体。完成普通与真实 Pro 课程的端到端验证后，报告实际调用、测试结果和未验证范围。
