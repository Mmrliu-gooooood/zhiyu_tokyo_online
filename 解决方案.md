# MiniMax 测试成功但课程无声、声音按钮不可点击：排查与修改方案

排查日期：2026-09-08。基于当前工作区代码（包含已有未提交修改）。本次只输出方案，不修改业务代码。

## 1. 结论与证据边界

发现以下问题；前两项解释声音按钮和历史课程行为，第三项影响新课程，第四项解释部分“测试成功”为何不可靠：

1. **API 配置、提供商启用、课程语音总开关是不同状态。** 配置并选择 MiniMax 不会把 `ttsEnabled` 从默认的 `false` 改为 `true`。总开关关闭时，截图中的声音按钮会被直接禁用。这是与截图高度吻合的直接原因。
2. **旧课程不会因添加 API 自动获得配音。** MiniMax 播放路径依赖已经生成的音频；没有音频时播放器按文字阅读时长推进，不会实时请求 MiniMax 补配音。
3. **Pro/后台配置传递存在缺口。** 当前媒体快照只收集 `custom-tts-*`，内置 MiniMax 的 ID 是 `minimax-tts`。即使打开总开关，用户在设置中填写的内置 MiniMax 密钥也不会通过这个快照进入服务端 Pro 会话。若服务端没有另行配置 TTS，合成器可以返回“不可用”，而讲稿仍生成成功。
4. **MiniMax 图像、视频连接测试存在假成功；部分其他提供商也有类似误报。** MiniMax 两个检测函数只看 `response.ok`，不检查业务错误码或实际结果；公共 `probeAuth` 甚至把 HTTP 429、503 判为成功。已用模拟响应复现，详见第 9 节。语音试听走另一条实现，不能把这个缺陷直接套到语音试听上。

第 1 项状态变化和第 3 项快照遗漏已通过本地无网络测试验证；第 2 项由播放器分支及补配音代码确认。没有读取用户实际浏览器设置、目标课程数据或部署日志，因此不能断言这门课程究竟命中了哪些分支，也不能仅凭截图断言 MiniMax 接口故障。若实际运行版本与工作区不同，需要按下方检查步骤核对。

特别注意：`ttsEnabled=false` 直接解释按钮禁用，但播放器仍会尝试播放已有音频。因此不能笼统写成“总开关关闭必然让所有已有配音静音”；还要检查课程是否缺少音频、是否静音或音量为零。

**其他提供商也受影响，但有条件。** 快照遗漏覆盖全部 9 个内置服务端 TTS、8 个内置图像、6 个内置视频提供商；不是说这些 API 本身全部失效。受影响的是“用户只在浏览器设置里填凭据，却由 Pro/后台执行生成”的场景。服务端已配置、前台直接调用、自定义提供商、浏览器原生语音，需要分别判断，见第 8 节。

## 2. 代码依据

