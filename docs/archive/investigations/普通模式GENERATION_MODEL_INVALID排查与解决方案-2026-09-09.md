# 普通模式 GENERATION_MODEL_INVALID 排查与解决方案

日期：2026-09-09（本机时间）  
排查版本：`a29302aa22f248d0d3f4ab504fd75b157c62c0de`  
交付范围：排查与方案文档；本次未修改业务代码、未提交修复、未构建或更新 Docker。

## 1. 结论

已确认一个能够在当前生产容器上稳定复现截图错误的代码缺陷：**普通模式未填写模型 Base URL 时会发送空字符串，模型快照接口却把它当成非法 URL。**

**用户已确认模型 API Key 都已填写。本方案不把问题归因于漏填 Key，也不要求重新填写或更换 Key。** API Key 与 Base URL 是两个独立字段；有 Key、使用默认地址的正常配置也会触发本缺陷。诊断数据已包含非空占位 Key，报错仍发生在地址格式校验，而不是模型服务的密钥鉴权阶段。

客户端和后端对于“使用提供商默认地址”的表示不一致：

- 普通模式设置读取器返回 `baseUrl: ""`。
- 共用的模型连接规范化函数允许空字符串，并将它保留下来。
- 普通后台模型快照要求 `baseUrl` 为合法 URL，或完全省略该字段；空字符串不满足此规则。
- 因此 `/api/generate-classroom/model-snapshots` 返回 HTTP 400、`GENERATION_MODEL_INVALID`，课程任务尚未提交便停止。

这与上一轮的 `BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED` 是不同检查点。上次解决了搜索配置的前置拦截，本次暴露的是后续模型快照边界缺陷。它不是 Docker 未更新、worker 离线，也不能据此认定用户的 API Key 无效。

证据边界：本次没有读取用户浏览器内的真实配置或原始请求；已通过代码默认值、隔离复现和当前容器的同码响应确认缺陷。若用户实际请求中的 `baseUrl` 是非空合法 URL，应继续核对脱敏后的字段类型，不能把所有同码错误都归于空地址。

## 2. 已验证的证据

### 2.1 当前部署确实是上一轮的新版本

| 检查项 | 本次只读检查结果 |
| --- | --- |
| Web / worker revision | 均为 `a29302aa22f248d0d3f4ab504fd75b157c62c0de` |
| Web | running |
| worker | running、healthy |
| `/api/health/ready` | database / schema / worker / accepting 均为 true |
| Web 镜像 ID | `sha256:14b71df40405d014ba8ff228b27600eb78b4e28515a32f12003a43b92d9714e9` |
| worker 镜像 ID | `sha256:3ee42fd2b08d47b3927419d5a58824128f72b2304fd8830dd094539119150c2a` |

### 2.2 当前容器可以直接复现

向 `http://127.0.0.1:3000/api/generate-classroom/model-snapshots` 提交以下诊断数据，并携带同源 Origin：

```json
{
  "providerId": "openai",
  "modelId": "gpt-4.1",
  "modelString": "openai:gpt-4.1",
  "apiKey": "diagnostic-placeholder",
  "baseUrl": ""
}
```

实际响应：

```json
{
  "success": false,
  "errorCode": "GENERATION_MODEL_INVALID",
  "error": "GENERATION_MODEL_INVALID"
}
```

HTTP 状态为 **400**。这里使用的是虚拟密钥，错误发生在快照内容校验阶段，没有调用外部模型、创建课程任务或成功保存模型快照。

### 2.3 单变量对照

使用现有真实规范化函数和快照校验函数做隔离诊断，只替换服务端是否托管该 provider 的判断，不连接数据库。

| 输入 | 结果 |
| --- | --- |
| 普通设置形状，`baseUrl: ""` → normalize → snapshot | 抛出 `GENERATION_MODEL_INVALID` |
| 同样字段，仅省略 `baseUrl` → normalize → snapshot | 通过 |
| 非空合法 URL → snapshot | 通过 |
| 空字符串 / 纯空白 → snapshot | 均抛出相同错误 |

诊断运行结果为 **1 个预期功能断言失败、3 个对照断言通过**。红测试明确要求“未填写可选地址也应可用”，目前仍失败；本次未应用修复。

