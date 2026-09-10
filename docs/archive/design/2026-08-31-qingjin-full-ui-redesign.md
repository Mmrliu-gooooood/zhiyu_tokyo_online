# 青衿 — OpenMAIC 全站 UI 二次改造设计方案

Date: 2026-08-31  
Status: Design proposal  
Scope: Round 2 / Competition UI overhaul  
Product: **青衿**  
Base: THU-MAIC/OpenMAIC  

---

## 0. 这次改造的核心判断

当前第一轮只完成了 Home 页视觉改造，因此从首页进入课堂后，会出现明显的“产品断层”：

- Home 已经是「青衿」的青瓷绿 / 宣纸白 / 宋体品牌语言；
- Classroom、Generation Preview、Chat、Settings、Workbench 等仍然是 OpenMAIC 原始蓝灰 / 紫色 / 浮动胶囊布局；
- 页面之间不仅颜色不一致，**导航方式、信息层级、卡片结构、工具区布局、操作路径也完全不一致**；
- 评委在 3 分钟演示中会很容易判断出“只有首页换皮，内部还是原项目”。

因此 Round 2 不做“全站换绿色”，而做一次 **产品 Shell 与工作台布局重构**。

> 业务能力、事件处理、生成流程、状态机、Store、API、数据模型保持不变；
> 可以重新组织视觉容器、导航、控制条、侧栏、工具栏、信息层级和组件外壳。

目标是：**看起来像一个新的 AI 教学产品，但功能仍然是 OpenMAIC。**

---

# 1. 产品设计原则

## 1.1 青衿负责“产品外壳”，课程内容保持中性

青衿品牌视觉应该应用到：

- 产品顶部栏
- 页面背景
- 导航
- 工具栏
- 控制区
- 对话区
- 卡片
- 设置页
- 加载 / 空状态 / 错误状态
- 工作台边栏

但不要强制修改：

- AI 自动生成课件本身的配色
- PPT / Slide 内部内容主题
- 图表与教学内容的颜色

原因：课件内容本身可能需要蓝色、黄色、红色等教学语义，如果强行改成青瓷绿会破坏内容表现。

即：

```text
青衿 UI Shell     → 统一品牌
课程 / Slide      → 保持内容独立
```

---

## 1.2 不做“组件换色”，做“界面重新编排”

Round 2 允许：

- 顶部栏重新布局
- Scene 导航重新布局
- 教师对话重新布局
- 参与者头像重新布局
- 播放控制重新布局
- 编辑 / 分享 / 导出入口重新分组
- 设置页重新分区
- Generation Preview 信息架构重做

但不允许：

- 新写第二套课堂状态机
- 重写播放逻辑
- 改变 sceneId / courseId / stage store
- 替换 generation API
- 重写 Chat 会话生命周期

---

## 1.3 比赛展示优先级

按评委最可能看到的路径排序：

```text
Home
 ↓
生成课程
 ↓
Generation Preview
 ↓
Classroom
 ↓
课堂互动 / Chat
 ↓
设置 / 编辑 / 导出
```

Round 2 优先把前 4 个节点做成完整产品体验。

---

# 2. 全局 Design System

## 2.1 核心颜色

沿用 Home 已确定的体系，但减少“品牌色到处都是”。

| Token | Value | Usage |
|---|---|---|
| Paper | `#F4F6F3` | 页面背景 |
| Porcelain | `#FBFCFB` | 卡片 / 顶栏 / 面板 |
| Ink | `#1B2420` | 主文字 |
| Muted | `#5C6B64` | 次级信息 |
| Celadon | `#3D6B5A` | 主按钮 / 激活 / Focus |
| Celadon Soft | `rgba(61,107,90,.08)` | Hover / Selected |
| Bronze | `#8A6A3D` | 品牌印章 / 极少量强调 |
| Hairline | `rgba(27,36,32,.09)` | 边框 |
| Canvas | `#EEF1EE` | 工作区底色 |

### 规则

- Celadon 只承担交互重点，不铺满大面积背景；
- Bronze 只用于 Logo / 品牌装饰，禁止当 CTA 主色；
- 禁止重新引入紫色主品牌；
- 课程 Slide 内部颜色不做全局替换。

---

## 2.2 字体

- 品牌「青衿」、页面一级标题：`Noto Serif SC`
- 产品 UI、按钮、设置、导航：Inter + CJK fallback
- Slide 内字体：完全保持原逻辑

禁止把所有 UI 都改成宋体。

---

## 2.3 圆角体系

