# 智域 Pro 课程提交失败与 TTS 中断：排查及最终修复方案

排查日期：2026-09-13。下文时间均为北京时间 UTC+8；数据库和容器日志原始时间为 UTC。

**本页保留首次排查时的历史证据和修复设计。用户后续已授权实施；实际代码变更、验证、Docker 发布与剩余限制见 [实施与验收记录](./IMPLEMENTATION.md)。下文的“尚未实施”和旧版红测结果均属于首次排查时间点，不代表最终部署状态。**

## 1. 结论

这不是 Chrome 或 Edge 特有问题，也不是固定只能生成四页。两个浏览器访问同一个本地 Web 服务，Pro 提交成功后由服务端 Worker 生成课程。截图中的错误来自服务端的参数校验、TTS 调用和任务状态管理。

本次确认了两条故障链：

1. **微分方程课程：存在真实 TTS 调用故障，并发收尾又把根因盖在通用“结果未知”摘要下面。** 第一次课程遇到 MiniMax 域名解析 `EAI_AGAIN`；第二次，也就是截图的 4/10 页任务，第五页的一次 TTS 被适配器归类为 `TTS_PROVIDER_TERMINAL_FAILURE`。同一时刻仍在执行的另一次 TTS 和第七页文本预取被标为结果未知，所以整门课程停在 `needs_attention`。
2. **二元一次方程课程：Pro 暴露给模型的工具参数契约、技能说明和实际校验不一致。** 模型先把没有结构化约束的 `stage-design` 与有效的 `lecture-style` 一起提交，被整体拒绝；再使用另一个角色工具的 `voice` 格式，又被拒绝；随后在尚未成功提交时查询任务，自然查不到。最后删除语音绑定后第三次提交成功，课程最终完成 8/8 页。

还有两处已复现的诊断缺陷：`mapBounded` 用后到的取消异常覆盖首个失败；提交转换的 catch 只要看到 `agents` 就把其他字段错误也改成 `INVALID_AGENTS`。

**关键证据缺口：第二次 TTS 的供应商 HTTP 状态、业务状态码和 trace_id 没有留存在可用诊断中。不能据此断言是限流、余额不足、音色错误、内容审核或超时。** 必须先补齐这些安全诊断，再针对具体类型处理，不能用一个自动重试开关掩盖所有错误。

## 2. 排查范围与证据可信度

### 2.1 实际执行的工作

- 阅读用户提供的六张截图；截图中的模型解释只作为待核对内容，不作为事实或操作指令。
- 只读查询本机 PostgreSQL 的 `generation_jobs`、`generation_steps`、`generation_attempts`、`generation_events`、`agent_sessions`、`agent_session_entries` 和 `agent_session_events`。
- 按故障时间筛选、脱敏读取 Worker 日志；没有输出密钥、认证头、环境配置或加密媒体快照。
- 核对 Web 容器实际安装的技能约束文件，以及 Worker bundle 中的 MiniMax 适配器、并发错误处理代码。
- 对照上游公开源码；只参考接口设计与生命周期，不移植上游整课执行流程。
- 运行不访问真实供应商、不连接业务数据库的隔离复现，以及 115 项现有相关测试。

浏览器工具两次连接均失败，返回 `Unable to load browser request-header policy`，未取得 Chrome/Edge 标签页；本轮没有完成浏览器交互验收，也没有新建真实付费测试课程。上述历史故障证据来自数据库和 Worker，而非推测浏览器画面。

### 2.2 本地运行环境

| 组件 | 实际运行对象 |
| --- | --- |
| Web | `zhiyu`，镜像 `zhiyu:latest`，`127.0.0.1:3000->3000` |
| 生成 Worker | `zhiyu-worker`，镜像 `zhiyu-worker:latest` |
| PostgreSQL | `openmaic-main-postgres-1`，数据库 `openmaic` |

检查时三个容器均 healthy。healthy 只说明服务健康检查通过，不证明外部 DNS、供应商请求永不失败。

