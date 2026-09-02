# ZHIYU 前端内部架构优化实施方案

Status: **Ready for agent — 在新对话中分阶段执行**

**目标：** 在不改变任何可见 UI、交互结果、路由、服务端接口、数据协议或 Docker 部署拓扑的前提下，优化 ZHIYU/OpenMAIC 的前端状态归属、渲染更新范围和生命周期管理，提高流式课堂与 Workspace 的性能和鲁棒性。

**实施原则：** 把现有 JSX、DOM、CSS、ARIA、`data-testid` 和交互语义视为冻结的输出 interface；重构仅发生在前端 module、selector、状态投影、render island 和浏览器生命周期 ownership 内部。

**技术栈：** Next.js 16、React 19、TypeScript、Zustand、Tailwind CSS 4、Vitest、Playwright、Docker Compose。

**产品语言：** 继续遵守 `CONTEXT.md`。Home、Generation Preview、Standalone Classroom、Hosted Classroom、Workspace、Classic Chat、Workbench Conversation 的产品含义不得混淆。

**已有视觉/行为证据：**

- `design-qa.md`
- `e2e/tests/zhiyu-home-ui.spec.ts`
- `e2e/tests/zhiyu-generation-ui.spec.ts`
- `e2e/tests/zhiyu-classroom-ui.spec.ts`
- `e2e/tests/zhiyu-workspace-ui.spec.ts`
- `e2e/tests/zhiyu-responsive-matrix.spec.ts`
- `tests/components/classroom/zhiyu-classroom-shell.test.ts`
- `tests/classroom/zhiyu-classroom-layout.test.ts`

---

## 1. 当前状态与可信边界

### 1.1 当前版本

- 本地分支：`main`
- 当前 HEAD：`1157a15`（`docs(ui): record final zhiyu QA`）
- 用户已确认：当前应用能够通过 Docker 正常运行，并可在 localhost 正常使用。
- 本轮规划没有实施前端架构代码修改，也没有重新执行 Docker/localhost 验证；新对话必须把当前可用状态重新固化为可复现基线。

### 1.2 当前工作树

开始实施前必须运行 `git status --short`，保留并识别用户已有改动。规划时观察到以下工作树内容，实施者不得覆盖、还原或误归属：

- `app/page.tsx`
- `design-qa.md`
- `lib/brand/brand-config.ts`
- `next.config.ts`
- `tests/lib/brand/brand-config.test.ts`
- `public/zhiyu-lockup.png`
- `public/zhiyu-mark.png`
- `tests/config/standalone-prompt-assets.test.ts`

如果实际状态已经变化，以新对话中的 `git status --short` 为准。

### 1.3 已确认的架构事实

- `components/stage.tsx` 继续拥有 Standalone/Hosted Classroom 的 edit/playback dispatch。
- `lib/playback/engine.ts` 继续拥有播放状态机。
- `lib/action/engine.ts` 继续拥有课堂 Action 执行。
- `lib/orchestration/director-graph.ts` 继续拥有经典课堂多智能体调度。
- `lib/workbench/panel-context.tsx` 继续拥有 Hosted Classroom ambient context。
- `lib/workbench/session-store.ts` 继续是 Workbench Conversation fold 的权威状态。
- 本计划不修改上述业务 ownership，只缩小前端渲染和生命周期 interface。

---

## 2. 问题陈述

### 2.1 Classroom 热路径过宽

`components/edit/PlaybackChromeRoot.tsx` 当前约 2000 行，同时承载：

- StageStore、SettingsStore、CanvasStore 等多个 store 订阅；
- playback、discussion、speech、thinking、element reference、presentation、responsive drawer 状态；
- keyboard、fullscreen、timer、AbortController、audio 和 SSE 生命周期；
- Header、Scene Rail、Stage、Interaction Panel、Playback Bar 的 JSX 组合。

`useStageStore()` 整体订阅和位于 root 的高频 `speechProgress`、`thinkingState`、`liveSpeech` 更新，会扩大 React 协调范围。流式交互更新不应要求静态 Header 或 Scene Rail 重新参与 render。

### 2.2 Workspace ownership 分散

`components/workbench/workspace/WorkspaceShell.tsx` 同时处理 URL、Owner EventSource、会话列表、attached session、course discovery、tab memory、responsive pane、resize 和三个 pane 的组合。