| 环节 | 文件与定位 | 当前行为 |
| --- | --- | --- |
| 总开关默认值 | `lib/store/settings.ts:1034` | `ttsEnabled: false` |
| 选择提供商 | `lib/store/settings.ts:1140`，`setTTSProvider` | 更新提供商及音色，不启用总开关 |
| 保存 API / 提供商启用 | `lib/store/settings.ts:1206`，`setTTSProviderConfig` | 更新提供商配置，不启用总开关 |
| 设置页试听 | `components/settings/tts-settings.tsx:170`，`handleTestTTS` | 独立调用试听，成功只更新测试提示 |
| 试听请求 | `lib/audio/use-tts-preview.ts`，`startPreview` | 向 `/api/generate/tts` 直接传入用户密钥，读取音频并调用 `audio.play()` |
| 按钮禁用 | `components/canvas/canvas-toolbar.tsx:207` | `disabled={!ttsEnabled}`，同时显示灰色静音图标 |
| 按钮上层状态 | `components/edit/PlaybackChromeRoot.tsx:308`、`:1678`、`:2164` | 读取全局总开关；关闭时静音切换回调也不执行 |
| 总开关现有入口 | `components/generation/media-popover.tsx:340` | “语音合成”面板调用 `setTTSEnabled` |
| 播放缺音频降级 | `lib/playback/engine.ts:627` 附近 | 优先已有音频；只有选中并启用浏览器 TTS 时才现场朗读，否则走阅读计时 |
| Pro 快照过滤 | `lib/workbench/media-config-snapshot-client.ts:47` 附近 | `addTts` 忽略所有非 `custom-tts-*` 的提供商 |
| 快照服务端校验 | `lib/server/media-config-snapshots.ts:72` 附近 | TTS schema 也只接受 `custom-tts-*` 和 `openai-speech` |
| Pro 会话提交 | `lib/workbench/session-store.ts:1958`、`:2105` 附近 | 同步媒体快照并传 `mediaConfigRef`；内置 MiniMax 本地设置未被该机制携带 |
| 服务端旁白 | `lib/server/agent-runtime/scene-tts.ts:62` | 无快照 TTS 时从服务端提供商列表选择；无可用提供商或密钥时返回 `available:false` |
| 讲稿生成后的配音 | `lib/server/agent-runtime/generation-tools.ts:465` 附近 | 讲稿先持久化，再尝试合成；音频不可用不等于讲稿生成失败 |
| 编辑器补配音 | `components/edit/ActionsBar/ActionsBar.tsx:1047`、`:1099`、`:1228` | 开启非浏览器 TTS 后显示配音操作；“全部配音”只遍历当前场景 |

语音测试成功不是单纯的网络探测：正常路径确实拿到了音频并尝试开始播放。但它没有验证课程总开关、后台任务凭据、目标课程音频持久化或完整播放链路；也不是整段音频播放完成的保证。视频、图像测试通过不能证明课程旁白已生成。

`components/audio/tts-config-popover.tsx` 虽有开关组件，但搜索未发现业务页面引用，不能把它当作用户当前可见入口。实际使用的是生成工具栏中的 `MediaPopover`。

## 3. 修改前可尝试的恢复步骤

1. 在设置的语音合成部分选中 MiniMax，确认该提供商已启用，并实际听到试听音频。
2. 回到课程生成入口，在生成工具栏的媒体面板中打开“语音合成”总开关。它不是 API 设置中的提供商启用开关。
3. 回到课程，检查声音按钮是否恢复可点击；取消静音并调高音量。
4. 对已经没有音频的课程，点击截图右侧铅笔进入编辑，在讲稿/动作时间线中用单条重新生成或“全部配音”。**“全部配音”目前仅处理当前页/场景，整门课程需逐页处理。** 必须有非空讲稿，且总开关已打开、选中 API TTS。
5. 先对一条讲稿补配音并试听，成功后再扩大到多页；重新打开课程确认音频仍能播放。

开关恢复后，新建 Pro 课程仍可能命中凭据传递缺口，不能保证仅打开开关就解决所有新课程问题。

部署管理员的临时替代方式：当前服务端提供商映射支持 `TTS_MINIMAX_API_KEY`（`lib/server/provider-config.ts` 中 `TTS_MINIMAX` 映射到 `minimax-tts`）。若采用服务端配置，应在真正执行合成的 Web/Worker 进程中注入并重启对应服务，再核对选择的模型和音色。它属于部署级配置，不会自动补齐历史课程，也不能替代最终的用户配置传递修复。不要把实际密钥写进本文件、源码或日志。

## 4. 下一对话的代码修改任务

### A. 让语音状态与入口清晰可见（优先）

- 在语音设置页直接展示“课程语音合成”总开关，以及提供商是否可用；保留提供商启用和总开关的区别。
- 试听成功后若总开关仍关闭，提示“试听成功，课程语音合成尚未开启”，提供明确的启用按钮。不要仅因测试成功就在后台偷偷开启付费合成。
- 截图中的按钮在语音未启用时，应允许打开配置或显示可操作的启用入口，而不是只有一个无法点击的灰图标。
- 音量/静音操作依据实际播放能力设计；已有音频应能够控制音量，不能仅被生成开关禁用。同步检查 `PlaybackChromeRoot` 的回调守卫，避免只改按钮样式。
- 显示“语音未开启”“尚未生成配音”“配音失败”“静音”等不同状态，不能全部表现成同一个静音图标。
- 总开关关闭时仍尊重用户关闭意图；不要每次保存 API 或刷新服务端配置都强行开启。