| Level | Radius |
|---|---|
| 小按钮 / Chip | 8px |
| 输入框 / 工具组 | 10–12px |
| 卡片 | 14px |
| 大面板 / Dialog | 16px |
| Composer | 18px |

避免原 OpenMAIC 中大量“全圆 pill”。

---

## 2.4 阴影

只使用柔和、低对比度阴影：

```css
0 1px 2px rgba(20,30,25,.04),
0 8px 24px rgba(20,30,25,.05)
```

禁止：

- 紫色 Glow
- 大范围发光
- 强烈毛玻璃浮层

---

# 3. 全局产品框架：统一 App Shell

Round 1 Home 已经形成一套顶部品牌栏，但内部页面仍然各自有不同 Header。

Round 2 目标是形成统一的：

```text
QingjinAppShell
```

视觉结构：

```text
┌────────────────────────────────────────────────────────────┐
│ 青衿 [印]        当前课程 / 当前页面          EN  ⚙  ⋯   │  52px
├────────────────────────────────────────────────────────────┤
│                                                            │
│                      Page Content                           │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Top Bar 只显示全局操作：

- 青衿品牌
- 当前课程 / 页面标题
- 语言
- 设置
- 分享 / 导出（仅课程内）

不要把所有功能都挤进右上角一个大胶囊。

---

# 4. Classroom —— 重点重构

这是 Round 2 最重要页面。

当前课堂页的问题：

1. 页面顶部占用大，但真正的信息量很低；
2. 中央 Slide 外围有大量灰白空区；
3. 底部教师对话区域占横向全宽，但内容集中在左侧；
4. Agent、参与者、语音、聊天入口散落在四周；
5. 播放控制漂浮在 Slide 下方，不形成清晰的“播放工具栏”；
6. Scene 导航入口弱；
7. 全屏看起来更像一个 PPT Viewer，而不是 AI Classroom。

## 4.1 新 Classroom 总体布局

推荐使用 **三段式课堂工作台**：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 青衿 [印]   ←  课程导览                              EN  分享  ⚙   │
├──────────┬───────────────────────────────────────┬───────────────────┤
│          │                                       │                   │
│ Scene    │                                       │   课堂互动        │
│ Rail     │               Slide                   │                   │
│          │                                       │   AI 教师         │
│ 01       │                                       │   消息 / 讲解     │
│ 02       │                                       │                   │
│ 03       │                                       │   参与角色         │
│          │                                       │                   │
│          │                                       │                   │
├──────────┴───────────────────────────────────────┴───────────────────┤
│   1 / 10        ◀   ▶   播放   1×   重播    ✎ 编辑        全屏       │
└──────────────────────────────────────────────────────────────────────┘
```

### 核心变化

- 左侧：Scene / Slide 导航
- 中央：课程内容
- 右侧：AI 教师 / 课堂互动
- 底部：Playback Control Bar

比当前“底部大聊天条 + 四周分散按钮”更直观。

---

## 4.2 Scene Rail

默认宽度：72px。

状态：

```text
Collapsed: 72px
Expanded: 220px
```

Collapsed：

```text
01
02
03
04
```

当前 Scene：

- 左侧 3px Celadon indicator
- 背景 Celadon Soft
- Scene number 加粗

Expanded：显示：

- Scene 缩略图
- 标题
- 页码

点击左上方 Scene 图标展开。

### 功能映射

继续使用现有：

- Scene list
- Scene navigation
- currentSceneId

只改变 presentation。

主要文件：

- `components/stage/scene-sidebar.tsx`

---

## 4.3 Slide Stage

中央 Stage 不再放在巨大灰色矩形中。

推荐：

```text
Canvas background = #EEF1EE
```

Slide 外层：

- 最大宽度 `min(1100px, available width)`
- 16:9
- 14px radius
- 极弱阴影
- 1px Hairline

Slide 和容器之间保持约 20–28px 留白即可。

不需要当前那么大面积的无信息空白。

### Play 按钮

当前中央紫色 Play 是原项目视觉特征之一。

改为：

- 半透明 Porcelain 圆形
- Celadon 图标
- 轻微阴影
- Hover 才出现明显强调

不要做紫色渐变发光。

---

## 4.4 右侧「课堂互动」Panel

这是这次课堂重构最重要的信息架构变化。

把当前底部 AI Teacher 大条、右下用户头像、右侧 Agent 头像等信息统一进一个 Panel。

宽度：

```text
300–340px
```

Header：

```text
课堂互动        ● 进行中
```

Tabs：

```text
讲解 | 讨论 | 角色
```

### 讲解

显示当前 AI Teacher：

