# 智域 Pro 修复：实施与验收记录

日期：2026-09-13。对应 [原始排查及方案](./README.md)。本轮依据用户明确授权实施，并允许真实模型和语音调用；保留既有工作区修改、UI 和普通模式的正常生成流程。

**修复与最终镜像/容器更新已完成。最终版本两门 Pro 短课均 3/3 页、一次提交、零工具错误，36 段真实音频完整入库；此前两个 8 页 Pro 课程与一个 8 页普通课程也真实生成成功。UI 614 个文件零变化。本记录保留中间失败及后续修复证据，最终容器和验收结果见文末。**

## 实施内容

### 1. Pro 提交契约对齐

- `lib/server/agent-runtime/pro-generation-input.ts` 定义模型可见的角色及页面参数，并在 Pro 边界做严格转换。角色必须具有稳定 id、name、role、persona；唯一主讲、重复 id、冲突字段等在入队前校验。
- `list_voices` 返回的 `voice` 字符串可以直接用于 Pro 提交，按本会话冻结音色目录转换为完整 `voiceConfig`。平台 defaultId、revision 和实际模型身份保持一致；用户音色不被偷偷替换成平台默认值。
- 同时传入不一致的 `voice` / `voiceConfig`、未知音色、过期身份或缺 modelId 导致多模型歧义时明确拒绝。合法的已有 `voiceConfig` 继续可用。
- `generation-job-tools.ts` 和 `runner.ts` 将已安装技能区分为“教学指导”和“结构约束”。`stage-design` 作为指导仍有效；`lecture-style` 的结构约束继续执行。去重技能 id，不再因为指导型技能没有 JSON 约束而拒绝整份提交；未知或无权限技能仍拒绝。
- 使用技能必须提供页面规划，把指导写入页面 description/keyPoints；结构约束在入队前检查。不是删除全部 skillIds 或放宽共享生成输入校验。
- 角色和大纲问题一次性返回准确字段路径，修正“只要有 agents 就把错误统称 INVALID_AGENTS”。无任务时的查询仍返回错误，但明确提示先修正并成功提交，避免把尚未入队误判为生成故障。
- 更新应用自身的 `skills/agent-runtime/stage-design/SKILL.md`，使教学代理获得的说明与实际工具一致。没有改页面组件或交互样式。
- 真实验收进一步发现 `ROSTER_TOOLS_PROMPT`、`list_voices` / `set_roster` 描述和旧 DSL 翻译说明仍诱导先建课堂、再写角色。已统一为：新整课通过 `submit_course_generation.agents` 提交角色；已有课堂及原始 PPTX 导入才使用 `set_roster`。同步修正缺失课堂时的恢复提示及 stageId 来源说明。只修改提示文本，保留全部工具注册和执行防线，避免影响同一会话生成后的编辑、动态切换技能及 PPTX 导入。

### 2. TTS 分类、首因和未知结果保护

