# 浏览器差异、Worker、TTS 与场景加载状态排查

## 请求与处理范围

处理本轮四项反馈：确认 Worker 实际生成职责并排查重复日志；定位 Edge 的 BACKGROUND_PROVIDER_UNAVAILABLE；修复首页 TTS 默认模型缺失；统一待生成场景的转圈。保留用户已确认正常的完成页和头像。沿用当前工作树，未删除镜像或数据卷。

## 已确认的运行证据

- 用户 Chrome 课程任务 `d9d7802c-d28b-46ff-8d80-fa07b94dcd53`、课堂 `132a99a6-4d31-4cd2-b5d0-b992396f0136`。数据库 ownership 为 `course-worker`，producer_ref 指向该任务；Worker 容器日志有领取/让出记录，最终 succeeded。
- 课程从 23:24:59 到 23:31:40，约 401.5 秒。调用记录为 19 次文本（平均 8.2 秒、最长 31.2 秒）、5 次媒体（平均 32.6 秒、最长 50.3 秒）、43 次 TTS（平均 5.5 秒、最长 11.9 秒）。这些时间存在并行重叠，不能直接相加当总耗时。
- 当前场景并发为 2。没有把并发调高，也不承诺固定提速。独立 Worker 提供持久化任务执行和恢复，不会消除外部模型、媒体、语音调用本身的耗时。
- Docker Desktop 中 `openmaic` 是 Compose Web/API 服务名；其日志不代表它在执行课程生成。该课程观测到 232 次 SERVER_OWNED_GENERATION，是客户端文档写回冲突。

## 已修复的缺陷

1. 播放重置与板书动作调用 StageAPI，纯白板显示变化被标为课程文档修改，触发 putStage，再被服务端所有权门禁拒绝。现在 server-job 课程的纯白板播放状态不排队文档写入；真正的课程编辑仍经过原服务端权限检查。没有通过静音日志或放宽所有权处理。
2. 首页 TTS 面板是空节点，未渲染任何模型信息。现在显示真实平台默认或自定义模型，以及目录加载/未配置状态，不改变选中的模型或音色。
3. 侧栏原代码仅给第一个待生成场景加旋转动画。现在正在执行生成时所有待生成场景统一旋转，减少动画设置下关闭；失败、取消和重试等待保留原状态。
4. 新课程会错误携带未选中角色/自动生成角色模式下的旧音色覆盖，导致快照没有对应提供者而预检失败。现在只冻结当前实际预设角色使用的覆盖，保留用户设置原映射。
5. 新课程的显式平台角色音色可能仍携带旧 revision，而媒体快照已使用新 revision。现在按同一平台 defaultId 的当前目录版本冻结新提交，保持音色 ID 和用户设置；既有后台任务不改输入。
6. 预检把文本、TTS、图片、视频、搜索及媒体快照异常全部归为同一个 BACKGROUND_PROVIDER_UNAVAILABLE。现在按能力返回固定错误码和 12 语言操作提示，Docker 仅记录固定能力码，不输出原始上游异常或凭据。
7. 最后复核确认全局语音与角色语音混用平台/个人配置时，角色顶层身份未适配为媒体快照需要的 selection，可能错误继承全局身份。现在显式传递角色选择；真实构造链覆盖“全局个人、角色平台”和反方向，平台条目不带个人凭据，个人条目保留自身配置，音色不变。

## Edge 与 Chrome 的差异证据及限制

- 浏览器分别保存本站设置和匿名会话；同一 localhost 地址并不保证提交完全相同的配置。浏览器地址栏用 Bing 与项目的 Brave 联网搜索无关。
- 项目内 Brave 使用 `https://search.brave.com` 网页搜索，代码明确无需 API Key。两组已保存搜索快照均无 key，不应要求用户为了此问题填写 Brave key。
- 容器内对相关配置快照进行只读比较，输出仅为平台选择、音色 ID、时间、是否含 key 的布尔值；未导出任何 key。两组近期媒体快照的 image/video/tts 平台模型版本及默认音色一致，且公开目录全部 available。
- CUA 最初连接失败，随后内置浏览器恢复，可以验收新版首页及已有课堂；Edge 虽出现在浏览器列表，读取标签页仍报 request-header policy 加载失败。无法读取原 Edge 当前本地设置和被拒绝的完整输入。上述两项音色冻结缺陷有独立红绿回归，但不能据此宣称已唯一定位原 Edge 的错误。已请用户在原 Edge 强制刷新后重试，用新版能力提示进一步确认。

## Worker 架构专项核对

仅以用户指定旧文档第 7 节“问题三：PostgreSQL 队列与独立 Worker 架构”的生成职责作为依据，没有实施其他过时章节。