### B. 补齐内置 MiniMax 本地配置到服务端的传递（优先）

沿现有受所有者约束的加密媒体快照机制修复，不另建明文密钥通道：

1. 扩展 `buildMediaConfigSnapshot`：能收集所选内置 API TTS 的用户配置，以及教师/角色音色覆盖配置。浏览器 TTS 不上传凭据。
2. 扩展服务端快照 schema 和相关类型，以明确的分支区分“内置提供商”与“自定义 OpenAI speech 协议”。**不能仅删除前缀判断**，否则服务端校验仍会拒绝。
3. MiniMax 内置配置继续走现有 MiniMax 原生适配器；不要伪装成 `custom-tts-*`，也不要强制按 OpenAI `/audio/speech` 协议请求。
4. 更新 Pro 会话消费、旁白合成与声音目录/教师声音绑定，使其使用同一份当前会话配置。避免用户已选 MiniMax，服务端却静默选第一个其他提供商。
5. 显式传递启用意图，区分“用户关闭”“没有客户端配置，允许既有服务端默认策略”“用户明确指定提供商”。当前缺少快照不代表用户允许服务端任意生成。
6. 同时修复普通后台生成：`lib/generation/session-input.ts`、`lib/server/generation-jobs/preflight.ts`、`lib/server/generation-pipeline/media.ts`。`buildGenerationJobInput` 当前会主动拒绝内置提供商的客户端 key/base URL，抛出 `BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED`（422），并非一定生成一门无声课程。应在安全快照通路完备后放行受支持的内置媒体配置，保留对其他未支持配置的检查；预检和执行器也要能消费内置快照，不能只移除前端拒绝逻辑。
7. 保留快照加密、所有者权限、版本引用及服务端禁用限制，明确用户配置和部署配置的优先级。后台日志和错误不得包含密钥。
8. 同步支持第 8 节列出的内置图像、视频提供商；扩展对应 schema、预检和 Pro `generate_image` / `generate_video` 消费路径。当前这些类型也只允许 `custom-*`。对于服务端托管提供商，保留现有管理员配置优先级；用户选择的提供商不可用时明确报错，不要静默使用另一个提供商。
9. 语音快照应包含合成确实需要的提供商专用选项，尤其 VoxCPM 的 backend / 音色配置等，并与当前严格 schema 对齐。当前收集器没有携带 `providerOptions`，不能因为 MiniMax 只需基本字段就遗漏其他提供商的参数。凭据到达 Worker 不代表本地服务地址可从 Worker 访问；内置本地服务的地址策略要单独保留和验证。

### C. 完善旧课程补配音和失败反馈

- 复用 `lib/audio/regenerate-speech-tts.ts` 与现有编辑器提交/持久化路径，实现整门课程“补齐缺失配音”。保留单条和当前页操作。
- 默认只补缺失音频；全部重生成作为独立操作，明确范围及可能产生的 API 用量。
- 显示总数、成功数、失败数，支持失败重试。当前页批量操作有捕获后继续的行为，不能让失败无提示。
- 持久化时保留当前项目音频资产引用体系，验证重新打开、服务端加载及导出。不要为解决无声而绕过资产池，永久保存临时 Blob URL。
- 用户要求生成语音但服务端返回 `available:false` 或存在 `failed` 时，应显示明确的配音未完成状态；保留已成功生成的讲稿。
- 播放缺音频时显示补配音入口。若未来增加实时 MiniMax 合成，应另行设计缓存、取消和付费触发，不能在每次播放时无提示重复请求。

## 5. 已执行验证与复现方式

