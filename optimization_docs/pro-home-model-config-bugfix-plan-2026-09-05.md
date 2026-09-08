# PRO 无法使用 Home 模型配置的最小修复方案

日期：2026-09-05。状态：已于 2026-09-06 实施模型连接修复；真实用户供应商调用仍待有效 Home 配置冒烟。交付结果见 [修复验证记录](pro-home-model-config-bugfix-result-2026-09-06.md)。下文保留原方案及实施前证据。

**本阶段只修复：Home 已配置有效模型和 API，但进入 PRO `/workspace` 后消息执行失败、无法生成课程。保留现有 PRO 对话、提问卡片、skill、课程生成和编辑能力，不建设新的咨询或评估系统。**

本文替代此前的综合方案。用户已撤回“默认询问 1～3 轮”的要求；动态测试、Lesson 计划、checkpoint、动态题集、assessment attempt、报告及建议闭环均为后续独立工作，不是本次修复的依赖或验收条件。

## 1. 可以复用普通模式，而且现在已经共用核心生成函数

PRO 与普通模式的差异可以主要放在生成输入的形成方式：普通模式从用户的一次输入出发；PRO 从连续对话中理解想学什么、目前处于什么阶段，并将已明确的信息用于页面计划和生成 brief。学习者可以主动选择 skill，让 AI 进一步追问。没有固定轮数，不要求填写画像表，也不新增全局方案确认状态机。

代码证据：

| 能力 | 普通模式 | PRO | 本阶段处理 |
| --- | --- | --- | --- |
| 页面内容 | [scene-content API](../app/api/generate/scene-content/route.ts) 调用 `generateSceneContent` | [generation-tools.ts](../lib/server/agent-runtime/generation-tools.ts) 调用同名函数 | 继续共用 `@openmaic/generation` |
| 讲解动作 | [scene-actions API](../app/api/generate/scene-actions/route.ts) 调用 `generateSceneActions` | `generation-tools.ts` 调用同名函数 | 继续共用 |
| 页面组装 | scene-actions API 调用 `buildCompleteScene` | `generation-tools.ts` 调用同名函数 | 继续共用 |
| 输入准备 | 大纲、要求、材料、角色等由普通生成流程提供 | 对话/skill 形成 `title/type/brief/materialFacts`，课程提供角色和语言 | 保留两种准备方式，不只转发最后一句话 |
| 编排和存储 | 普通模式自己的预览、生成及存储入口 | agent 工具逐页执行，经 owner 校验持久化并反馈进度 | 不重写，不互相绕过 |

**推荐：复用现有底层生成函数，修复它们在 PRO 中的模型配置注入。**两种模式已经共享生成内核，不需要复制一套普通模式代码，或让 PRO 跳回 Home 才能生成。

底层共用不代表所有外围能力完全相同：材料转换、媒体、前后页上下文、重试及存储仍由各自调用层提供。本次只保证现有 PRO 所需的模型连接和生成输入正确，不承诺一次性统一全部外围流程。

### 为什么本次不直接改成调用整个普通生成接口

当前 [generate-classroom API](../app/api/generate-classroom/route.ts) 已属于另一套后台 job 控制面，包含幂等键、provider preflight、配置指纹、资产和 job 生命周期；[generation/session-input.ts](../lib/generation/session-input.ts) 还明确拒绝浏览器自填的 Key/base URL。

直接让 agent 调用它，需要额外打通身份、凭据、材料、任务进度、取消、已有课程编辑和课程归属，未必更简单。也不能在 worker 里调用浏览器 hook 或依赖浏览器 localStorage。

等后续有统一生成任务编排需求，再考虑提取公共服务层；它不是修复当前 bug 的前提。

## 2. 根因与证据

### 2.1 当前报错的直接原因

截图错误：

```text
MODEL_ROUTES must explicitly configure stage "maic-agent-driver"
with a provider-prefixed model id and an api/dialect.
```

[agent-driver-model.ts](../lib/server/agent-runtime/agent-driver-model.ts) 的 `resolveAgentDriverModel()` 强制要求服务器存在有效的 `maic-agent-driver` 路由；缺失时直接抛错，不读取 Home 配置，也不回退到 `DEFAULT_MODEL`。这是驱动初始化错误，此处尚未调用上游模型，不能据此认定 API Key 无效。