复现文件保存在临时诊断目录：

- [诊断测试](D:/ZZGG_Innovation_Project/OpenMAIC-main/.scratch/model-invalid-diagnostic.test.ts)
- [诊断配置](D:/ZZGG_Innovation_Project/OpenMAIC-main/.scratch/model-invalid-diagnostic.config.ts)

复现命令（在项目目录执行）：

```powershell
& 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  node_modules/vitest/vitest.mjs run `
  --config .scratch/model-invalid-diagnostic.config.ts `
  .scratch/model-invalid-diagnostic.test.ts
```

## 3. 故障链与上次验收遗漏

| 环节 | 代码与具体行为 |
| --- | --- |
| 读取普通模式设置 | [model-config.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/lib/utils/model-config.ts:31)：`baseUrl: providerConfig?.baseUrl || ''` |
| 构造后台输入 | [session-input.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/lib/generation/session-input.ts:70)：有客户端 key 或地址时同步模型快照 |
| 发送请求 | [model-snapshot-client.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/lib/generation/model-snapshot-client.ts:15)：直接序列化整个 context，空字符串不会被 JSON 序列化省略 |
| 模型规范化 | [model-connections.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/lib/server/agent-runtime/model-connections.ts:30)：地址是可选字符串；空值绕过非空 URL 检查，并被返回 |
| 快照校验 | [generation-model-snapshots.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/lib/server/generation-model-snapshots.ts:34)：`.url().optional()` 不接受空字符串 |
| 错误返回 | [model-snapshots/route.ts](D:/ZZGG_Innovation_Project/OpenMAIC-main/app/api/generate-classroom/model-snapshots/route.ts:25)：内容校验失败被转换为截图中的错误码 |

`.optional()` 表示可以省略字段或传入 `undefined`，并不表示 `""` 是合法 URL。设置 getter 返回的额外字段会在规范化时被过滤；本次对照已排除“仅因附带 providerId/modelId 就失败”的解释。

上次 173 项定向测试、6 项浏览器测试通过，但没有充分验证真实用户配置经过整个接口边界：

1. [普通提交浏览器测试](D:/ZZGG_Innovation_Project/OpenMAIC-main/e2e/tests/background-search-submission.spec.ts:91) 将模型快照接口直接模拟为成功，因此真实服务端 URL 校验没有执行。
2. [普通输入单元测试](D:/ZZGG_Innovation_Project/OpenMAIC-main/tests/generation-preview/background-session-input.test.ts:203) 虽然传了空地址，也使用模拟接口返回引用。
3. [真实容器检查脚本](D:/ZZGG_Innovation_Project/OpenMAIC-main/.scratch/normal-search-release-smoke.mjs:29) 手工构造的模型请求省略了 `baseUrl`，恰好绕过了缺陷。
4. [模型快照存储测试](D:/ZZGG_Innovation_Project/OpenMAIC-main/tests/server/generation-model-snapshots.test.ts:23) 使用合法 URL，主要验证加密和生命周期，没有覆盖普通设置的默认空值。

**上次把这些分段验证当作用户实际生成链路已经足够可靠的依据，结论过早。** 后续验收必须让真实客户端默认字段经过真实模型快照接口，不能继续只模拟这个关键边界。

## 4. 推荐的最小修复方案

### 4.1 首选：在普通模型快照 API 边界省略空地址

只调整 [普通模型快照路由](D:/ZZGG_Innovation_Project/OpenMAIC-main/app/api/generate-classroom/model-snapshots/route.ts)，在现有 `normalizeModelConnectionContext` 之后、`generationModelSnapshotContent` 之前，将空白地址转换为“没有这个字段”。

建议替换片段如下，**仅为方案，本次没有写入业务文件**：

```ts
const normalized = await normalizeModelConnectionContext(await readGenerationJson(req));
const { baseUrl, ...modelContext } = normalized;
const endpoint = baseUrl?.trim();

const ref = await syncGenerationModelSnapshot(
  ownerId,
  generationModelSnapshotContent({
    ...modelContext,
    ...(endpoint ? { baseUrl: endpoint } : {}),
  }),
);
```

选择这里修复的原因：