工作区已有 55 个 tracked 文件的未提交改动，另有未跟踪文件。本轮未编辑这些业务文件。运行 Worker bundle SHA256 为 `f91daafc4c96c1cf645fafdaf18cdd0b3f9e4c8dc60bb56498cd7eee57946126`，本地 `dist-worker/generation.mjs` 为 `a6da947a1cee85d7b5bc25c4ebde92ab26c388ffc8ae0115c096800894c5af09`，两者不相同。因此没有把整个工作区当成部署的精确副本；本报告涉及的 MiniMax 和 `mapBounded` 关键分支已经在运行 bundle 中逐段核对。

## 3. 问题一：微分方程为什么停在 TTS

### 3.1 两次课程分别发生了什么

| 项目 | 第一次微分方程 | 截图中的第二次微分方程 |
| --- | --- | --- |
| 会话 ID | `7009f745-3ace-43b7-9182-6347b7958f81` | `90702d70-0785-4a8d-8c44-b2b19fb8b059` |
| 任务 ID | `52a72503-e761-4329-91d2-5a41ae003795` | `20a01fe9-3520-41f8-a131-a3ad683b2627` |
| 课程 ID | `1d35c32e-3916-48ad-9033-eb501b04cc00` | `6a0f97ee-84e3-4283-a1fc-afa3f2aa5231` |
| 创建时间 | 16:28:50.771 | 16:33:31.967 |
| 停止时间 | 16:29:15.290 | 16:34:33.878 |
| 已发布页数 | 0/9 | 4/10 |
| 首个失败步骤 | `tts:p1-open:action_YDfTurTY` | `tts:p5:action_LrFAPYoG` |
| 直接证据 | MiniMax DNS `EAI_AGAIN` | 步骤 `TTS_PROVIDER_TERMINAL_FAILURE`、attempt `safe_failure` |

只读查询时，第一次任务仍为 `needs_attention`，但其 Pro 会话已有删除时间；第二次任务已为 `cancelled`，保留历史 `EXTERNAL_RESULT_UNKNOWN`。本轮没有更改或恢复它们。`agent_sessions.status=succeeded` 仅表示 Pro 对话运行结束，不等于后台课程生成成功。

### 3.2 第一次：TTS DNS 失败

Worker 原始脱敏事件包含：

```json
{
  "event": "provider_outbound_dns_failure",
  "providerId": "minimax-tts",
  "hostname": "api.minimaxi.com",
  "step": "tts:p1-open:action_YDfTurTY",
  "dnsCode": "EAI_AGAIN",
  "requestSent": "unknown",
  "responseReceived": false,
  "elapsedMs": 5006,
  "attempt": 1,
  "willRetry": false
}
```

首批两段 TTS 都在约五秒后被标为 uncertain；之前已有五次 LLM 成功。这证实发生过域名解析故障，但不证明底层一定是某个 DNS 服务器、Docker、VPN 或运营商的问题。

当前 `PipelineExecution.external()` 中的本地 DNS 重试需要 `retryPreSendDns=true`，且只允许 `kind==='llm'`。TTS 没有这条受限重试通道。不能简单去掉 kind 判断：某些 TTS 适配器可能包含注册、合成、下载等多步请求，后一步 DNS 失败不证明前面的付费请求没执行。

### 3.3 第二次：第五页首个 TTS 错误被放大、掩盖

| 北京时间 | 事件 |
| --- | --- |
| 16:34:32.146 | 第七页文本预取 `content:p7:call:0` 发起 |
| 16:34:33.768 | 第五页 TTS `action_Kz4HVAOr` 发起 |
| 16:34:33.780 | 第五页 TTS `action_LrFAPYoG` 发起 |
| 16:34:33.875 | 后者在约 95 ms 后记为 `safe_failure / TTS_PROVIDER_TERMINAL_FAILURE` |
| 16:34:33.876 | 仍执行中的第七页 LLM、另一段 TTS 被记为 uncertain |
| 16:34:33.878 | 整门课程升级为 `needs_attention / EXTERNAL_RESULT_UNKNOWN` |
| 16:34:33.904 | Worker 最终日志只报告 `EXTERNAL_CALL_CANCELLED` |