`components/workbench/workspace/WorkspaceRail.tsx` 同时包含课程树、会话树、搜索、分页、拖拽、rename/delete dialog 和 overflow menu。问题不是单纯文件长度，而是 race、刷新和导航决策缺乏 locality。

### 2.3 Generation Preview 缺少单一 canonical phase

`app/generation-preview/page.tsx` 同时处理异步生成、Abort、错误转换、StageStore 写入、sessionStorage 写入、进度 index/flag 和 ZHIYU 时间线投影。取消、重试或迟到 Promise 需要通过单一 generation epoch 和 canonical phase 进行约束。

---

## 3. 解决方案概览

目标前端数据流：

```text
用户事件 / Store / SSE / 浏览器事件
                  ↓
       深层前端状态 module
                  ↓
       稳定 presentation projection
                  ↓
           独立 render islands
                  ↓
       现有 JSX / DOM / CSS 原样输出
```

### 3.1 Classroom Runtime

深化一个 route-scoped、client-only 的 Classroom Runtime：

- 按课堂挂载，不是 module-level global singleton；
- 统一管理 playback/chat/presentation 的前端生命周期；
- 将状态投影为 Chrome、Stage、Interaction、Playback Bar 四个窄 render island；
- 高频流式状态只更新真正消费它的 island；
- 保持唯一 `ChatArea` 实例；
- 保持 `PlaybackEngine`、`ActionEngine` 和 StageStore 的现有 authority。

### 3.2 Workspace Model

深化一个 Workspace Model：

- 统一归并 URL pane、owner session stream、attached session、course tabs 和 course discovery 事件；
- 输出 Rail、Chat、Classroom 三个稳定 projection；
- Owner EventSource 在 Workspace mount 期间保持唯一；
- session rename、snapshot 和增量事件通过同一一致性 seam；
- pane 不读取彼此内部状态。

### 3.3 Generation Session

深化一个 Generation Session module：

- 将 outline、review、agent、scene、media、completed、failed、cancelled 归并为 canonical phase；
- 每次执行拥有 generation epoch；
- 旧 epoch 的异步完成不得写入新会话；
- StageStore/sessionStorage 写入由合法状态转换触发；
- ZHIYU 页面只消费 projection，不拥有异步流程细节。

---

## 4. 硬性不变量

以下条件任何一项不满足，都不得合并：

1. 不修改可见文案、图标、颜色、间距、动画、布局或 responsive breakpoint。
2. 不修改现有 DOM 顺序、关键 className、ARIA、`inert`、tab order、focus return 和 `data-testid`。
3. 不增加新的 UI 框架、状态库或图标库。
4. 不修改 Next.js 路由、Route Handler、middleware、数据库 schema、持久化 HTTP contract 或 Docker topology。
5. 不把浏览器状态放到 Server Component 或服务端 module-level singleton。
6. 不改变 Standalone Classroom 与 Hosted Classroom 的 ownership。
7. 不复制 `ChatArea`、PlaybackEngine、EventSource 或 audio runtime 实例。
8. 不把 transient playback/chat/presentation 状态加入持久化 store。
9. 不通过新增内部 mock seam 测试 private helper；优先穿过现有页面、store public interface 和 E2E seam。
10. 不在同一提交中混合结构迁移、视觉改动和新产品功能。

---

## 5. 用户故事

1. As a learner, I want the classroom to look and behave exactly as before, so that the internal refactor does not disrupt learning.
2. As a learner, I want live speech and discussion updates to remain responsive, so that streaming content does not stall unrelated classroom chrome.
3. As a learner, I want keyboard shortcuts, focus traps and responsive drawers to remain reliable, so that desktop and narrow-screen interaction is unchanged.
4. As a course creator, I want Workspace sessions, courses and panes to survive rapid navigation and reconnection, so that stale events cannot overwrite my current view.
5. As a course creator, I want session rename results to remain consistent under delayed responses, so that a newer title is never replaced by an older snapshot.
6. As a course creator, I want generation cancellation and retry to reject stale completions, so that an abandoned run cannot alter the new course state.
7. As a self-hosting operator, I want the production Docker build and localhost workflow to remain unchanged, so that deployment risk does not grow with the frontend refactor.
8. As a maintainer, I want state ownership and lifecycle cleanup concentrated behind narrow interfaces, so that future fixes remain local and testable.
9. As a maintainer, I want measurable render and lifecycle gates, so that performance claims are supported by repeatable evidence.
10. As an accessibility user, I want screen-reader names, focus order, live regions and reduced-motion behavior to remain unchanged, so that architecture work does not create an accessibility regression.