- 已打开的旧浏览器页面仍可能发送空字符串，服务端修复可以接住这些请求。
- 保留现有规范化、服务器配置优先级和非空地址安全校验。
- 保留快照 schema 的严格 URL 规则，使新快照只保存合法 URL 或省略地址。
- 不修改共用设置 getter、Pro 模型连接 API、Pro runner、模型路由或媒体链路。
- 不需要修改数据库结构、schema version、加密密钥或配置文件。

不能把 `.url()` 删除，不能允许任意字符串长期存入快照，也不能把所有模型校验失败都吞掉后改用其他模型。

注意：共用 `generationModelSnapshotContent` 也被 Pro runner 使用。为了保护已可用的 Pro，本轮首选修复普通 API 局部边界；若以后要统一所有调用者的空值语义，应单独评审并补齐 Pro 回归。

### 4.2 客户端规范化可作为后续增强

可以后续让普通模型快照客户端只发送允许的配置字段，并省略空地址，但不能只修客户端。也不建议为此修改整个项目共用的 `getCurrentModelConfig()` 返回契约。

临时操作层面的绕行是填写当前提供商实际使用的正确 Base URL；不能统一填写 OpenAI 地址，也不应要求用户靠这一操作作为最终修复。单纯刷新或清空缓存不会改变 getter 生成空字符串的行为。

## 5. 必须补充的验证与发布步骤

### 5.1 验收矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 有效模型配置、地址省略 | 模型快照 API 返回 201 和引用 |
| 同配置、地址为空字符串 | 与省略地址同义，返回 201；保存内容中省略地址 |
| 同配置、地址为纯空白 | 与省略地址同义，返回 201 |
| 合法自定义地址 | 继续使用该地址，不改写为默认地址 |
| 非空非法或被禁止的地址 | 仍拒绝，不转换为默认地址 |
| 服务端托管 provider + 陈旧客户端地址 | 保持服务器配置优先 |
| 普通模式联网 / 不联网 | 都能通过真实模型快照接口并提交后台任务 |
| Pro 原有成功配置与媒体生成 | 行为保持一致，相关回归通过 |

应在正式测试目录补普通模型快照 **route 级集成测试**，调用真实规范化和内容校验函数，用隔离存储代替生产库。只模拟数据库或外部模型，不模拟被测的模型快照响应。临时红测试的断言也要随修复位置调整：局部 route 修复后，直接向严格快照工厂传空字符串仍应被拒绝。

浏览器测试必须至少保留一次完整的真实路径：设置 store → 普通输入构造 → HTTP 模型快照接口 → 服务端规范化 / 加密存储 → 后台任务接受。使用隔离数据库和受控模型响应避免污染用户课程，但不要将 `/model-snapshots` 固定返回成功。

### 5.2 最终业务验收

经过上述无付费回归后，在明确授权的测试配置下，用“我要学习布迪厄的思想”执行一门最小普通课程，检查：

1. 模型快照返回 201，后台任务提交返回 202。
2. worker 真正经过研究、大纲、角色、页面和动作阶段。
3. 进入课堂，生成结果可读取，任务最终状态为 succeeded。
4. 普通模式不联网场景也通过；Pro 现有配置仍能完成原有流程。

只有这些证据齐备，才可宣称对应配置下整门课程生成恢复。仅页面不报错、预检通过或健康检查通过都不等于完整生成成功。

### 5.3 未来实施时的 Docker 发布

本次没有执行以下步骤。未来实现并通过检查后，再固定提交并重建 Web / worker 镜像，沿用原有 Compose 与数据卷，核对两个容器的 revision 一致。

本方案不增加数据库版本，现有 schema 4 不应再次升级。可沿用现有发布脚本的迁移检查；迁移应为幂等空操作。随后检查 readiness，并在新镜像上重跑真实模型快照接口和浏览器默认空地址场景。

不删除课程数据、不清空用户设置、不重置数据库、不调整 Pro 协议或模型选择。

## 6. 本次实际完成范围

- 完成截图错误定位、真实容器失败复现和单变量对照。
- 核对现有 Docker 版本与健康状态，梳理上次测试覆盖缺口。
- 新增本 Markdown 和临时诊断文件；业务代码与正式测试文件未修改。
- 未实施方案、未更新 Docker、未触发真实付费生成；目前报错仍需按本方案修复。