- Web `app/api/generate-classroom/route.ts` 处理身份、幂等、预检和入队，返回 202，不执行生成流水线。
- `workers/generation/main.ts` 直接调用共享 Node/TypeScript 生成服务，覆盖研究、大纲、角色、全部场景内容、教学动作、媒体和 TTS；没有通过 HTTP 回调 Web 的生成路由。首幕和余幕使用同一流水线。
- PostgreSQL 仓储使用领取锁、SKIP LOCKED、租约、epoch fencing、步骤 checkpoint、场景发布和资产登记。浏览器只观察 server-job，不恢复为本地生成。
- Docker Worker 独立编译和运行，只依赖数据库及初始化服务，不依赖 Web 容器存活；关闭页面只停止客户端轮询，取消任务有独立显式命令。
- 与旧文档存在两处效率策略差异：客户端失败固定 5 秒重试，未按页面可见性调整；首幕前部分状态更新仍整体读取文档，进入课堂后使用 manifest 和场景增量。均不是 Worker 职责缺失，本轮未扩大修改。
- Pro 对话推理属于独立 agent runtime；其课程创建工具通过同一课程任务仓储入队，不能要求所有对话推理都迁入课程 Worker。
- 本轮没有新增“停止 Web 后仍继续生成”的故障注入，因此容器独立性在此为代码和 Compose 审计结论，不能冒充新的停机实验。

## 验收记录

- 13 个文件共 134 项回归通过，包含预检、输入冻结、语音、TTS 面板、侧栏动画、持久化、ownership 和失败返回。启用 `TEST_BROWSER_UI=1` 的 Chromium 测试检查多个待生成图标的实际动画和减少动画行为。
- TypeScript 检查通过。针对最后一处测试类型修正重跑输入冻结 14 项，全部通过。
- 混合语音身份补充修复后，输入与媒体快照两文件共 26 项回归、ESLint、Prettier 通过；根 TypeScript 再次通过。这些测试与前述主回归有重叠，不将数量直接相加。
- 2026-09-12 首轮部署并执行下述真实课程/UI 验收，源码标识 `worktree-c8e289ef0510-fb99895f5f762de9`。其后仅补充第 7 项语音身份适配及对应测试，再次构建通过，最终源码标识 `worktree-c8e289ef0510-2f2e50111d53eda5`。最终 Web 镜像 `sha256:4bcc995e543af4cd18e94fd2a1808d26167b547f288a89b76fe439d066d0d4d2`；Worker 镜像 `sha256:2878f28e536eeadb2c9e7e58b31ce20303e5b0882151c34a69510e47ba57b0fe`。最终部署日志另存 `.scratch/20260912-provider-ui-final-deploy.log`，构建日志为 `.scratch/20260912-provider-ui-final-build.log`。
- `/api/health/ready` 的 database、schema、worker、accepting 全部 true；三个运行容器全部 healthy。
- 最终补充镜像切换后再次核对：Web/Worker 容器均为 `2f2e50111d53eda5` 版本，四项 readiness 全 true、三容器 healthy；新日志没有 ownership 冲突、预检拒绝或 Worker job_failed。刷新上述浏览器课堂正常。未把首轮真实生成冒充最终补充镜像上的重复 API 实验。
- 真实 API 课程任务 `f638a477-f40b-4f1f-ba02-eae2e2d32758`，课堂 `06b17fb3-1912-4dd1-8262-4a92fc58a312`，一页课程 succeeded。数据库总耗时约 75 秒，10 秒间隔轮询在第 80 秒观察到成功。研究、计划、角色、内容、动作、媒体、TTS 全部成功；1 次图片媒体生成、6 次 TTS 步骤成功。视频能力参与预检但此次没有生成视频。
- `research:search` 有非空结果（序列化长度 1004），Worker 未出现 optional search 降级日志，确认真实 Brave 搜索完成。
- Worker 对该任务的 claim/yield 记录与数据库状态一致。新容器验收窗口内 `job_failed`、预检拒绝、`SERVER_OWNED_GENERATION` 均为 0；这只是该窗口证据，不保证用户旧页面永远不会发起其他越权写入。
- 内置浏览器实际验证首页 TTS 能分别显示已选浏览器语音和平台默认语音。选择平台模型后展示“ZHIYU 默认语音模型 / MiniMax Speech 2.8 Turbo”。已有 server-job 课堂连续前后切换正常，完成页保持正常。
- 另从内置浏览器首页真实提交四页课程，任务 `ea5ba46a-c548-40b7-ba7b-bd2e1c6012d6`、课堂 `6497aba4-e1d1-45e2-89f3-d595d93739ed`，约 39 秒 succeeded，正常进入课堂。浏览器采样时所有页面已完成，未捕捉到多页等待的动画窗口；多图标转动的证据来自上述真实 Chromium 组件测试。此次未启用搜索、图片、视频和 TTS。
- 截图：`.scratch/20260912-provider-ui-evidence/tts-default-model.png`、`completion-preserved.png`。构建、部署、真实 API 日志分别为 `.scratch/20260912-provider-ui-docker-build.log`、`20260912-provider-ui-deploy.log`、`20260912-provider-ui-real-smoke.log`。
- 尚待原 Edge 用户会话复测，不能把内置浏览器及独立 API 成功等同于已验证原 Edge 的旧配置。