---

## 6. 分阶段实施任务

## Phase 0 — 冻结当前可用基线

### Task 0.1：只读预检

- [ ] 阅读本方案、`CONTEXT.md`、`design-qa.md` 和相关 ZHIYU 实施计划。
- [ ] 运行 `git status --short`，记录并保护用户已有修改。
- [ ] 记录 Node、pnpm、Docker 和 Docker Compose 版本。
- [ ] 确认 localhost 当前使用端口及 Docker profile。
- [ ] 不执行 reset、clean、checkout restore 或删除命令。

### Task 0.2：建立测试基线

- [ ] 运行 `pnpm lint`。
- [ ] 运行 `pnpm check:i18n-keys`。
- [ ] 运行 `pnpm test`。
- [ ] 运行 `pnpm build`。
- [ ] 运行当前项目已有的 Docker build/up 流程。
- [ ] 在 `http://localhost:3000` 运行 `pnpm test:e2e:docker`。
- [ ] 记录失败项；已有失败不得被误归因于本计划。

### Task 0.3：把截图留证升级为回归门禁

- [ ] 保留现有 responsive matrix evidence capture。
- [ ] 为确定性 product chrome 状态增加 Docker 环境下的 golden screenshot comparison。
- [ ] 覆盖 800、1024、1366、1600 宽度，以及 1366 light/dark。
- [ ] 覆盖 Home、Generation Preview、Standalone Classroom、Hosted Classroom、Workspace combined panes、loading/missing/error。
- [ ] 对动态生成内容进行固定 fixture 或 mask；不要用动态内容制造假像素失败。
- [ ] 固定浏览器、字体和 device scale，避免跨环境抗锯齿噪声。

### Task 0.4：建立性能与生命周期基线

- [ ] 添加测试专用 React Profiler 记录，不改变 production DOM。
- [ ] 记录 100 次 speech/thinking 更新期间各 render island 的 commit 数量和 p95 duration。
- [ ] 记录 Workspace owner/session 事件期间 Rail、Chat、Classroom 的 commit 数量。
- [ ] 记录 20 次 mount/unmount 后的 timer、listener、EventSource 和 audio cleanup。
- [ ] 将基线结果写入本方案末尾的 Execution Log 或单独 QA 文档。

### Phase 0 退出条件

- 当前 Docker/localhost 可用状态已被自动化复现。
- 视觉、行为、性能和生命周期都有可比较基线。
- 任何现存失败均有明确记录。

---

## Phase 1 — 收窄 Classroom store interface

### Task 1.1：消除整体 StageStore 订阅

- [ ] 盘点 `PlaybackChromeRoot` 实际读取的 StageStore 字段。
- [ ] 用窄 selector 替换 `useStageStore()` 整体订阅。
- [ ] 派生 current scene 时避免让不相关 StageStore 字段触发 root render。
- [ ] 保留现有 store action 和业务 authority。
- [ ] 添加 selector 级行为测试，证明相关字段更新仍能刷新正确区域。

### Task 1.2：稳定低频 projection

- [ ] 将 classroom layout、live status、control availability 等纯投影集中在现有 classroom projection seam 附近。
- [ ] 稳定传入 Header、Scene Rail、Playback Bar 的 callback 和 object identity。
- [ ] 不为单一实现创建泛化 adapter。

### Phase 1 退出条件

- 截图、DOM、E2E 和 build 全部无回归。
- StageStore 不相关更新不再触发 `PlaybackChromeRoot` commit。
- 没有移动 PlaybackEngine、ChatArea 或 SSE 生命周期。

---

## Phase 2 — Classroom Runtime 与 render islands

### Task 2.1：建立 canonical presentation/runtime state

- [ ] 将 responsive drawer、presentation controls、discussion/live status 的关联布尔状态归并为可测试的状态转换。
- [ ] 明确定义互斥不变量：窄屏 Scene Drawer 与 Interaction Drawer 不得同时打开。
- [ ] 明确定义 presentation、pause、discussion cleanup 和 scene switch 的合法转换。
- [ ] 通过 public transition seam 测试，不测试 private helper。

### Task 2.2：隔离四个 render island