```text
[Avatar] AI 教师 · Dr. Aris

第一步是基础元件，比如电阻、电容……

[播放语音]
```

消息采用简洁卡片，而不是巨大气泡。

### 讨论

保留 Chat 功能。

### 角色

显示 AI Teacher / classmates：

```text
● Dr. Aris       正在讲解
○ Alice          等待
○ Bob            等待
○ Carol          等待
```

### 收起

右 Panel 可收起为 44px rail。

这样用户仍然可以获得接近全宽 Slide。

---

## 4.5 Bottom Playback Bar

把当前分散的播放按钮集中为一条真正的控制栏。

```text
1 / 10      ◀    ▶    ▶ 播放     1×     ↻     ✎ 编辑       ⛶
```

背景：Porcelain

顶部 Hairline。

高度：48px。

功能继续调用当前 playback engine。

---

## 4.6 Classroom Header

当前：

```text
CURRENT SCENE
课程导览
```

占用空间较多。

改成：

```text
青衿 [印]   ←   课程导览
```

右侧：

```text
EN   分享   导出   ⚙
```

Current Scene 标签不需要独立大写标签。

Scene 信息已经由左 Scene Rail 表达。

主要文件：

- `components/header.tsx`
- `components/stage/header-controls.tsx`

---

# 5. Chat 视觉与布局

Chat 不应该继续保持原项目完全独立的样式。

## 5.1 Standalone Chat

采用：

```text
AI 消息：无传统聊天泡泡，文本 + Avatar + subtle surface
用户消息：右对齐轻青瓷背景
```

不要像即时通讯软件。

目标是：

> “课堂记录 / AI 教学助手”

而不是：

> “微信聊天”。

---

## 5.2 Composer

输入区固定在底部：

```text
┌─────────────────────────────────┐
│ 向老师提问…                     │
│                    🎙  ⌘↵ 发送 │
└─────────────────────────────────┘
```

与 Home Composer 使用同样语言：

- Porcelain
- 1px Hairline
- 16px radius
- focus celadon ring

主要文件：

- `components/chat/chat-area.tsx`
- `components/chat/chat-session.tsx`
- `components/chat/proactive-card.tsx`
- `components/chat/inline-action-tag.tsx`

禁止修改：

- `use-chat-sessions.ts` 业务逻辑

---

# 6. Generation Preview —— 从“等待页”改成“生成控制台”

当前 `app/generation-preview/page.tsx` 本身超过 60KB，功能很多，但 UI 仍然偏“生成进度页”。

比赛演示中，生成过程实际上是一个非常重要的展示节点。

应该让它体现：

> 多智能体正在构建一堂课。

## 6.1 新布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 青衿 [印]     正在生成 · 数字电路基础              取消      │
├──────────────────────────┬───────────────────────────────────┤
│                          │                                   │
│  课程生成                 │      当前生成内容 Preview        │
│                          │                                   │
│  ● 解析需求      完成     │      ┌─────────────────────┐      │
│  ● 生成课程大纲  完成     │      │                     │      │
│  ● 创建 AI 教师  完成     │      │     Scene Preview   │      │
│  ◉ 生成 Scene 3  进行中   │      │                     │      │
│  ○ 生成媒体      等待     │      └─────────────────────┘      │
│                          │                                   │
│  6 / 10 Scene            │      Scene 3 · 模拟电路           │
│                          │                                   │
└──────────────────────────┴───────────────────────────────────┘
```

左侧：Generation Timeline

右侧：正在生成的 Scene preview。

---

## 6.2 Generation Timeline

状态：

- completed：Celadon check
- active：动态进度线 / spinner
- pending：Muted
- failed：red + retry

不要使用大面积动画。

允许非常轻的 progress shimmer。

---

## 6.3 生成完成

完成时：

```text
课程已准备好
10 个教学场景 · 4 位 AI 角色