这门课程此前已有 **12 次 LLM、34 次 TTS 成功**；一段 TTS 明确失败，另有一段 TTS 和一次 LLM 结果未知。失败语音是 51 字普通中文提示，不是超长公式：

> 自己动手做，别急着看我。提交之后我们再一起过一遍，每一题的判别式和关键那一步我都会点出来。现在开始吧。

所以本次没有依据将其归因于长文本或 TTS 请求超时。也不能因为前面 34 段成功，就断定这次一定不是供应商配额或短时错误。

### 3.4 为什么界面只显示通用错误

代码路径：

```text
MiniMax 适配器抛出 TTSProviderTerminalError
  → PipelineExecution.external 调用 repository.failStep
  → failStep 保存本步骤失败，并把其他 running attempts 标为 uncertain
  → 整门任务使用 EXTERNAL_RESULT_UNKNOWN 作为摘要，撤销旧 lease
  → 并发请求被中止
  → mapBounded 让后来到达的取消异常覆盖原始异常
```

`lib/server/generation-jobs/repository.ts` 的 `failStep()` 有合理的防重复付费目的：请求已发出但没有可信结果时不能自动重放。问题在于它将任务摘要替换成并发未知摘要，同时没有在事件里独立保存原始 `code/errorSummary`。

`lib/server/generation-pipeline/execution.ts` 的 `mapBounded()` 每次 catch 都执行 `failure=error`。本轮隔离测试明确复现：先发生 `TTS_PROVIDER_TERMINAL_FAILURE`，后发生 `EXTERNAL_CALL_CANCELLED`，最终抛出后者。运行中的 Worker bundle 也包含相同逻辑。

### 3.5 MiniMax 适配器的诊断和分类缺口

`lib/audio/tts-providers.ts` 的 `generateMiniMaxTTS()` 只按 HTTP 状态和 `data.audio` 判定：HTTP 200 没有音频时也会抛出通用 terminal error，没有独立解析、保存 `base_resp.status_code`。当前错误对象可包含原始响应字符串，但安全日志不输出它，持久化步骤只保存通用错误码，所以业务原因丢失。

官方接口定义了 `base_resp` 为请求状态码及详情，`trace_id` 用于问题定位，`data` 可能为 null；HTTP 200 本身不足以证明合成成功。参见 [MiniMax 同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)。

本报告复现使用业务码 1002 的模拟响应，只用于证明“业务码没有变成可用诊断字段”，**不是历史失败实际返回 1002 的证据**。在未拿到原始供应商证据前，不把第二次事故定性为限流。

## 4. 问题二：为何看起来第四次才调用成功

### 4.1 精确调用顺序

目标会话：`46c76742-8ade-4053-bf68-0d420895f48f`。

| 时间 | 工具调用 | 真实结果 |
| --- | --- | --- |
| 16:45:49.392 | 第一次 `submit_course_generation` | `INVALID_GENERATION_SKILL`，没有创建任务 |
| 16:46:09.237 | 第二次 `submit_course_generation` | `INVALID_AGENTS`，没有创建任务 |
| 16:46:10.274 | `get_course_generation_status({})` | `found:false`，没有已提交任务可查 |
| 16:46:26.909 | 第三次 `submit_course_generation` | 接受任务 `e06143f6-3f02-4144-a17a-9cc77fd89d5b` |
| 16:47:53.949 | Worker 完成 | 8/8 页，16 次 LLM、42 次 TTS 成功 |

这四行不是四次供应商生成失败。三条红色错误都是本地工具/任务状态问题。数据库中后续多条 `submit_course_generation` 进度事件属于同一工具调用的进度投影，不能按行数当成反复提交或重复扣费。

### 4.2 技能 ID 契约冲突

实际首次参数包含：

```json
{ "skillIds": ["stage-design", "lecture-style"] }
```