“缺失”包括未设置、解析后条目无效或运行进程没有加载预期配置；尚未读取实际容器环境，不能断言具体漏了哪个文件。

### 2.2 Home 配置在 PRO 控制面断开

- [model-config.ts](../lib/utils/model-config.ts) 的 `getCurrentModelConfig()` 能获得 Home 选择的模型、Key、地址、providerType 和 thinking。
- 普通模式 [use-scene-generator.ts](../lib/hooks/use-scene-generator.ts) 等调用层把配置放入请求头。
- PRO [session-store.ts](../lib/workbench/session-store.ts) 的新建会话和续聊请求没有模型连接或连接引用；[session API](../app/api/agent/sessions/route.ts) 和 [message API](../app/api/agent/sessions/[id]/messages/route.ts) 也未建立对应的后台配置绑定。
- [runner.ts](../lib/server/agent-runtime/runner.ts) 在原 HTTP 请求结束后启动，调用无参数的 `resolveAgentDriverModel()`。

所以只修改按钮跳转或加一个前端请求头都不够：后台必须实际取到本用户的连接。

### 2.3 页面生成还有第二处配置断点

[generation-ai-call.ts](../lib/server/agent-runtime/generation-ai-call.ts) 只调用 `resolveModel({ stage })`。即使 agent 对话模型修好，`scene-content`/子类型与 `scene-actions` 仍可能因为服务器没有默认模型或对应路由而失败。

修复必须同时覆盖 **driver → 页面内容 → 讲解动作**，不能以“AI 能回复一句话”作为完成标准。

### 2.4 入口将开关误当成可用性

[runtime API](../app/api/agent/runtime/route.ts) 和 [feature-flags.ts](../lib/config/feature-flags.ts) 仅判断 runtime 开关与非空数据库地址。前次只读检查本机接口返回 `enabled=true/runtimeEnabled=true`，但没有验证模型配置。

## 3. 最小实施设计

### 3.1 从 Home 同步一个可供 PRO 后台使用的连接

复用 `getCurrentModelConfig()`。在首次 PRO 发送、以及用户更改模型后，通过同源受认证 API 同步当前连接；服务器返回不含秘密的连接引用。新建会话和后续消息用该引用绑定下一次执行所需配置。

保持用户此前确认的“服务器按当前用户隔离、加密保存”决定，但本阶段仅实现支撑这个 bug 的最小连接保存能力，不建设通用连接管理平台、跨设备账户或分阶段模型选择界面。

建议最小数据：

```ts
// 建议契约；尚不存在于当前代码。
type ProModelRef = { id: string; revision: number };

type ProModelMetadata = {
  modelString: string;
  providerType?: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'openai-responses';
  // thinkingConfig 使用已有类型；Key 位于独立加密记录中。
};
```

执行要求：

1. 一个 run 使用固定连接版本；后续 Home 修改作用于下一次执行，不能生成到一半换模型。
2. 重启/刷新后可以按会话绑定取回配置；旧会话没有绑定时，从当前 Home 同步后继续，不能静默换一个默认供应商。
3. Key 不进入消息、模型上下文、SSE、课程文件、导出、普通日志或明文 job 输入；连接引用也不能作为跨 owner 授权凭证。
4. 通过现有设置路径提供连接清除/替换，清除后阻止后续调用；已发出的上游请求不能保证撤回。主加密密钥由部署 secret 提供，缺失时明确报配置错误，不降级明文。
5. 不使用进程全局“当前模型”覆盖多用户配置。

**必要身份约束：**当前 [owner.ts](../lib/server/agent-runtime/owner.ts) 的部分路径使用未签名匿名 cookie；不能据此开放新凭据读写。复用/抽取已有 [generation-jobs/auth.ts](../lib/server/generation-jobs/auth.ts) 的签名 owner 和同源验证能力，使凭据访问不依赖另一后台生成开关。旧 owner 的迁移不得仅凭客户端提供的 UUID 自动认领；本地受信迁移需有明确路径。此项只覆盖模型连接的必要隔离，不要求新增登录系统。

客户端 endpoint 继续应用 SSRF/重定向校验，不能因存进数据库就被视作管理员可信地址。服务器托管 provider 的 Key 和地址仍由管理员控制，不接受客户端覆盖。