使用内存设置、占位密钥，无 MiniMax 网络请求，没有读取或改写用户浏览器配置。

临时测试的关键步骤如下，可在下一对话复建为正式回归测试：

```ts
useSettingsStore.getState().setTTSEnabled(false);
useSettingsStore.getState().setTTSProviderConfig('minimax-tts', {
  apiKey: 'diagnostic-placeholder', enabled: true,
});
useSettingsStore.getState().setTTSProvider('minimax-tts');
expect(useSettingsStore.getState().ttsEnabled).toBe(false); // 通过：配置不会启用总开关

useSettingsStore.getState().setTTSEnabled(true);
const snapshot = buildMediaConfigSnapshot(useSettingsStore.getState());
expect(snapshot?.tts?.some(x => x.providerId === 'minimax-tts')).toBe(true);
// 当前失败：收到 undefined，证明内置 MiniMax 未进入快照
```

本轮在上述思路上扩展了提供商矩阵与连接测试复现，实际执行如下（2026-09-08 18:54–18:57，Asia/Shanghai）：

| 验证组 | 结果 | 证明什么 |
| --- | --- | --- |
| 临时设置/快照测试 5 项 + 现有旁白、补配音、后台输入、MiniMax TTS 模型、MiniMax 视频测试 | 23 通过、2 个预期失败 | 保存并选择全部 10 个内置 TTS 不打开总开关；9 个 API TTS、8 个图像、6 个视频被快照遗漏；自定义三类配置对照通过；内置 MiniMax 也被服务端 schema 拒绝 |
| 临时连接测试 4 项 + 现有 `probe-auth.test.ts` | 19 通过、3 个预期失败 | MiniMax 图像/视频接受 HTTP 200 的业务失败；公共探测器接受 429/503；另外 5 个独立探测器拒绝 503 |
| 临时普通后台输入矩阵 1 项，内部覆盖 23 个内置媒体提供商 | 1 通过 | 23 个客户端媒体配置均在任何网络访问前被明确拒绝，错误码为 `BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED` |

合计 **9 个测试文件、48 项测试：43 通过、5 个用于复现缺陷的预期失败**。没有尝试把失败改绿，因为本次任务仅输出方案。3 个临时诊断文件已删除，本次仅保留文档修改。测试使用内存状态与占位密钥；持久化未水合保护阻止了设置落盘，没有修改实际浏览器配置。现有测试通过不代表真实课程端到端已验证。

本轮直接用现有本地 Vitest 和 Codex 自带 Node 执行，没有安装或升级依赖。下一对话可使用以下基础检查命令，新增回归测试后追加其文件名：

```powershell
& 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/vitest/vitest.mjs run tests/agent-runtime/scene-tts.test.ts tests/audio/regenerate-speech-tts.test.ts tests/generation-preview/background-session-input.test.ts tests/audio/minimax-tts-models.test.ts tests/media/minimax-video-provider.test.ts tests/media/probe-auth.test.ts
```

## 6. 修改验收清单

1. 全新设置 → 填入内置 MiniMax → 试听成功但未开启总开关：界面明确提示，课程声音入口可以引导启用。
2. 开启总开关，仅浏览器中有 MiniMax 密钥、服务端无 MiniMax 环境配置：Pro 新课程能生成并持久化可播放的旁白；普通后台生成也通过对应验证。
3. 旧课程有讲稿无音频：只添加密钥不会虚假显示已配音；补配音后能试听、刷新后能播放。
4. 已有有效音频但生成总开关关闭：仍有可用的音量/静音控制，不因生成配置被锁死。
5. 教师音色覆盖、模型与所选提供商一致；不会静默换成另一个付费提供商。
6. 无密钥、无效密钥、服务端禁用、上游合成失败、音频资源缺失均有清晰提示；批量失败可重试。
7. 用浏览器真实验收：设置试听 → 新课程生成 → 查看音频状态 → 播放 → 刷新再播放，以及旧课程补配音链路。检查请求和数据时仅记录是否有密钥、提供商 ID、音频存在性和错误码，禁止输出密钥值。
8. 全部内置媒体提供商的快照矩阵通过；普通后台与 Pro 各有集成测试覆盖。图像/视频测试通过不能被解释为讲稿已配音。
9. MiniMax HTTP 200 + 非零业务码、缺失图像/任务 ID、无效 JSON、429、5xx 不再显示生成成功；自定义媒体保留“仅配置检查”的现有提示。公共探测器区分鉴权探测和可生成状态。