- [ ] Chrome island：Header、Shell、Scene Rail，只消费低频布局和课程元数据。
- [ ] Stage island：当前场景、播放状态和可见学习内容。
- [ ] Interaction island：ChatArea、thinking、live speech、speech progress 和角色状态。
- [ ] Control island：Playback Bar、action cursor、speed、autoplay 和控制状态。
- [ ] React module 拆分不得新增 DOM 容器。
- [ ] 保持唯一 ChatArea 实例和现有 tab state。

### Task 2.3：集中浏览器生命周期 cleanup

- [ ] 收拢 keyboard、F11/fullscreen、idle timer、AbortController、audio 和 engine dispose ownership。
- [ ] cleanup 必须幂等。
- [ ] scene epoch、session epoch 和 unmount 后的 callback 必须拒绝 stale update。
- [ ] React Strict Mode 双挂载路径不得创建重复 listener 或 runtime。

### Phase 2 性能目标

- 100 次 speech/thinking 更新期间，Classroom Shell、Header、Scene Rail 各自 commit 不超过 5 次。
- speech progress 更新时 Scene Rail commit 为 0。
- 1366 宽度课堂场景的 p95 React commit duration 相对 Phase 0 基线下降至少 30%。
- 800 宽度 responsive drawer 路径不得出现性能或交互回归。

### Phase 2 退出条件

- 现有 `zhiyu-classroom-ui`、`classroom-interaction`、responsive matrix、layout/shell tests 全部通过。
- mount/unmount stress 后无 listener、timer、audio 或 runtime 泄漏。
- Docker port 3000 课堂流程通过。

---

## Phase 3 — Workspace Model

### Task 3.0：先处理已知上游一致性差异

- [ ] 只读研究上游 `9d16e68296dbfdf6002e0572fef98ea3689fee29` 的 session-title revision、rename queue 和 snapshot reconciliation。
- [ ] 不直接 cherry-pick；本地历史和 ZHIYU Shell 已分叉，应按意图移植。
- [ ] 将该修复作为独立提交并单独验证，不与 Workspace module 重构混合。
- [ ] 异步 `generate_video` placeholder 属于功能 parity，不属于本前端架构计划；另行处理。

### Task 3.1：集中 owner session lifecycle

- [ ] 让一个深 module 独占 OwnerSessionClient 创建、start、stop、snapshot 和增量事件归并。
- [ ] 任意 Workspace mount 最多存在一个 owner EventSource。
- [ ] session rename、attached row projection 和 owner snapshot 通过同一 recency 规则。
- [ ] 快速 rename A→B→C 时，旧响应不得覆盖 C。

### Task 3.2：集中 navigation/tab projection

- [ ] 归并 URL panes、course chat bootstrap、course tabs、closed tabs 和 narrow focus 决策。
- [ ] 保持 URL 为 deep-link interface，内部 pane 状态为当前 writer。
- [ ] 保持 Hosted Classroom attach/detach 与 Workspace mount 生命周期一致。
- [ ] Workspace 离开后必须清除 hosted/edit intent。

### Task 3.3：隔离 Workspace render islands

- [ ] Rail 只消费课程树、会话树、search/paging/drag projection。
- [ ] Chat pane 只消费当前 conversation projection。
- [ ] Classroom pane 只消费当前 course/playback projection。
- [ ] 消除 Shell JSX 中不必要的 inline callback/ReactNode identity churn。
- [ ] 不因为文件长度机械拆分 dialog/menu；只有能提高 depth 或 locality 的 module 才移动。

### Phase 3 性能与鲁棒性目标

- attached session 的 message/thinking 更新不得触发 Rail commit。
- owner list 的无关后台行更新不得触发 Classroom pane commit。
- rapid session/course navigation 不得出现旧 session 状态借给新 pane。
- mount/unmount 20 次后 EventSource 数量回到 0。
- reconnect、snapshot 和 incremental event 测试覆盖乱序及迟到事件。

### Phase 3 退出条件

- 所有 `tests/workbench`、`zhiyu-workspace-ui`、responsive Workspace E2E 通过。
- session title race 测试通过。
- Docker port 3000 Workspace feature-on 路径通过。

---

## Phase 4 — Generation Session 状态机

### Task 4.1：定义 canonical phase

- [ ] 以现有行为为准，记录 idle、outline streaming、outline review、agent generation、scene generation、media/actions、completed、failed、cancelled 的合法转换。
- [ ] 保留现有 outline-review、retry 和 first-scene handoff 语义。
- [ ] 时间线 step 继续由现有 ZHIYU projection 输出。

### Task 4.2：增加 generation epoch