[进入课堂]
```

CTA 使用 Celadon。

禁止突然自动切页面导致用户没看到完成状态；如果现有逻辑必须自动导航，则只做非常短的完成过渡。

主要文件：

- `app/generation-preview/page.tsx`
- `app/generation-preview/components/visualizers.tsx`

业务 retry / generation pipeline 保持不变。

---

# 7. Workspace / Pro Workbench

Workspace 不应该变成第二套品牌。

## 7.1 Layout

继续保留其多 Pane 工作方式，但视觉统一成：

```text
┌──────────┬──────────────────────┬─────────────────────────┐
│ 青衿     │                      │                         │
│          │  Conversation        │ Classroom / Editor      │
│ 最近     │                      │                         │
│ 课程     │                      │                         │
│ 会话     │                      │                         │
│          │                      │                         │
│ 设置     │                      │                         │
└──────────┴──────────────────────┴─────────────────────────┘
```

左 rail：220–240px。

颜色改造只是基础，更重要的是：

- 当前项目 / 会话状态更清晰
- pane header 高度统一
- 分割线减少
- hover 不再全部做 pill
- active 状态用左 indicator + soft wash

---

## 7.2 Workspace Home

Home 已经改过，Workspace Home 继续沿用同一个 Hero + Composer 语言。

不要再保留 OpenMAIC 横 Logo。

主要文件：

- `components/workbench/workspace/WorkspaceHome.tsx`
- `components/workbench/workspace-shell.css`
- Workspace rail / pane components

---

# 8. Settings —— 重新做成产品级设置中心

当前 Settings 功能很多，Provider / ASR / Image / PDF / Agent 等入口复杂。

不能只换绿色。

## 8.1 Layout

```text
┌───────────────────────────────────────────────────────────┐
│ 设置                                               ×     │
├──────────────┬────────────────────────────────────────────┤
│              │                                            │
│ 通用         │   模型与服务                               │
│ 模型与服务   │                                            │
│ 语音         │   默认大模型                              │
│ 图像         │   ┌────────────────────────────────────┐   │
│ 智能体       │   │ DeepSeek                       >   │   │
│ 文档         │   └────────────────────────────────────┘   │
│ 高级         │                                            │
│              │   API 服务                                │
│              │   …                                       │
└──────────────┴────────────────────────────────────────────┘
```

Dialog：

- width 900–980px
- max height 80–85vh
- left nav 180–200px
- right content scroll

---

## 8.2 Settings Card

每个配置块：

```text
标题
简短说明
─────────────────
控件
```

不要所有 Provider 都成为相同的巨大白卡。

主要文件：

- `components/settings/index.tsx`
- `components/settings/general-settings.tsx`
- `components/settings/provider-config-panel.tsx`
- `components/settings/provider-list.tsx`
- `components/settings/asr-settings.tsx`
- `components/settings/image-settings.tsx`
- `components/settings/agent-settings.tsx`

只改 presentation；配置 store 和 save handler 不动。

---

# 9. 编辑模式 / Editor

编辑功能不是比赛第一视觉重点，但从 Classroom 点击“编辑”后不能瞬间恢复原 UI。

原则：

- 编辑器 Canvas 本身不重写
- Command Bar 重新皮肤
- Property Panel 使用青衿 UI token
- 控件布局保持专业工具感

建议：

```text
┌──────────────────────────────────────────────────────────┐
│ ← 课程名       编辑模式        撤销 重做    预览   完成  │
├──────────┬──────────────────────────────┬────────────────┤
│ Scenes   │                              │ Properties     │
│          │          Canvas              │                │
│          │                              │                │
└──────────┴──────────────────────────────┴────────────────┘
```

不建议在本轮大改编辑能力。

---

# 10. Loading / Error / Empty State

所有内部页面统一。

## Loading

```text
青衿印章 mark
正在准备课堂…
```

spinner 使用 Celadon。

## Classroom Not Found

不要继续出现普通 shadcn 错误页。

```text
课程不在这里
它可能已被删除，或链接已经失效。