- MiniMax 只有 `base_resp.status_code=0` 且音频为非空、偶数长度的合法 hex 才视为成功。HTTP 200 但缺音频、畸形 JSON、无有效业务状态码或非法 hex 均保留为 `TTS_INVALID_RESPONSE` / 结果未知。
- 明确限流业务码 1002、2045 进入现有延迟重试；明确忙碌码 1024、1033 进入现有暂时故障处理。认证、参数等明确拒绝按已知终止码处理。1000、1001、1041、HTTP 408 及未识别业务码不被猜测成可安全重发。
- 分类依据：[MiniMax 官方错误码](https://platform.minimaxi.com/docs/api-reference/errorcode)。本轮没有证据证明历史 4/10 的故障就是限流；补充诊断是为了后续能区分具体原因。
- 仅 Pro 的 MiniMax 请求启用至多两次额外的发送前 DNS 重试，要求底层明确 `getaddrinfo` + `EAI_AGAIN` / `ENOTFOUND`。沿用同一个超时/取消信号。该模式拒绝重定向，防止将“已发送 POST 后重定向目标 DNS 失败”误判成首次请求未发送。普通模式没有这个 opt-in。
- `mapBounded` 保留第一个错误并等待已启动的工作收尾，不再被后续取消异常覆盖。执行器传播该首因，同时保留外部取消和租约失效的原有处理。
- `GenerationJobRepository.failStep` 在同一事务的事件里记录 `primaryFailure`、`concurrentUnknownCount` 及每个并发未确认请求的 `stepKey` / `attemptId`。同时记录允许字段内的 providerId、HTTP 状态、业务码、traceId、响应阶段与重试分类；不保存供应商原始响应、密钥、认证头或原始错误栈。
- Worker 日志使用同一白名单。并发请求确实无法确认结果时仍进入 `needs_attention`，保留原租约、检查点、幂等键和人工确认边界，不能靠清除状态“修复”。

共享 MiniMax 适配器和任务诊断有必要的故障路径变更；普通模式的正常规划、生成、成功音频解析结果和持久化入口未更换。自动故障重放能力只在上述明确安全条件下使用，未启用全局盲重试。

## 边界与回归证据

- 修复开始时保存工作区补丁，避免误将用户既有修改当成本轮修改。未创建提交、清理工作区或覆盖已有 UI 工作。
- 对 `app`、`components`、`lib/i18n`、`public` 的 614 个已跟踪文件逐一计算 SHA-256：本轮修改前后 **0 个变化**。
- 新增测试覆盖指导/结构技能、音色冻结身份、歧义拒绝、字段错误、首因保留、并发 unknown 事件、诊断脱敏、MiniMax 业务分类、非法响应和发送前 DNS 边界。
- 普通/home/Pro 三种来源使用同一合法音频及角色绑定成功生成测试；只有 Pro 增加 DNS opt-in 对应的请求限制，普通成功参数不变。
- 专项数据库/执行器/Worker/音频持久化 107 项通过；随后新增来源边界测试连同 MiniMax 安全响应测试 35 项通过。这些是交叠测试集合，不相加作为总数。
- 最后一次字段诊断/提示修复后，完整 Pro 运行时目录：82 个文件通过，4 个跳过；1,026 项通过，11 项跳过。新增提示/恢复指引回归与别名兼容、聚合错误、完整重交和拒绝边界回归；目标 ESLint 和全库 TypeScript 再次通过。
- 全库 TypeScript `--noEmit --incremental false` 通过。源码 ESLint 无错误；包含已生成的 `dist-worker/generation.mjs` 的裸 `eslint .` 会报 7 个 bundle 内第三方代码规则错误，排除该构建产物后通过。没有修改生成产物来规避检查。

### 全量检查中的既有问题

本机默认 Node 18 不能运行当前工具链，因此使用 Codex 自带 Node 24；Docker 按仓库既有配置使用 Node 22。

- Node 24 新增原生 `navigator.locks`，使假设无 Web Locks 的 quiz/chat 测试走入锁分支，导致并发 barrier 等待。不改代码，仅给测试进程设置 `NODE_OPTIONS=--no-experimental-global-navigator` 后两组 94/94 通过；默认 Node 24 的独立复跑重现了 44 个对应失败。
- 旧 Pro 测试的全量 mock 丢失现有 `AGENT_DRIVER_STAGE` / `createProCourseRuntimeBoundary` 导出；另一处将同步 streamLLM mock 成异步。修复 8 个测试文件的替身，保留原断言，生产运行时没有为迁就测试追加修改。
- 两个静态断言与 HEAD 本来就不一致：`phase0-verification-contract` 仍要求 Dockerfile 内存在 corepack prepare 字面量，而实际已委托脚本；`asset-url-boundary` 命中 HEAD 已有的 persistence/bootstrap.ts。相关源文件和测试无本轮变化，另行维护，没有扩张本次业务修复范围。

业务修复后的全量运行（早于最后的提示文本对齐）：**742 个测试文件通过、2 个失败、12 个跳过；7,996 项通过、2 项失败、55 项跳过，总计 8,053 项**，耗时 173.53 秒。仅剩上面两项经 HEAD 对照确认的静态问题。最后的提示修改使用上述完整 Pro 目录、TypeScript 和 ESLint 复验；不能把这一结果表述为“全库所有测试全绿”。

## Docker 发布

保留原 Compose 项目 `openmaic-main`，原 `.env.local`，原数据卷 `openmaic-main_openmaic-data` 与 PostgreSQL 卷 `openmaic-main_openmaic-postgres`。不执行 `down`、删除卷、数据库重建或历史任务复位。

更新前镜像已保留为回退标签：

| 服务 | 回退标签 | 原 image ID |
|---|---|---|
| Web | zhiyu:before-pro-repair-20260913 | sha256:4bcc995e543af4cd18e94fd2a1808d26167b547f288a89b76fe439d066d0d4d2 |
| Worker | zhiyu-worker:before-pro-repair-20260913 | sha256:2878f28e536eeadb2c9e7e58b31ce20303e5b0882151c34a69510e47ba57b0fe |

部署使用 `scripts/generation-compose.ps1` 的 build → migrate → start-worker → start-app 顺序，均带 `-AllowDirty`，两镜像使用同一工作区内容指纹。构建与启动之间冻结源文件和测试文件。当前 PowerShell 中 SetEnvironmentVariable(null) 会留下空变量，必须用 `Remove-Item Env:<key>` 清除仅本进程的 Compose 覆盖变量，才能使原 `.env.local` 保持权威；没有修改配置密钥。

默认构建遇到 npm/Alpine 的 DNS 错误；仅 host 或仅 npm 镜像源的试跑也未能及时推进，均在新镜像完成前停止，对运行容器无影响。随后从 Docker 成功构建历史核对到上一版同时使用 `-UseHostBuildNetwork -NpmRegistryOverride https://registry.npmmirror.com`。完整复用这组参数及既有依赖缓存后，Web 和 Worker 均构建成功，不变更 Dockerfile、锁文件或运行网络。

### 容器更新核验

每轮发布均执行迁移脚本、更新 Worker、更新 Web，并核实容器实际 image ID 与构建结果一致。不是仅重新启动旧容器。更新前后两容器的全部运行环境变量排序哈希分别完全一致；共享卷身份和挂载路径完全一致。PostgreSQL 容器保持原实例。`/api/health/ready` 的 database/schema/worker/accepting 全部为 true，pipelineVersion 为 2。最终运行镜像见文末。

## 真实验收与限制

真实验收使用新的测试 owner，通过与浏览器相同的正式 HTTP 接口绑定平台模型及 TTS 冻结快照，调用真实 Pro 模型工具链和持久化 Worker。测试顺序为微分方程 Pro、二元一次方程 Pro、二元一次方程普通模式，均要求中文讲解及真实语音。未手工改数据库模拟成功，未恢复历史取消或删除的任务。

浏览器/电脑插件在本轮仍返回 `Unable to load browser request-header policy`，无法取得 Chrome/Edge 页面。因此不将接口验收冒充点击、视觉或音频实际播放验收；UI 无变更由文件哈希证明，课程和音频结果由真实接口与数据库/资产证据验证。

### 真实验收追加发现：Docker Desktop DNS 间歇故障

第一轮新业务镜像下，微分方程 Pro 会话 `27806103-2b7e-4c8b-8a4b-b1319ea36af9` 在模型阶段失败；二元一次方程 Pro 会话 `ba1cf629-d199-4b6c-b1e5-a8ed74db50ce` 后续记录租约丢失/取消；普通模式任务 `433d8201-64bd-4518-a238-7a7bf9d04983` 停在大纲阶段。均未走到本轮 TTS 修复路径。

Web 的安全诊断记录 DeepSeek 发送前 `EAI_AGAIN`；普通 Worker 的 `plan:call:0` 连续三次发送前 DNS 失败，分别约 5,025 / 5,008 / 5,007ms，requestSent 和 responseReceived 都为 false。不是技能/角色再次被拒绝，也不能声称课程验收已经通过。

独立网络对比证据：

- Web/Worker 使用 Docker 内置 DNS `127.0.0.11`，外部转发到 Docker Desktop 的 `192.168.65.7`。主机同时存在 WLAN 和 VPN DNS；证据只能证明 Docker 默认转发路径不稳定，不能单凭此认定 VPN 软件本身有缺陷。
- 跨 TTL 的五轮 DeepSeek 默认 getaddrinfo 有一轮约 5 秒 `EAI_AGAIN`，另一轮成功仍耗时 2.83 秒。强制 IPv4 也出现相同错误，故未采用 ipv4first 或硬编码供应商 IP。
- 默认 Docker 外部 A 查询出现超时；直接使用可达公共 DNS `223.5.5.5`、`119.29.29.29` 的两域 A 查询稳定成功，AAAA 空记录属正常结果。
- 使用无数据卷、无密钥的临时容器，在同一项目网络下指定上述 DNS，三轮供应商和 `postgres` getaddrinfo 共 9/9 成功；两家供应商无认证 HEAD 分别返回预期的 401 / 404，证明 HTTPS 可达，未调用付费模型。

处理方式仅作用于这台机器的智域部署：新增可选 `docker-compose.dns.local.yml`，内容如下：

```yaml
services:
  openmaic:
    dns: [223.5.5.5, 119.29.29.29]
  generation-worker:
    dns: [223.5.5.5, 119.29.29.29]
```

`scripts/generation-compose.ps1` 在该文件存在且为普通文件时统一追加 `-f`，不存在则沿用部署平台默认 DNS；目录或其他错误类型明确拒绝。文件已加入 `.gitignore` / `.dockerignore`，不会把本机解析器固化到共享镜像或其他部署。此次验收日志目录也忽略，避免持续写入的日志/JSON 影响发布源码指纹。

部署前用真实 `docker compose config` 比较基线与 overlay：移除两服务的 dns 后，完整配置 JSON 完全一致。未修改主机/VPN设置、数据库、凭据、端口、网络拓扑或业务请求内容。部署契约 12 项与 PowerShell 语法检查通过。

DNS 机制依据：[Docker 服务 DNS 配置](https://docs.docker.com/reference/compose-file/services/#dns)、[Docker DNS 服务](https://docs.docker.com/engine/network/#dns-services)、[Node DNS](https://nodejs.org/api/dns.html)。Docker 仍负责内部服务发现，显式 DNS 配置用于外部域名转发。若将来配置了只由 VPN 解析的私有模型域名，需要换成能解析该私有域的 DNS，或关闭本地 overlay；不要硬编码供应商 IP。

回退这项本机配置时，将 `docker-compose.dns.local.yml` 移到仓库外或重命名为不被脚本识别的备份；在无活动付费请求时，通过同一项目 Compose 重建 Web/Worker，核实 `HostConfig.Dns` 恢复为空。仅关闭 DNS overlay 不需要回退业务代码或删除数据卷。回退业务镜像时仍可保留该 DNS overlay，避免把已确认的网络问题一并带回。

### DNS 配置后的真实 Pro 结果

| 项目 | 微分方程 Pro | 二元一次方程 Pro |
|---|---|---|
| sessionId | cfd587e3-7c8a-48ea-89e2-818880505a5f | 9cdba668-8338-4351-bba5-498b1795965b |
| jobId | 0933935c-6b86-450c-9560-55d4cd60cbe5 | 08e90d70-7bb8-470a-80d1-9a0673092636 |
| stageId | d7e5ba60-5dc5-4c7f-8838-b8faee231467 | c5010852-1aea-4b33-bfc0-7308ccea3e6a |
| 结果 | succeeded，8/8 页 | succeeded，8/8 页 |
| 整课提交 | 1 次成功，0 次提交失败 | 1 次成功，0 次提交失败 |
| LLM / TTS 成功尝试 | 16 / 54 | 16 / 62 |
| 完整音频资产 | 54/54 | 62/62 |
| 音频真实总字节 | 23,124,024 | 20,785,944 |

实际查询已发布的 `document_scenes.data.actions`，而不是尚未附加 TTS 的中间 actions 检查点。两门课的音频引用、owner、非空字节、长度、SHA256、版本、attached 状态和 ID3 后首个 MPEG 帧头全部通过；没有用占位数据代替真实音频。课件内容非空，已提交角色音色均无损保留，lecture-style 结构约束仍存在。

以上结果发生在最后的提示对齐之前。微分方程的全会话工具错误为 0；二元一次方程有一次 `create_stage` 被既有新课程边界拦截，模型随后自行改用一次成功的 `submit_course_generation`。随后一门 3 页短课（job `fec7a071-c4e4-4e99-a143-32ee62a1f4c1`）也成功，6 次 LLM、24 次 TTS 及全部音频检查通过，但先后误调用 `create_stage` 和 `set_roster`。据此追溯并修正第一节记录的旧提示冲突。未放开同步整课创建路径、移除工具或修改 UI 来掩盖问题；最终提示版本的另两门真实短课结果单独记录。

独立 DNS 验收覆盖 180 秒的 3 轮：12 项内部解析、24 项外部 DNS/getaddrinfo、12 项无认证 HTTPS HEAD，48/48 全部通过。最长 DNS 约 2.48 秒、HEAD 约 7.67 秒，仍有网络延迟波动；该结果不保证未来网络或供应商永不故障。

脱敏详细证据位于 `.scratch/pro-repair-20260913/course-one-evidence.json`、`course-two-evidence.json`、`dns-acceptance.json`，前两者附有可重跑的只读 SQL。没有执行音频完整解码或浏览器播放验收。

### 普通模式回归与最终发布

中间版本 `5ad3e23af3308e4c` 的短课审计继续暴露参数反馈缺口，以下样本保留为修复依据：

- 微分方程 session `11d4a32b-deba-484a-9ecf-67a409860852`、job `db5e5439-2c85-4558-98d9-64783fbff225`：最终 4/4 页成功（提示要求 3 页），8 次 LLM、25 次 TTS 全成功，音频 11,850,324 字节且完整性异常为 0；但整课提交 5 次，前 4 次失败。依次为 description/brief 与 keyPoints/materialFacts 同时冲突、只修好前一组别名、遗漏 lecture-style 必需 quiz、修补时漏掉一页的 type/title/order。前两次只有泛化 INVALID_OUTLINE 提示，后两次是有效校验拦截。
- 二元一次方程 session `76fd0854-a51f-460b-92fa-6593f788e860`、job `8f201fac-b1bb-41a0-974b-39279bd9cabe`：3/3 页、一次提交、0 工具错误，6 次 LLM、28 次 TTS 全成功，音频 8,711,088 字节，完整性异常为 0。
- 证据：`course-prompt-diff-evidence.json/.sql`、`course-prompt-algebra-evidence.json/.sql`、`live-smoke-before-alias-diagnostics.json`，均在本轮 scratch 目录。没有用成功结局掩盖重复提交。

针对上述证据，进一步在 Pro 参数字段中说明规范名与兼容别名的关系；所有别名冲突一次返回准确页号/字段路径，继续拒绝内容冲突，不自动选一份丢弃另一份。提交说明明确每次重交完整页面对象；应用技能提示先读现有结构约束 JSON，讲授技能说明明确至少一个 quiz、slide 比例不少于 65%，3 页可用 2 slide + 1 quiz。不改变结构约束、普通 `validatePlan`、技能 reader 或读取覆盖/hash 机制。

普通模式任务 `5a0595dd-3d41-408b-9000-f68e5b574ca1`，stage `9805311e-b6a6-4097-96ba-e8198fcdae71`：sourceKind=home、agentsMode=generate、ttsEnabled=true；完整经过大纲及自动确认、角色、课件、动作、TTS 流程，最终 **succeeded，8/8 页，0 warning**。18 次 LLM、55 次 TTS 尝试全部成功。55 段 speech 对应 55 个独立真实音频资产，共 17,445,804 字节；引用、owner、实际字节长度、SHA256、版本、attached 与 MPEG 头检查均无异常。证据：`.scratch/pro-repair-20260913/course-normal-evidence.json`。

三门课程合计 **24 页、50 次成功 LLM、171 次成功 TTS**。此后追加本机 DNS 部署支持与 Pro 提示对齐，完成对应检查后重新构建，并在课程完成、无活动请求时更新最终容器；不在生成中途替换 Worker。

最终实际运行的共同源码指纹：`worktree-c8e289ef0510-a53e8b37ff72cd89`。

| 容器 | 最终实际 image ID | 健康状态 |
|---|---|---|
| zhiyu | sha256:303de442cb15e64019bda415741128fed4b30a47fada24cc46f5d0980bb063c3 | healthy |
| zhiyu-worker | sha256:5d393e06759136588dfa2343a6213a7c05cb5d967a843509eb58fe5bd3cb548d | healthy |

两容器运行环境变量的完整排序哈希与最初版本一致。数据卷、端口、数据库实例保持原样；Compose config-files 标签含本地 DNS overlay，HostConfig.Dns 均为已验证的两个地址。最终发布证据：`.scratch/pro-repair-20260913/final-containers.json`。最终构建的 Node 22 / TypeScript / Next 生产打包均成功。

如需回退业务镜像，先确认没有正在执行的课程/模型请求，再将前文两个 `before-pro-repair-20260913` 标签重新标为对应 latest，通过相同项目、环境文件及 DNS overlay 执行 `up -d --no-deps --no-build generation-worker` 后再更新 `openmaic`。不要使用当前源码指纹检查脚本直接启动旧镜像，不做 down migration 或删除卷；回退后核对旧 image ID、health 和 readiness。

## 最终镜像真实验收

以下使用实际运行的 `a53e8b37ff72cd89` 版本，复用相同正式 HTTP 接口与真实平台模型/语音配置，并新建测试会话。

| 项目 | 微分方程 Pro | 二元一次方程 Pro |
|---|---|---|
| sessionId | 36ccf6b9-dce8-453a-a10f-24f7e9e6a23d | 4550f72e-8145-4f34-a3f5-a266038842b6 |
| jobId | 1553a0a9-3fe3-48e6-8bee-5a9969c644fb | 9533d41c-b39e-4f71-a235-3a68d284372f |
| stageId | 3fa5ff42-1f23-417c-8214-bc8e6f3d3169 | 798077e0-7ef3-4877-805f-394df421b17c |
| 结果 | succeeded，3/3 页，0 warning | succeeded，3/3 页，0 warning |
| 整课提交 / 全部工具错误 | 1 次成功 / 0 | 1 次成功 / 0 |
| LLM / TTS 成功尝试 | 6 / 18 | 6 / 18 |
| 真实音频 / 字节 | 18 个 / 6,439,464 | 18 个 / 8,760,168 |

两课合计 **6/6 页、12 次成功 LLM、36 次成功 TTS、36 个完整真实音频资产，共 15,199,632 字节**。内容及动作非空，lecture-style 结构约束保留，显式音色身份保留。全部音频引用、owner、实际字节长度、SHA256、revision、attached 及首个 MPEG 帧检查通过。证据：`.scratch/pro-repair-20260913/course-alias-final-diff-evidence.json/.sql`、`course-alias-final-algebra-evidence.json/.sql` 及 `live-final-smoke.json`。

2026-09-13 19:32 北京时间收尾核验：Web/Worker 使用上表最终镜像并健康；readiness 四项为 true，pipelineVersion=2；活动课程、未删除活动 Pro 会话和有效供应商占用均为 0；UI 614 文件哈希无变化，`git diff --check` 通过。普通模式的最后一门 8 页真实回归发生在最终的 Pro 参数/技能文字补丁之前；该补丁没有改普通入口或共享正常生成逻辑。

这两次真实 Pro 调用消除了本轮验收中复现的重复拒绝链，但不构成模型未来永不犯错或供应商永不故障的保证。未知外部结果仍须保留原安全边界。浏览器插件受运行环境错误阻塞，未完成 Chrome/Edge 点击、视觉及音频播放验收；全量测试另有前述两个 HEAD 已有静态问题，不将其表述为全绿。