- [ ] 每次开始或重试生成时创建新的 epoch。
- [ ] 所有异步 completion 在写入 state/store/storage 前验证 epoch。
- [ ] cancel、route leave 或 restart 后，旧 Promise 不得写入当前会话。
- [ ] Abort 与 provider error 保留现有用户可见结果。

### Task 4.3：分离 orchestration 与页面 JSX

- [ ] Generation Session 拥有异步步骤和持久化 side effect。
- [ ] 页面只转发用户 intent 并渲染 projection。
- [ ] 收窄对 StageStore scenes 的订阅，只读取时间线和预览真正需要的值。
- [ ] 不改变 `ZhiyuGenerationShell` DOM 或 props 语义。

### Phase 4 退出条件

- `zhiyu-generation-ui`、Home→Generation、generation flow 和 missing-session 测试通过。
- cancel→restart stress 下没有 stale scene、stale timeline 或 sessionStorage 污染。
- Docker port 3000 Generation Preview 路径通过。

---

## Phase 5 — 全量 release gate

- [ ] `pnpm lint`
- [ ] `pnpm check:i18n-keys`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Docker production build
- [ ] Docker port-3000 E2E
- [ ] Golden screenshot comparison
- [ ] Home → Generation Preview → Classroom 完整流程
- [ ] Workspace session → course → Hosted Classroom 完整流程
- [ ] light/dark 与 800/1024/1366/1600 responsive matrix
- [ ] keyboard、focus、ARIA、`inert`、Escape 和 focus-return 验证
- [ ] 性能基线前后报告
- [ ] timer/listener/EventSource/audio cleanup stress

---

## 7. 测试决策

### 7.1 最高层 seam 优先

优先顺序：

1. Docker production E2E；
2. 页面级 Playwright 行为测试；
3. store/public projection contract；
4. 纯状态转换测试；
5. private implementation 不建立测试 seam。

### 7.2 视觉门禁

- 产品 chrome deterministic 区域要求像素一致。
- 动态生成内容使用固定 fixture 或 mask。
- 不通过放宽全局 screenshot threshold 掩盖真实布局差异。
- React module 拆分不得新增 DOM 容器，否则视为 UI 变更。

### 7.3 性能门禁

- 性能测试使用固定事件序列，而不是外部模型调用。
- 同一 Docker/browser/font/viewport 条件下比较前后结果。
- 同时记录 commit 次数、p50/p95 duration、long task 和 cleanup。
- 优化不得以关闭动画、减少功能或隐藏内容实现。

---

## 8. Next.js 与 Docker 安全规则

1. Client runtime 文件保持 `'use client'` 或只被 client module 导入。
2. 不从 Server Component 导入包含浏览器全局、Zustand hook、EventSource、Audio 或 DOM 的 module。
3. 不在 module scope 创建跨请求共享的课堂或 Workspace runtime。
4. SSR 首次 markup 与当前实现一致；responsive 语义状态通过现有 hydration 策略处理。
5. 不修改 `next.config.ts`、Dockerfile、Compose 或 middleware，除非出现独立、可复现的构建缺陷，并另立任务。
6. 每个 Phase 都必须通过 `pnpm build` 和 Docker production gate，不能只验证 `pnpm dev`。
7. feature-off 和 feature-on 的 Workspace 路径都要验证。

---

## 9. Out of Scope

- 任何 UI 重新设计、视觉微调、文案调整、动画调整或 responsive breakpoint 变化。
- 新增产品功能或分析数据。
- 修改生成内容样式。
- 修改 LLM、媒体、TTS/ASR、存储或数据库协议。
- 修改 Next.js Route Handler 或后端 Agent Runtime 架构。
- 升级 Next.js、React、Zustand、Tailwind 或其他依赖。
- 重写 PlaybackEngine、ActionEngine 或 LangGraph Director。
- 上游异步 `generate_video` placeholder 功能移植。
- 为追求“文件更小”而进行无 ownership 收益的机械拆分。

---

## 10. 提交与回滚策略

- 每个 Task 或紧密相关的小组任务一个提交。
- 建议提交顺序：baseline tests → selector narrowing → classroom state → classroom islands → workspace title fix → workspace model → generation state machine → release QA。
- 不混合 CSS/视觉变更。
- 每个 Phase 结束前记录测试结果和性能结果。
- 任一 Phase 的 Docker gate 失败时停止，不继续下一 Phase。
- 回滚以 Phase 提交为单位，不使用 `git reset --hard` 或破坏用户工作树的命令。