## 7. 交给下一对话的执行要求

以本文件为排查依据，在当前工作区已有修改上实施，不回退或覆盖其他未提交工作。先补自动化回归，再实施 A、B 及第 9 节连接测试修复，最后完成 C 和真实浏览器验收。第 8 节的完整提供商矩阵属于本次范围，不能只硬编码修复 MiniMax。先核对实际部署版本、总开关状态以及目标课程是否有音频；把已验证的代码缺陷与现场状态分别记录。不要把“测试连接成功”当作课程配音链路已通过。

## 8. 其他 API 的同类问题检查结果

### 8.1 语音提供商矩阵

下表“快照遗漏”指已开启总开关、仅浏览器有配置、准备交给 Pro/后台执行的情况；当前服务端快照 schema 同样不接受这些内置 ID。

| 提供商 | 内置 ID | 配置/选择后自动打开总开关 | 本地配置被快照遗漏 | 无音频的旧课程自动补配音 |
| --- | --- | --- | --- | --- |
| MiniMax | `minimax-tts` | 否 | 是 | 否 |
| OpenAI | `openai-tts` | 否 | 是 | 否 |
| Azure | `azure-tts` | 否 | 是 | 否 |
| 智谱 GLM | `glm-tts` | 否 | 是 | 否 |
| 通义 Qwen | `qwen-tts` | 否 | 是 | 否 |
| 豆包 | `doubao-tts` | 否 | 是 | 否 |
| ElevenLabs | `elevenlabs-tts` | 否 | 是 | 否 |
| VoxCPM | `voxcpm-tts` | 否 | 是（含本地地址） | 否 |
| Lemonade | `lemonade-tts` | 否 | 是（含本地地址） | 否 |
| 浏览器原生语音 | `browser-native-tts` | 否 | 不适用；应在浏览器执行 | 开启并选中后可即时朗读，有讲稿即可；不生成持久化配音文件 |
| 自定义 OpenAI Speech | `custom-tts-*` | 不应依赖保存 API 自动开启 | 已有快照通路，对照测试通过 | 否，仍需补配音 |

VoxCPM、Lemonade 不一定需要 API key，但显式配置的地址、模型及专用参数依然需要传给实际执行进程。浏览器原生语音还需要可用的浏览器声音与播放环境。本表是项目状态与配置链路检查，不是逐一调用供应商真实服务的可用性报告。

### 8.2 图像和视频

- 内置图像：`seedream`、`openai-image`、`qwen-image`、`nano-banana`、`minimax-image`、`grok-image`、`comfyui-image`、`lemonade`，共 8 个，本地配置全部被快照过滤。
- 内置视频：`seedance`、`kling`、`veo`、`minimax-video`、`grok-video`、`happyhorse`，共 6 个，情况相同。
- 自定义图像 `custom-image-*`、视频 `custom-video-*`：已有快照支持。配置完整时的对照测试通过，但还需服务端加密配置可用、协议匹配、地址可访问等运行条件。
- 图像、视频和 TTS 是三个独立生成能力。图像/视频 API 有效不会给课程讲稿自动加上旁白，播放器音量按钮由 TTS 状态控制。

### 8.3 按生成路径判断影响