### 3.2 修复 driver 的配置解析

将 `resolveAgentDriverModel()` 改为可接收本次 run 的连接上下文，按下列规则解析：

| 条件 | 选择 |
| --- | --- |
| 管理员显式配置 `maic-agent-driver` | 保留服务器路由优先，并在设置/状态中说明实际生效模型 |
| 未配置专用路由，存在有效 Home 连接 | 使用 Home 连接，不再因缺少环境变量而失败 |
| 用户已有连接但 Key/协议等无效 | 返回可修复错误，不悄悄使用另一把 Key 或其他模型 |
| 旧部署无个人连接 | 可保留已有显式服务器配置；无有效来源则提示配置 |

保留 provider 前缀验证、协议能力检查、thinking 兼容性及输出窗口处理。已知 provider 根据已有配置/元数据明确映射方言；自定义 endpoint 无法确定时要求在现有连接设置中选择协议，不能一律猜 `openai-completions`。

当前适配器只接受 `openai-completions/openai-responses` 且拒绝 `thinking.effort`。这是现有传输边界，本次不扩展全新的 provider 协议；但 Home 的 thinking 参数必须按当前驱动能力规范化或明确提示，不能在 fallback 后原样塞入并制造另一处错误。对自定义模型区分“能力未知”和“已确认不支持”；普通文本连接测试成功不代表工具调用可用。

### 3.3 向共用生成函数注入同一个连接上下文

建议接线：

```text
Home 当前模型
  → 加密保存 / 取得 owner 连接引用
  → 会话与下一次 run 绑定
  → runner 解析运行连接
      ├─ resolveAgentDriverModel(context)
      └─ buildDslCourseToolset(..., modelContext)
          → buildGenerationTools(..., modelContext)
          → createGenerationAiCallFactory({ modelContext, abortSignal })
              ├─ generateSceneContent(...)
              └─ generateSceneActions(...)
```

保留 [resolve-model.ts](../lib/server/resolve-model.ts) 的 `stage route > 客户端模型 > DEFAULT_MODEL` 语义：没有阶段路由时，将本用户已解析的连接作为 fallback；命中路由时使用该路由自己的服务器凭据，不能把 Home 的 Key 传给另一提供商。

内容阶段继续使用现有 `scene-content`/子类型匹配规则，动作阶段使用 `scene-actions`。不要把 driver 最终选中的管理员专用模型强行覆盖所有阶段；**共用的是 Home fallback 和连接解析规则，各阶段显式配置仍然有效。**

不重写 `generateSceneContent/generateSceneActions/buildCompleteScene`。PRO 继续用现有逐页工具、存储检查点、取消及 owner 校验。图片/TTS 等沿用既有独立配置，不将 LLM Key 自动当成媒体 Key；无可选媒体能力不应妨碍文字咨询，课程生成的降级行为按既有能力处理并验证。

### 3.4 保留对话式需求与 skill，不增加固定教学流程

- 继续使用现有会话历史和 skill。学习者愿意先聊就持续对话，主动选择 skill 时按它追问；本次不增加默认 1～3 轮或强制画像采集。
- 保留现有 skill 自己的提问/确认规则，不额外新增全局表单、确认卡、CourseProposal 表或工具确认门禁。
- 生成时把对话中已明确的主题、基础、目标和范围放入既有页面 `brief` 等参数，确保不会仅使用最后一句“开始生成”。直接聊天无需落地新画像模型。
- 通过回归场景验证现有 agent 是否带入前文；若丢失，针对 prompt/参数拼装做小修正，不另建课程规划系统。不得把材料中的指令当作连接设置或授权。

### 3.5 配置检查与错误恢复

在 PRO 首次发送前、API 入队前及 runner 执行前校验实际连接；检查 driver 以及页面内容/actions 的模型可解析性，明确区分“能聊天”和“能生成”。API 复核处理浏览器检查后配置被修改/撤销的竞态。

部署 runtime 探针保留兼容字段，但不能单靠原 `enabled` 判断当前用户模型就绪。个人配置检查必须带身份，只回显脱敏结果。Key 是否被上游接受仍需真实调用判断；本地静态校验不能声称已验证远端服务。