---

## 11. Suggested Skills

新对话建议按以下顺序使用：

1. `matt-skills-curated:tdd` — 先建立回归和性能基线，再进行状态/selector 重构。
2. `matt-skills-curated:implement` — 按本方案逐 Phase 实施并验证。
3. `matt-skills-curated:diagnosing-bugs` — 仅在 Docker、hydration、lifecycle 或 race 回归时使用。
4. `matt-skills-curated:code-review` — 每个 Phase 完成后检查是否改变 UI 或业务 ownership。
5. `matt-skills-curated:git-safety-guardrails` — 只有在需要破坏性或历史改写操作时使用；默认不应需要。

---

## 12. 新对话启动提示

将下面这段作为新对话的第一条消息：

> 请完整阅读 `zhiyu-implementation-plans/2026-09-01-07-zhiyu-frontend-internal-architecture-optimization.md`、`CONTEXT.md` 和 `design-qa.md`。使用 `matt-skills-curated:tdd` 与 `matt-skills-curated:implement`。严格保持现有 UI、DOM、CSS、ARIA、路由、服务端接口和 Docker topology 不变。先只执行 Phase 0：检查并保护当前 dirty worktree，重新验证 pnpm build、测试、Docker port 3000 和现有 E2E，建立视觉/性能/生命周期基线。Phase 0 未完成前不要实施 Phase 1，也不要修改任何产品代码。完成后报告基线结果和真实 blocker。

## Exact Next Action

```powershell
Get-Content -LiteralPath 'zhiyu-implementation-plans\2026-09-01-07-zhiyu-frontend-internal-architecture-optimization.md' -Raw
```

读取完成后，从 Phase 0 / Task 0.1 开始；不要跳到架构修改。

---

## 13. Execution Log

由实施新对话追加，禁止预填成功结果：

| Phase | Commit | Tests | Docker | Visual | Performance | Notes |
|---|---|---|---|---|---|---|
| Phase 0 | `b2c66c8` (closure HEAD; full ledger in Phase 0-R results) | Default Vitest 7160 passed / 44 skipped; dedicated Workspace 1/1 | Production build 52/52 pages; E2E 80/80; port 3000 healthy | Win32 41/41; Noble update + no-update 41/41 | Classroom and real Workspace profiler plus production-browser baselines recorded | Status: READY FOR PHASE 1; see `2026-09-02-zhiyu-frontend-phase0-r-results.md` |
| Phase 1 | `bf5d1e8`, `02466f7` | Focused selector/projection/profiler/cleanup 33/33; lint pass; production build 52/52 pages | `openmaic:phase1` `sha256:662f9b84...`; E2E 80/80; port 3000 healthy; topology unchanged | No-update responsive/golden 41/41 | Unrelated StageStore update: root commits 0; speech p95 5.643→3.855 ms (-31.7%); thinking p95 2.165→1.123 ms (-48.1%); browser long task 1/149 ms, TaskDuration 0.492702 s | 20-cycle listener/timer/audio/EventSource cleanup passed; final Standards/Spec review: no findings; PlaybackEngine, ChatArea and SSE ownership unchanged |
| Phase 2 | `7517b6f`, `8278a79`, `ab3479a`, `23dab9d` | Focused classroom/chat/profiler suite 178/178; profiler 8/8; cleanup stress 3/3; related ESLint pass; production build 52/52 pages | `openmaic:phase2` `sha256:2aec951e...`; E2E 80/80; port 3000 healthy; topology unchanged | Dedicated no-update responsive/golden 41/41 | Speech root p95 5.643→0.080 ms (-98.6%); thinking root p95 2.165→1.036 ms (-52.1%); Header/Rail/PlaybackBar commits 0; browser long tasks 1/147 ms, Layout 23, Recalc 59, LayoutDuration 0.037693 s, ScriptDuration 0.126420 s, TaskDuration 0.478022 s | Canonical reducer + mount-scoped live runtime; Stage/Interaction render islands; 20-cycle timer/listener/audio/EventSource cleanup passed; deterministic stale-producer active-bubble RED reproduced then fenced GREEN; final Standards/Spec review: no findings; PlaybackEngine, ChatArea, SSE and audio ownership unchanged |
| Phase 3 |  |  |  |  |  |  |
| Phase 4 |  |  |  |  |  |  |
| Phase 5 |  |  |  |  |  |  |