| 执行路径 | 浏览器中的内置 API 配置如何处理 | 典型表现 / 检查点 |
| --- | --- | --- |
| 设置页语音试听 | `use-tts-preview.ts` 直接向 `/api/generate/tts` 传参 | 可以试听成功，但未验证课程总开关与后台配置 |
| 前台普通生成、编辑器补配音 | `generateAndStoreTTS` 直接发送 `ttsApiKey` / `ttsBaseUrl` 等 | 不受媒体快照过滤影响；仍需检查开关、提供商启用、教师音色绑定、合成失败及资产保存 |
| 普通后台生成 | `session-input.ts` 对内置媒体客户端配置调用 `rejectClientProvider` | 开启相应能力后会报 422；控制器提交失败后返回，不应描述为必然自动退回前台或静默生成无声课程 |
| Pro 会话 | `session-store.ts` 同步媒体快照；内置 ID 被过滤 | `course-tools.ts:264` 仅在存在 `mediaConfig.tts` 时注入合成配置，否则沿用服务端选择；无服务端 TTS 时 `available:false`，讲稿可继续保存 |
| 服务端已托管提供商 | 使用服务端凭据 / 默认配置 | 可正常生成，不会因客户端未上传 key 必然失效；但用户全局选择与服务器默认选择可能不同 |

Pro 图像/视频的对应证据：`lib/server/agent-runtime/generate-image.ts:240`、`:268` 和 `generate-video.ts:248`、`:298` 从 `deps.mediaConfig` 或服务端目录选择；没有快照就不能使用只留在浏览器设置中的内置 key。

补充：已有课程的教师 `voiceConfig` 可能优先于全局音色（`lib/hooks/use-scene-generator.ts:282` 附近）。因此仅切换全局 MiniMax 不保证旧课程补配音一定用它。补配音入口应展示最终解析的提供商/模型/音色，并提供明确的更新课程旁白声音操作；不要无条件删除角色绑定。

ASR（语音识别）和 LLM 的边界：ASR 负责“声音转文字”，不会给课程发声；`lib/hooks/use-audio-recorder.ts:46` 起直接把用户配置随录音上传到 `/api/transcription`，未经过上述媒体快照过滤。Pro LLM 已有独立 model connection 通路（`lib/workbench/pro-model-connection-client.ts`），不能把媒体问题推断为所有 LLM API 都坏了。本轮没有对所有 LLM、ASR、搜索、PDF 服务做真实网络联调。

## 9. 连接测试的额外缺陷与修复要求

### 9.1 MiniMax 图像 / 视频：HTTP 成功被当作业务成功

确定的代码位置：

- `lib/media/adapters/minimax-image-adapter.ts:88`，`testMiniMaxImageConnectivity`：HTTP 2xx 直接返回成功，不解析 `base_resp.status_code` 或图像结果。
- `lib/media/adapters/minimax-video-adapter.ts:207`，`testMiniMaxVideoConnectivity`：同样只看 HTTP 2xx。注释说检查 `task_id`，实际没有检查，更没有验证任务最终生成成功。

已复现：把 fetch 模拟为 HTTP 200，内容为 `{"base_resp":{"status_code":1004,"status_msg":"diagnostic auth failure"}}`，两个函数都返回 `success:true`。这是合成测试输入，不是读取到的用户实际错误。