错误 UI 至少区分：

| 类别 | 处理 |
| --- | --- |
| 未绑定模型、协议/工具不支持、Key 无效/已撤销 | 停止无效重试，显示“打开模型设置/重新检查” |
| 已接收消息但后台执行失败 | 明确是执行失败，保留原消息、附件及已有课程 |
| 临时网络、限流等 | 沿用有界重试/取消，失败后可手动恢复 |

修复配置后继续原会话；不要求重复输入整段需求，不将已有页面当作未生成而重复建课。终态恢复发送按钮，错误详情仅保留脱敏错误码与必要诊断。

## 4. 改动清单和实施顺序

| 顺序 | 文件/模块 | 改动边界 |
| --- | --- | --- |
| 1 | 现有 model-config、设置交互；最小加密连接 API/存储；公共身份验证 | 保存/同步 Home 连接并返回引用，必要 migration |
| 2 | PRO session-store、session/message API、agent-session 类型和存储 | 绑定下一次 run 的连接版本，兼容旧会话 |
| 3 | agent-driver-model、runner | 未设专用路由时使用 Home；保留协议校验和管理员优先 |
| 4 | DSL 工具依赖、generation-tools、generation-ai-call | 给已共用的生成函数注入配置，保留原编排 |
| 5 | runtime/preflight、PRO 错误卡和发送状态 | 能力可见、配置错误可恢复、避免重复无效运行 |
| 6 | 对应单测、store/API 集成及最小端到端回归 | 验证发消息与完整课程生成均恢复 |

本次不改普通模式的整体流程，不引入新的后台 job 编排，不要求重构现有 Quiz/评分/runtime，不实现课前诊断或任何新增评估实体。现有大量未提交改动需要保留；连接改动应与其兼容，不删除已有后台 job 对明文凭据的禁止规则。

## 5. 验收标准

1. **核心复现：**无 `MODEL_ROUTES.maic-agent-driver`，只在 Home 配置支持工具调用的有效模型/Key，进入 PRO，成功回复；随后按已有生成流程完成并打开一门课程，而非仅生成空 Stage。
2. **三段配置：**driver、scene-content 和 scene-actions 都能在无专用服务器路由时使用 Home 配置。显式路由覆盖时 Key/endpoint 不串用。
3. **对话信息：**先说“学过微积分、想练一阶微分方程方法判断”，后说“生成课程”，生成输入保留前文；没有新增固定提问轮数，已有 skill 可正常加载和提问。
4. **失败恢复：**缺 Key、错误 Key、不支持的方言/工具能力、连接撤销都有准确提示，输入保留；改好配置后原会话能继续。
5. **持久执行：**刷新/重启后连接可解析；Home 换模型作用于下一次 run，运行中不混用版本；取消与重试不重复建课、不覆盖无关旧课程。
6. **隔离：**不能引用他人的连接，伪造未签名 owner 不能读取/消费凭据；消息、SSE、日志、课程导出和 API 响应无明文 Key。
7. **回归：**普通模式生成、PRO 既有课程编辑、材料引用及原有 skill 行为保持正常；现有 Quiz Scene 仍能生成，但不以新增评估体系为验收条件。

建议以桩模型覆盖完整 driver/tool/content/actions 链路，再做一次实际配置的最小课程冒烟。只通过配置解析测试或只收到一条 AI 回复，不算修复完成。

## 6. 已有验证与本次交付状态

前次审查已完成代码追踪、runtime 接口只读检查，现有 `agent-driver-model/runtime-probe/runner-contract/generation-tools` 测试共 4 个文件、27 项通过；这是**原实现的基线**，包含“缺独立路由就失败”的旧期望，不证明新方案已实现。

本轮进一步核实普通模式和 PRO 共用的三个生成函数，以及当前 generate-classroom API 的后台 job 边界，仅更新方案与决策文档。未调用真实模型、未修改业务代码、数据库、Key 或部署。实施后需更新旧契约测试，并完成上述验收。

相关决策：[当前范围 ADR-0007](../docs/adr/0007-fix-pro-model-binding-with-existing-generation.md)、[凭据边界 ADR-0006](../docs/adr/0006-own-encrypted-model-connections-on-server.md)。