- `stage-design/SKILL.md` 要求把技能 ID 放进 `skillIds`，没有说明仅可提交有机器约束的技能。
- `runner.ts` 的 `resolveSkillConstraints` 只返回有 `constraints` 的技能。
- 提交工具用“解析结果数量是否等于全部请求 ID 数量”判断有效性。
- Web 容器中 `lecture-style/outline-constraints.json` 实际存在，包含页型比例和测验数量约束；`stage-design` 没有对应文件。

因此实际是 `stage-design` 触发整体拒绝，不能按截图里模型的解释把 `lecture-style` 一并判定为不可用。最后模型删除全部 `skillIds`，虽然能提交，却连带失去了原本可执行的 lecture-style 结构校验。

同一个数量判断还有边界风险：输入若重复同一技能，解析结果长度与 `Set` 后的长度不同，也可能误拒绝。修复必须先去重，不能继续仅比较两个数组长度。

### 4.3 角色格式冲突与错误误导

前两次角色条目都有合法 id/name/role/persona，但语音使用：

```json
{ "voice": "platform::zhiyu-default-tts::Chinese (Mandarin)_Gentleman" }
```

这是 `set_roster` 接受的绑定表达，`submit_course_generation` 的严格 `GenerationInputSchema` 只接受 `voiceConfig`，所以拒绝未知字段 `voice`。`SubmitParams.agents` 却声明为 `Type.Array(Type.Any())`，模型无法从工具 schema 得到实际字段要求。

第三次没有修成 `voiceConfig`，而是去掉了两个角色的 voice 后成功。因此“课程生成成功”并不证明模型原本选择的主讲、助教音色得到保留。后续修复不能把静默删字段当作兼容策略。

另外，提交转换 catch 存在：

```ts
const code = params.agents ? 'INVALID_AGENTS' : error.code;
```

只要携带 agents，即便真正错误是大纲 order 无效，也会返回角色错误。本轮用有效角色配无效大纲复现了这个误归类。它不是本次第二次提交的唯一原因，但会持续制造“改了角色还失败”的排障噪声。

### 4.4 其他重开的会话

当天另有三个二元一次方程会话 `b7e18a27…`、`d8385ada…`、`9153ad79…`，均已有删除时间，记录停在 `message_start`，未发现工具失败事件；还有一个早期会话已 cancelled。它们不应被当作当前仍在执行的有效会话，也不能从这些记录推出又有三次供应商拒绝。该批历史记录不足以精确判断用户删除前为何未及时看到回答；如后续仍复现“新对话无响应”，另行按会话首 token、租约和删除取消链路定位，避免混入本次 TTS 修复。

## 5. 与上游 OpenMAIC 的差别