官方响应结构分别包含图像结果与 `base_resp`，或者任务 ID 与 `base_resp`；视频任务提交后还需查询最终状态。这支持“HTTP 成功不足以证明生成成功”的判断。[MiniMax 文生图文档](https://platform.minimaxi.com/docs/api-reference/image-generation-t2i)、[文生视频文档](https://platform.minimaxi.com/docs/api-reference/video-generation-t2v)、[任务状态查询](https://platform.minimaxi.com/docs/api-reference/video-generation-query)（核对日期：2026-09-08）。

修复要求：

1. 校验 HTTP、JSON 结构、业务错误码及必要结果字段。非零业务码、缺少必要字段、无效 JSON 不得显示成功。
2. 测试请求应使用用户选择的模型；当前图像固定 `image-01`，视频固定 `MiniMax-Hailuo-2.3`，无法证明其他所选模型可用。
3. 明确测试层级：“配置完整”“鉴权探测通过”“任务已受理”“已生成可播放/可查看样本”。视频有 `task_id` 最多证明任务受理。
4. 两个 MiniMax 测试当前实际 POST 到生成端点，携带可生成的 prompt，会提交真实生成请求，可能产生用量；路由注释称“无生成的轻量检测”与实现不一致。若提供真实生成测试，应明确展示操作含义与生成结果；不要把它当作免费的只读连通探测。
5. 给实际 fetch 加 AbortSignal 超时；图像路由 `maxDuration` 不能代替适配器主动取消。测试失败时显示经过脱敏的业务错误码和可操作提示。

### 9.2 七个提供商共用 `probeAuth`，把 429 / 5xx 标为成功

`lib/media/probe-auth.ts:11` 仅拒绝 3xx、401、403 和网络异常，其他状态都返回 `success:true`。HTTP 429、503 已复现。调用方：

| 类型 | 受影响提供商 |
| --- | --- |
| 图像 | Seedream、Qwen Image、Grok Image |
| 视频 | Seedance、Kling、Grok Video、HappyHorse |

该函数原本试图用故意不完整的请求探测鉴权，部分 400/404 可能是预期结果，不能机械地要求一律 200。但“没有得到 401/403”也不能证明 key 有效或可生成。当前 UI 将这些响应统一显示为连接成功，结论过强。

修复时按提供商定义预期探测响应和可验证的业务码；429 显示限流、5xx 显示上游暂不可用，不能报绿色成功。保留需要的预期 400/404 语义，但不能把任意网关返回的 404 当作鉴权证据。更新 `tests/media/probe-auth.test.ts`：它现在明确断言 429/500 是成功，现有测试全绿并不能覆盖修复后的产品要求。

对照检查：OpenAI Image、Nano Banana、Lemonade Image、ComfyUI Image、Veo 的独立检测函数在模拟 503 下均返回失败，没有相同的“任意非鉴权错误都成功”分支。不过模型目录或服务健康检测通过，依然不代表完整生成链路通过。自定义图像/视频路由当前返回 `verification:'configuration'`，设置页已显示配置检查提示，应保留该区分。

### 9.3 下一对话最小回归场景

除第 5 节的快照测试外，新增如下断言（fetch 必须模拟，不能使用真实 key）：

```ts
// 对应 MiniMax Image、Video 的两个测试各执行一次。
vi.stubGlobal('fetch', vi.fn(async () => Response.json({
  base_resp: { status_code: 1004, status_msg: 'diagnostic failure' },
})));
expect((await testImageConnectivity({
  providerId: 'minimax-image', apiKey: 'diagnostic-placeholder',
})).success).toBe(false); // 当前失败：true

expect((await probeAuth({
  providerName: 'diagnostic',
  request: async () => new Response('unavailable', { status: 503 }),
})).success).toBe(false); // 当前失败：true
```

同时覆盖真实结构的成功响应、任务受理但未完成、200 业务失败、空结果、无效 JSON、401/403、429、5xx、超时，以及各供应商允许的预期探测响应。最终 UI 不得把“配置检查通过”与“课程配音已可播放”混为一谈。

## 10. 2026-09-08 实施、数据核对与部署结果

### 10.1 实际课程与音频核对

本轮只读核对了当前 PostgreSQL 中的 4 门有效课程；未读取或修改浏览器 UI 设置，也未触发任何付费音频生成。

| 课程 | 页面 | speech 动作 | 已有音频引用 | 教师/角色绑定 |
| --- | ---: | ---: | ---: | --- |
| 《布迪厄思想入门》（`OSFgmow52w`） | 5 | 28 | 0 | 5/5 绑定 `minimax-tts`，未持久化模型 ID |
| 《精英的傲慢：优绩主义批判》（`v53jevrpMt`） | 10 | 62 | 0 | 5/5 绑定 `doubao-tts` |
| 《财务管理实战入门》（`W7ul2VMeq4`） | 7 | 43 | 0 | 无 `voiceConfig` |
| 《布迪厄思想互动入门》（`ge-RTEs1zb`） | 10 | 69 | 0 | 5/5 绑定 `doubao-tts` |

合计 202 条 speech 动作没有 `audioId`/`audioUrl`。`asset_entries=0`、`asset_blobs=0`，因此不是“引用存在但文件丢失”，而是音频从未持久化。4 门有效课程均确定命中第 2 类“课程有讲稿但没有自动旁白”；`OSFgmow52w` 的创建时段没有 TTS 请求或错误日志，强烈支持当时没有触发 TTS。浏览器本地的 `ttsEnabled`、当前选择和客户端 key 不在服务端数据库中，且本轮按要求不操作 UI，所以无法进一步断言当时具体开关值。数据库中没有 generation job/session 或媒体快照能证明这些旧课程命中过第 3 类 Pro/后台快照问题。

部署后再次核对原始表：`speech=207`、`audio_refs=0`、`asset_entries=0`、未撤销媒体快照为 0。原始表包含非当前有效课程/内部记录，因此数量大于上表；容器替换没有新增或删除音频资产。

### 10.2 已完成修复（无 UI、无架构调整）

- 媒体快照现在保存图像、视频、TTS 三类显式启用意图，覆盖 8 个内置图像、6 个内置视频、9 个服务端 TTS 以及自定义提供商；保存当前任务实际引用的角色音色、模型和 `providerOptions`。
- 前台 Pro 和后台生成均可从所有内置媒体快照解析客户端配置；服务端托管配置仍优先，浏览器原生 TTS 不会误降级为服务端 TTS。
- 教师音色按 provider/model/voice 精确匹配。TTS 不可用或部分 action 失败时，工具明确返回 narration incomplete，同时保留讲稿用于重试，不再把无声结果描述为完全成功。
- 内置远程提供商快照只接受官方 origin；ComfyUI、Lemonade、VoxCPM 等本地服务仍经过连接时 DNS/本地网络策略保护。密钥旋转或禁用会撤销相关快照，并修复了并发撤销遗漏新 ID 的竞态。
- MiniMax 图像/视频检测使用所选模型、20 秒主动超时，并校验 JSON、业务码和必要结果字段；视频成功语义明确为“任务已受理”。共享 `probeAuth` 只接受提供商声明的预期状态，429 和 5xx 均失败。
- Worker 使用独立 `MEDIA_CONFIG_ENCRYPTION_KEY`，不再接收 `PRO_MODEL_ENCRYPTION_KEY`；Compose 检查会拒绝密钥缺失、不一致或 Worker 越权持有 Pro key。

### 10.3 验证与 Docker 更新

- 定向回归：10 个核心文件、112 项测试通过；工作台媒体快照请求契约 6 个文件、28 项测试通过。
- TypeScript `--noEmit` 通过；目标 ESLint 0 error；`git diff --check` 无空白错误。
- 全套测试共 7,526 项：7,428 通过、54 跳过；44 项失败集中在与本修复无关的 `quiz/runtime` 和 `runtime/chat-storage` Windows/IndexedDB 5 秒超时。另有一个既存设置恢复测试期望 `ttsSpeed=1.25`、实际为 `1`，单独复跑仍失败。
- Docker Compose、既有外部卷、数据库目标和密钥配置检查通过；数据库迁移完成。最终镜像 `zhiyu:latest` 为 `sha256:4e1298cffd8f3329f8c8be2ace521ad031da0c84a2017e39f06942d1d05c2517`，旧镜像保留为 `zhiyu:rollback-20260908-media-fix`。
- `zhiyu` 已在 `127.0.0.1:3000` 运行；`/api/health` 为 200/ok，`/api/health/ready` 显示 database/schema 就绪。按现有配置，Worker 和后台接单保持关闭。

当前服务端没有配置可用的 TTS key，所以健康接口中的 TTS capability 仍为 false。代码链路已修复，但要给旧课程补配音，仍需先在实际浏览器设置中确认 TTS 总开关、最终 provider/model/voice 和有效凭据，再以单页或单条为试点；本轮未自动回填 202 条音频，避免未经确认的费用与声音覆盖。