[返回青衿]
```

主要入口：

- `components/classroom/ClassroomSurface.tsx`

仅修改 presentation。

---

# 11. Motion

产品整体运动语言：

- 页面进入：opacity + 8px rise，180–240ms
- Panel open：180–220ms
- Scene Rail 展开：200ms
- Hover：120–160ms
- Dialog：160–200ms

禁止：

- bounce
- 彩色 glow pulse
- 无限 sparkle
- 大面积 scale animation

Classroom 重点是稳定，不要抢课件注意力。

---

# 12. Responsive

比赛 Demo 以 1440 / 1600 桌面为优先。

## > 1280

三栏课堂：

```text
Scene Rail + Stage + Classroom Panel
```

## 900–1280

右课堂 Panel 默认折叠。

```text
Scene Rail + Stage + 右侧 Drawer Button
```

## < 900

Scene Rail 变为 Drawer。

右课堂互动变 Bottom Sheet。

Playback Bar 保留。

---

# 13. 实现优先级

由于比赛时间紧，不要一次修改全部页面。

## P0 — 必须完成

### 1. Classroom Shell

- Header
- Stage canvas
- Scene rail
- Playback bar
- Classroom interaction panel

### 2. Generation Preview

- generation timeline
- preview layout
- finished state

### 3. Loading / error

完成 P0 后，演示路径已经完整：

```text
Home → Generate → Preview → Classroom
```

---

## P1 — 推荐完成

- Chat
- Settings
- Workspace rail / pane chrome

---

## P2 — 有时间再做

- Editor properties
- Video export dialog
- Secondary dialogs
- 非关键 mobile polish

---

# 14. 允许修改的主要文件

## Classroom

- `components/stage.tsx`
- `components/header.tsx`
- `components/stage/header-controls.tsx`
- `components/stage/scene-sidebar.tsx`
- `components/stage/scene-thumbnail-content.tsx`
- `components/classroom/ClassroomSurface.tsx`
- Playback chrome presentation components

## Chat

- `components/chat/chat-area.tsx`
- `components/chat/chat-session.tsx`
- `components/chat/proactive-card.tsx`
- `components/chat/inline-action-tag.tsx`
- `components/chat/lecture-notes-view.tsx`

## Generation Preview

- `app/generation-preview/page.tsx`
- `app/generation-preview/layout.tsx`
- `app/generation-preview/components/visualizers.tsx`

## Settings

- `components/settings/index.tsx`
- settings presentation components

## Workspace

- `components/workbench/workspace-shell.css`
- `components/workbench/workspace/*`
- Workbench visual chrome

## Global

- `app/globals.css`
- `lib/brand/brand-config.ts`
- related i18n copy

---

# 15. 禁止修改

以下属于核心逻辑，不因 UI 改造而改变：

- generation pipeline
- `lib/orchestration/*`
- playback state machine
- action engine
- stage storage
- provider API
- Dexie / PostgreSQL persistence
- scene generation
- media generation
- Chat lifecycle
- `use-chat-sessions.ts` 核心业务逻辑
- Course / Stage data schema

尤其不要因为布局变化新写一套 playback / chat handler。

---

# 16. Behaviour Contract

UI 重构后必须保持：

- Home 生成课程正常
- Generation Preview 正常继续生成
- Scene 切换正常
- 播放 / 暂停 / next / previous 正常
- TTS 正常
- Agent / Teacher 发言正常
- Chat 正常
- 进入编辑模式正常
- 返回 / Workspace navigation 正常
- 分享 / 导出正常
- Settings 保存正常
- Theme / Language 正常

所有原 handler 尽量直接复用。

---

# 17. 视觉验收标准

完成后，从任意一张内部页面截图中，即使遮住 Logo，也应该能够判断这是和 Home 同一套产品。

至少满足：

1. Classroom 不再使用原 OpenMAIC 的顶部结构；
2. Classroom 不再使用底部全宽旧 AI Teacher Strip；
3. 播放控制形成统一 Toolbar；
4. Scene 导航成为明确的信息结构；
5. AI 教师 / 讨论 / 角色统一进入课堂互动 Panel；
6. Generation Preview 不再只是原布局换色；
7. Settings 有明确的导航与内容层级；
8. 内部页面与青衿 Home 使用同一设计语言；
9. 紫色只允许出现在 AI 生成课件内容本身，不作为产品 UI accent；
10. 所有业务行为保持不变。

---

# 18. 验证

代码修改完成必须执行：

```bash
pnpm lint
pnpm check:i18n-keys
pnpm test
pnpm build
```

同时人工走完整演示路径：

```text
打开 Home
→ 输入课程需求
→ 开课
→ Generation Preview
→ 进入 Classroom
→ Scene 前后切换
→ 播放 / TTS
→ 打开课堂互动
→ 发送消息
→ 进入编辑模式
→ 返回 Classroom
→ 打开 Settings
→ 回到 Home
```

如果任何业务流程因 UI 重构失效，优先回退布局改动，不修改核心业务来迁就新 UI。

---

# 19. 推荐实施顺序

```text
01 Design tokens / shared shell
02 Classroom header
03 Scene rail
04 Stage canvas
05 Playback toolbar
06 Classroom interaction panel
07 Loading / error
08 Generation Preview
09 Chat
10 Settings
11 Workspace
12 Editor polish
13 Full regression test
```

不要同时重构所有组件。

---

# 20. 最终产品体验

青衿不应该是：

> OpenMAIC + 青绿色主题。

而应该是：

> 一个具有独立产品身份的 AI 教学工作台，底层复用 OpenMAIC 的成熟能力。

Home 是“开始学习”；
Generation Preview 是“AI 正在构建课堂”；
Classroom 是“学习与互动中心”；
Workspace 是“教学创作工作台”；
Settings 是“系统配置中心”。

所有页面需要围绕这个产品心智重新组织，而不只是视觉换色。