上游 `stage-design` 的公开实现让 Agent 按顺序规划、`create_stage`、`set_roster`、逐页 `generate_scene`，最后检查页面和语音；角色工具使用可见音色绑定。智域已经把完整课程执行迁移到独立 PostgreSQL Worker，Pro 只负责规划和提交。参见 [上游 stage-design](https://github.com/THU-MAIC/OpenMAIC/blob/main/skills/agent-runtime/stage-design/SKILL.md)。

可以参考上游“角色先确定、参数可见、语音和讲稿一致”的设计。**不能复制其逐页同步调用和页面级重试规则到智域整课任务**，否则会形成两个生成执行方，破坏所有权、幂等和检查点。

上游 TTS 文件本身也不能作为智域付费结果安全重放策略的依据。此次参考的 main 是排查时公开页面，没有将它声明为与本地部署完全对应的固定版本。参见 [上游 TTS 实现](https://github.com/THU-MAIC/OpenMAIC/blob/main/lib/audio/tts-providers.ts)。

## 6. 最终修复方案

按以下顺序分批实施，每批有独立验收和回退点。前两批是必要修复；并发停机协议优化单独实施，不捆绑大规模架构改动。

### A. 修复 Pro 提交契约，消除确定性试错

涉及 `generation-job-tools.ts`、`runner.ts`、`skills.ts`、`roster-tools.ts`、`effective-voice-directory.ts`、`stage-design/SKILL.md` 和对应测试。

1. 将 `agents` 的 Any 改成明确字段 schema；对 `outlines` 明确基础字段和现有 brief/materialFacts/language 别名。工具描述提供最小合法示例。继续保留严格服务端验证，不能通过 `.passthrough()` 接受任意字段。
2. 在 Pro 工具适配层支持已有 `voice` 绑定的无损规范化，复用现有音色目录和绑定校验，再转换成完整 `voiceConfig`。如果同时提供两种字段，必须一致，否则给出精确冲突错误。平台绑定由服务端已固定的媒体快照补齐 provider/defaultId/revision/modelId，禁止由模型编造。
3. 检查 roster id 唯一、恰好一个 teacher、角色数量和字段长度；无效绑定返回字段路径及可修复原因，不能默默删除音色或换供应商。明确不自定义角色时可省略 agents；没有语音绑定并不必然是角色错误。
4. 技能解析返回三类结果：已安装且有结构约束、已安装但仅有教学指导、未知/无权访问。保留所有有效技能 ID；只有有结构约束的技能写入 `skillConstraints`，纯指导技能效果继续进入每页 brief/keyPoints。未知 ID 仍明确拒绝，不能统一忽略。
5. 对技能 ID 去重，返回逐 ID 诊断。在有大纲时提交前执行可确定的结构校验，Worker 再校验一次；没有大纲时也不能静默丢弃技能要求，应明确支持其规划传递或返回具体不支持原因。
6. 修正文档中的“所有技能 ID 都触发结构验证”说法，说明指导技能与结构技能的用途。保证 `lecture-style` 仍校验页型比例和测验数量，不能为消除报错删掉它的约束文件。
7. 按字段阶段返回 `INVALID_OUTLINE`、`INVALID_AGENTS`、技能错误等，不再通过 agents 是否存在推断错误类型。聚合纯本地校验结果，尽量一次向模型给齐问题。
8. 状态工具提示：提交失败时没有 job 可轮询，先修复入参。可将当前会话首次无任务查询作为正常 `not_submitted` 状态，并调整运行边界，避免它被误当成功任务而终止规划；显式 jobId 不存在/越权仍维持原隔离语义。不能仅把 isError 改成 false 而忽略 `runner-contract.after()` 的终止行为。

提交成功后的单次提交保护、owner/session 绑定、targetRevision 校验、独立 Worker 执行和任务幂等键全部保留。

### B. 修复 TTS 分类与诊断，给安全重试提供证据

涉及 `tts-providers.ts`、`generation-pipeline/execution.ts`、`generation-pipeline/media.ts`、`generation-jobs/repository.ts`、`workers/generation/runner.ts`。

1. MiniMax 先解析业务响应，再解码音频。成功要求业务结果有效、音频非空且是有效偶数长度十六进制；未知结构不能仅凭 HTTP 200 判为 terminal，也不能把无效字节当成功。
2. 在错误对象中保留安全的 providerId、httpStatus、providerCode、traceId、失败阶段、是否收到响应和重试分类。只存白名单字段、限定长度；不要把完整响应、讲稿、密钥或请求体写日志。
3. 将结构化首因写入持久化事件，包含 stepKey、原始分类和并发 unknown 列表。兼容现有任务和状态接口；已有 `displayProgress.issues` 可继续投影所有问题，避免另造一套状态真相。没有历史首因字段时回退到步骤记录，并注明细节不可用。
4. `mapBounded` 只记录第一个失败，后续取消归为次生异常；停止派发新任务并等待已启动任务退出。Worker 应报告保存的首因，不能只报告被包装后的取消。用户取消、租约丢失仍应独立识别，不能误报为供应商错误。
5. 对 DNS 仅在**单次合成 HTTP 请求、明确发生在发出前**的边界提供有限本地重试：例如最多额外两次、受原 deadline 和 AbortSignal 约束、仍在同一 durable attempt 内。不能把全部 TTS 外层回调标为安全，因为它可能包含多个外部步骤和资产写入。
6. 供应商明确拒绝且可安全重试的类型使用现有 quota cooldown 和有上限重试；具体业务码以该供应商官方定义为准。认证、余额、参数等需修正的问题不自动循环。连接中断、响应遗失、超时、音频保存失败、检查点提交失败仍保留 unknown 保护。
7. 保持当前 TTS 开关和媒体快照语义，不用“偷偷关语音”“切换模型/供应商”“返回空音频”让课程假成功。不要通过普遍延长超时解决本次 95 ms 的拒绝。

当前两个并发任务已经不确定时，`needs_attention` 是合理状态；修复目标是减少可避免的失败、显示真实原因并安全恢复，不能承诺完全消除所有外部服务不确定性。

### C. 展示明确首因，恢复已有任务

Pro 聊天和课堂状态应同时显示首因与保留进度，例如：

> 第 5 页语音合成失败，4/10 页已保存。另有一段语音和第 7 页内容请求结果尚未确认。查看详情后可决定是否从检查点重试。

详情包括首因类别、步骤、时间和供应商追踪标识；未知供应商细节就明确写未知，不继续让模型猜测。已有 pending/retry_wait 页面在任务停止时不应继续表示正在生成；现有前端相关改动需要合并验收，不能覆盖。

恢复要复用同一任务的检查点，只补未完成步骤，并再次核对课程所有权和版本。unknown 重试遵循现有用户确认机制；不能为消除提示默认 acknowledged=true。已取消/删除任务不通过 SQL 改回 running，本次第二个历史任务已 cancelled，不应由本轮擅自复活。需要新课程时通过正式提交创建，并清楚区别于原任务恢复。

### D. 并发收尾优化单独处理

可进一步设计“单步骤失败后停止新调度，保留有效租约，在有上限的收尾窗口内保存已在途的可信成功结果，再最终判定任务”的协议，以减少同伴请求被立即置为 unknown。

这会改变租约、failStep 事务和提交时机，必须单独设计并测试，**不作为 A/B 最小修复的一部分**。不能只删除标记并发 uncertain 的 SQL 或放宽旧 lease 提交限制。若采取低并发临时试验，也要评估内容预取与 TTS 的交叠；只调整一个并发数字不等于所有外部请求都串行。此次不更改运行并发、DNS 或供应商配置。

## 7. 回归边界和验收矩阵

| 边界 | 必须通过的验证 |
| --- | --- |
| 技能 | stage-design + lecture-style 正常处理；纯指导技能保留；未知/越权拒绝；重复 ID 去重；结构违规仍阻止提交或生成 |
| 角色 | voice/voiceConfig 一致转换；冲突/未知音色拒绝；平台 revision 校验；自定义/自动角色；重复 id、多 teacher 拒绝；角色音色不丢失 |
| 提交错误 | 大纲错误不再提示改角色；无任务查询不诱发虚假恢复；拒绝不创建任务；接受仅创建一个任务 |
| MiniMax | HTTP 200 + 业务失败、HTTP 429、401/403、5xx、空体、错误 hex、正常音频；业务码与 HTTP 状态分开保存 |
| DNS/重试 | 明确发出前失败才有限重试；响应后失败不重放；多个外部请求的适配器不误用；中止及时生效 |
| 并发 | 首因不被取消覆盖；未知同伴仍保留；停止后不再派发新请求；不接收过期 lease 的晚到提交 |
| 持久化 | 成功的 34 段音频不重复生成；资产/检查点失败不冒充成功；恢复依赖和目标版本一致 |
| 原有功能 | 普通模式、自定义供应商、TTS 关闭、单页 Pro 编辑、原始 PPT 导入、平台快照与用户模型连接维持原行为 |
| 页面 | Chrome/Edge 各进行微分方程与二元一次方程新会话验收；同步核对 DB jobId、页数、语音资产和错误详情 |

建议先用模拟服务覆盖故障矩阵，再进行真实供应商的小规模冒烟。至少对两类用户主题各完成一门开启 TTS 的课程，并检查两个浏览器中相同任务的状态一致；单次真实成功只能证明该次成功，不能代替确定性错误测试。

部署时记录 Web 和 Worker 镜像摘要，确保来自同一已验收版本；如引入事件扩展，旧记录和旧读取端也须兼容。通过正常维护/排空方式更新，避免在付费请求执行中直接杀进程。回退使用上一对镜像，不重置业务数据库，不手工清空失败记录。

## 8. 本轮复现和测试结果

### 8.1 现有测试基线

实际使用 Node `v24.19.0` 和 Vitest `4.1.8`，以下 6 个测试文件共 **115/115 通过**，退出码 0，耗时约 26.26 秒：

```text
tests/agent-runtime/generation-job-tools.test.ts
tests/agent-runtime/runner-contract.test.ts
tests/audio/tts-terminal-errors.test.ts
tests/audio/tts-rate-limit.test.ts
tests/server/generation-worker-pipeline.test.ts
tests/server/generation-jobs.test.ts
```

这只是修复前基线，不代表故障已修复。现有测试还显式接受了 MiniMax HTTP 200 + 无音频被统一判为 terminal 的旧行为，后续应依照新的明确分类调整相应断言，不能只增加一个并行测试而留下矛盾契约。

### 8.2 隔离复现

本目录附带 `repro.test.mjs`、`vitest.config.mjs` 和原始 `repro-results.json`。不读取 `.env.local`，使用模拟 fetch、模拟工具 repository，未连接真实供应商/业务库。

| 复现项 | 本轮结果 |
| --- | --- |
| stage-design 混入后整体拒绝 | 与历史一致 |
| lecture-style 单独在提交入口可接受 | 与约束文件一致；本例不代表 Worker 页型约束验收 |
| voice 字符串拒绝，省略后接受 | 与历史一致 |
| 未创建 job 时状态查询失败 | 与历史一致 |
| 期望工具 schema 暴露 voiceConfig | **失败**：items 是 Any |
| 期望有效角色 + 无效大纲报 INVALID_OUTLINE | **失败**：实际 INVALID_AGENTS |
| 期望首个 TTS 异常保留 | **失败**：实际被 EXTERNAL_CALL_CANCELLED 覆盖 |
| 期望保留 MiniMax 业务码 | **失败**：结构化 providerCode 缺失 |

复现结果为 **4 项历史行为验证通过，4 项修复目标断言失败，退出码 1**；断言执行约几十毫秒，首次模块加载约十秒。该红色测试位于文档目录，不会加入默认 `tests/**/*.test.ts` 测试集。实施后应把相应断言移入正式测试，转绿后再删除或更新这份历史复现，不把红色报告说成验收通过。

在仓库根目录 PowerShell 执行：

```powershell
$proNode = 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $proNode node_modules/vitest/vitest.mjs run --config docs/investigations/pro-generation-2026-09-13/vitest.config.mjs
```

本机默认 `node` 不具备 Vitest 所需的 `node:util.styleText`，所以实际切换到上述已安装运行时。首次 pnpm 包装器触发了依赖准备流程，已中止并改为直接调用本地 Vitest；未进行应用构建发布。复现不要求安装新依赖或升级项目版本。

## 9. 实施完成的判定

只有在 A/B/C 的参数、分类、诊断与界面修复完成，故障矩阵通过，相关现有测试持续通过，并对同版本 Web/Worker 完成浏览器和真实生成验收后，才可宣布修复完成。

本次已经把“为什么报错”定位到具体历史步骤和代码分支；仍无法从已经丢失的日志中恢复第二次 MiniMax 的精确业务原因。最终方案首先保证下一次失败能留下正确、可行动的证据，同时消除已经确定的 Pro 提交试错，且保持智域现有生成架构和安全恢复边界。
