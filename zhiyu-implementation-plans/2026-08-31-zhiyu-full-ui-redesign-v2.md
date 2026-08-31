# 智域 ZHIYU — 全站 UI 二次改造设计方案 V2
## Dribbble-inspired AI Education Workspace

Date: 2026-08-31  
Status: **Approved with complete Surface Matrix and confirmed Q1–Q5 decisions**  
Scope: Competition-facing full product UI redesign  
Product: **智域 / ZHIYU**  
Base: `THU-MAIC/OpenMAIC`  
Visual reference: `https://dribbble.com/shots/27167779-AI-Educational-Tool-Web-App`

---

# 0. 本版相对 V1 的变化

V1 已经完成了两个关键决策：

1. 品牌由“青衿”调整为 **智域 / ZHIYU**；
2. 内部页面不再只换颜色，而是允许重新组织信息架构与界面布局。

V2 在此基础上进一步吸收参考作品的高层视觉语言：

- 柔和浅色 Canvas；
- 模块化学习卡片；
- 友好的教育产品气质；
- 少量多色语义状态；
- 轻量 3D / abstract illustration；
- 更明显的 dashboard hierarchy；
- 更强的视觉节奏；
- 更少“企业后台 / 灰白 SaaS”感。

但 V2 **不是对参考作品做像素级复制**。

我们只融合：

- 视觉气质；
- 卡片组织方式；
- 色彩角色；
- 信息层级；
- 插画使用策略；
- 学习产品的友好感。

不复制：

- 参考作品的具体图片；
- 3D 人物资产；
- logo；
- 精确布局；
- 特有图标；
- 课程业务模块；
- Calendar / Homework / Assignment 等 OpenMAIC 本身不存在的功能。

原则：

> **Inspired, not cloned.**

---

# 1. 产品定位

智域不是 LMS，也不是传统教务系统。

智域是：

> **面向任意学科的 AI 多智能体互动课堂与学习工作台。**

典型使用方式：

```text
输入一个学习目标
→ AI 理解需求
→ 自动生成课程
→ 构建多个教学场景
→ 配置 AI 教师 / AI 同学
→ 进入互动课堂
→ 讲授 / 讨论 / 提问 / 编辑
```

可以覆盖：

- 编程
- 电子
- 数学
- 物理
- 工程
- AI
- 语言
- 历史
- 人文
- 通识课程
- 项目式学习

因此 UI 必须同时满足：

```text
AI 感
+
教育感
+
通用学科
+
比赛展示
+
成熟产品
```

---

# 2. 品牌

## 2.1 Product Identity

| Item | Value |
|---|---|
| 中文品牌 | **智域** |
| 英文展示 | **ZHIYU** |
| Category | AI Interactive Classroom |
| Browser title | `智域 · AI 互动课堂` |
| Main slogan | `一句话，生成一堂互动课` |
| Supporting copy | `多智能体教师与同学，实时讲授与讨论` |
| Attribution | `基于 OpenMAIC 构建` |

Footer：

```text
智域 · 基于 OpenMAIC 构建
```

或英语 locale：

```text
ZHIYU · Powered by OpenMAIC
```

---

## 2.2 Brand feeling

智域应该给人的感受：

- 聪明
- 轻盈
- 清晰
- 友好
- 有学习氛围
- 有 AI 能力但不神秘
- 高校 / 大学生可以自然使用
- 不幼稚
- 不企业后台
- 不“AI 紫色模板”

三个关键词：

> **Structured · Friendly · Intelligent**

中文：

> **有结构、友好、有智能感。**

---

# 3. 参考视觉如何融合

参考设计的价值不在于具体业务，而在于以下视觉特征：

## 3.1 Soft Canvas

背景不是纯白，也不是重灰。

整个产品建立在一种柔和、轻暖、略带纸感但**不国风**的浅色 Canvas 上。

推荐：

```text
#F3F2F0
```

或略冷：

```text
#F4F6F4
```

内部 Surface：

```text
#FFFFFF
```

这样课程卡、Composer、AI 卡片自然浮起。

---

## 3.2 Modular Cards

不同信息不再都长成：

```text
白色 + 1px Border + 12px Radius
```

而应该根据角色形成不同模块：

```text
Primary Learning Card
AI Card
Progress Card
Course Card
Status Card
Utility Card
```

视觉变化来自：

- 卡片比例
- 背景轻色
- 图形
- 排版
- 空间

不是靠每张卡都加阴影。

---

## 3.3 Friendly Education

参考作品的教育感来自：

- 明确学习状态；
- 更大的课程视觉；
- 友好 illustration；
- 颜色承担语义；
- 页面不是工程后台密度。

智域也应该：

> 更像“学习产品”，而不是“LLM 配置工具”。

---

## 3.4 Color-coded information

多色不是装饰。

每种色承担角色。

例如：

```text
Green      Brand / success / current learning
Blue       AI / generation / intelligence
Lavender   Agent / assistant secondary identity
Yellow     progress / learning highlight
Coral      warning / attention
```

颜色必须有语义，不允许随机彩色。

---

# 4. 色彩系统

## 4.1 Core Palette

### Background

```text
Canvas Warm       #F3F2F0
Canvas Neutral    #F5F7F5
Surface           #FFFFFF
Surface Soft      #FAFBFA
```

### Text

```text
Ink               #142019
Ink Secondary     #4F5D56
Muted             #7E8983
```

### Brand

```text
Zhiyu Green       #356B59
Zhiyu Green Hover #2C5C4B
Zhiyu Green Soft  #E7F0EB
```

### AI

```text
AI Blue           #5277B6
AI Blue Soft      #EAF0F9
```

### Agent / Intelligence Accent

允许少量重新引入低饱和紫蓝：

```text
Lavender          #7569B7
Lavender Soft     #EFEDF8
```

注意：

> 紫色不再是品牌主色，只是 AI / Agent 的二级语义色。

这可以避免重新变回 OpenMAIC 的紫色品牌。

### Learning Highlight

```text
Learning Yellow   #C79528
Yellow Soft       #F7EFCF
```

### Attention

```text
Coral             #C75C63
Coral Soft        #F7E7E8
```

### Neutral

```text
Border            #DFE4E1
Hairline          rgba(20,32,25,.08)
```

---

# 5. 颜色使用纪律

## Brand Green

只能作为：

- 主 CTA
- 当前导航
- current scene
- selected state
- focus
- success
- primary learning progress

不要：

- 所有文字都绿
- 所有 icon 都绿
- 全页面绿色边框

---

## AI Blue

用于：

- AI 正在生成
- AI 运行
- 智能推荐
- Agent runtime
- 技术状态

---

## Lavender

用于：

- AI Teacher / Agent 的 secondary identity
- Assistant chip
- 某些智能体状态

不要：

- Primary button
- 页面大背景
- Product logo

---

## Yellow

用于：

- 学习进度
- 课程亮点
- 学习提示

---

## Coral

用于：

- warning
- 需要注意
- failure precursor

Danger 仍使用真正 red。

---

# 6. Typography

不使用：

- 宋体 Logo
- Serif Hero
- 书院型排版

使用：

- `Noto Sans SC`
- existing CJK sans stack
- Inter
- Geist

字体目标：

> 现代学习应用，而不是学术论文。

建议：

| Role | Size |
|---|---|
| Logo | 22–24 / 650 |
| Hero | 38–46 / 600 |
| Page title | 22–28 / 600 |
| Card title | 15–18 / 600 |
| Body | 13–15 |
| Meta | 11–12 |

---

# 7. 图形与 Illustration

## 7.1 原则

允许使用 illustration，但只作为：

> 视觉层级与产品情绪增强。

不是业务本体。

---

## 7.2 视觉类型

优先：

- abstract 3D learning object
- floating knowledge blocks
- AI nodes
- connected spheres
- course blocks
- soft 3D geometry
- abstract learning workspace

不优先：

- 儿童卡通人物
- 真实教师照片
- 过度拟人的 3D 学生
- 巨大机器人吉祥物

---

## 7.3 使用位置

只建议重点放在：

1. Home welcome / AI creation card；
2. Empty state；
3. Generation Preview；
4. 非关键 Dashboard decorative card。

不要在 Classroom 中央 Stage 周围堆 illustration。

---

## 7.4 比赛前资源策略

如果没有时间做完整 3D：

可以用原创轻量 abstract SVG / CSS geometry。

例如：

```text
sphere
cube
knowledge node
layered card
floating mini scene
```

不要直接截取 Dribbble 原图作为产品素材。

---

# 8. 全局空间语言

## 8.1 Radius

参考风格可以比 V1 更柔和，但不要 pill 泛滥。

```text
Small chip       8–10px
Control          10–12px
Card             14–18px
Feature card     20–24px
Composer         20px
```

---

## 8.2 Shadow

主要依赖：

- 卡片色差
- whitespace
- border
- layered surface

Shadow 只做很轻：

```css
0 1px 2px rgba(20, 30, 25, .035),
0 8px 24px rgba(20, 30, 25, .045);
```

Feature card：

```css
0 2px 4px rgba(20, 30, 25, .04),
0 16px 40px rgba(20, 30, 25, .06);
```

---

# 9. App Shell

内部页面建立统一 Shell：

```text
┌───────────────────────────────────────────────────────────────┐
│ ZHIYU 智域        Context / Course               Actions      │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                         Content                               │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Header：

```text
52–58px
```

---

# 10. Home V2

V1 Home 已经比 OpenMAIC 干净，但目前仍然太像：

> 一个大 AI 输入框 + 最近课程。

V2 目标：

> **AI Learning Home**

既保留快速生成，又增加一点完整学习产品感。

---

## 10.1 Home IA

推荐布局：

```text
┌──────────────────────────────────────────────────────────────────┐
│ [Z] 智域                              我的课程   EN   ⚙   Avatar │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  你好，同学                                                      │
│  今天想探索什么？                                                │
│                                                                  │
│  ┌───────────────────────────────────┐ ┌───────────────────────┐ │
│  │ 一句话，生成一堂互动课            │ │                       │ │
│  │                                   │ │    Abstract AI        │ │
│  │ 输入你想学习的内容...             │ │    illustration      │ │
│  │                                   │ │                       │ │
│  │ 📎 资料  🌐 搜索  ✦ 互动   [开课] │ │  多智能体协作         │ │
│  └───────────────────────────────────┘ └───────────────────────┘ │
│                                                                  │
│  最近课堂                                     查看全部           │
│                                                                  │
│  [ Course ]   [ Course ]   [ Course ]   [ Folder ]              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 10.2 不增加假功能

参考作品可能有：

- progress
- assignments
- homework
- calendar
- learning analytics

智域当前没有可靠数据来源时：

> **绝不为了好看制造假的统计卡。**

如果已有数据，可以显示：

- slide count
- last opened
- generated status
- active generation
- course type

如果没有：

不要假造：

```text
学习 78%
连续学习 12 天
3 个作业待完成
```

---

## 10.3 Hero / Composer

Composer 不再孤立悬在页面中央。

把它当一个：

> **Create Learning Experience Card**

它可以比普通表单更具视觉重量。

左侧：

- Greeting
- prompt
- tools
- CTA

右侧 feature card：

- abstract AI illustration
- 当前 agents mini preview
- 一句简洁产品提示

---

## 10.4 Recent Course Card

推荐更像学习产品：

```text
┌─────────────────────────┐
│      Course Thumbnail   │
│                         │
├─────────────────────────┤
│ 数字电路基础             │
│ 10 scenes · 今天         │
└─────────────────────────┘
```

不要给每张 card 巨大边框。

可以：

- thumbnail
- soft background
- small meta
- hover lift
- 轻微 scale 1.01

---

# 11. Classroom V2 —— P0

Classroom 仍采用 V1 的核心架构：

> **Scene Rail + Learning Stage + Interaction Panel + Playback Bar**

但是视觉语言升级得更像参考风格：

- softer canvas
- fewer borders
- more modular surfaces
- interaction cards
- semantic colors
- friendly whitespace

---

# 12. Classroom Layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ZHIYU   ←  数字电路基础                              分享  导出  EN  ⚙  │
├──────────┬──────────────────────────────────────────────┬──────────────────┤
│          │                                              │ 课堂互动         │
│ 01       │                                              │                  │
│ 02       │                 Slide                        │ [ AI Teacher ]   │
│ 03       │                                              │                  │
│ 04       │                                              │ [ Discussion ]   │
│          │                                              │                  │
│          │                                              │ [ Agents ]       │
├──────────┴──────────────────────────────────────────────┴──────────────────┤
│ 3 / 10        ◀   ▶       ▶ 播放       1×     ↻     编辑        ⛶      │
└────────────────────────────────────────────────────────────────────────────┘
```

---

# 13. Scene Rail

## Collapsed

```text
72px
```

样式：

- Canvas 与主 Stage 同底
- 当前 Scene 是小型 soft card
- Green Soft + left accent
- 其他 scene 不加完整边框

例如：

```text
 01
▌02
 03
 04
```

---

## Expanded

```text
232px
```

卡片：

```text
[ Thumbnail ]
03 · 数字电路
```

Scene thumbnail 尽量保持课程内容自身颜色。

---

# 14. Learning Stage

背景：

```text
#EEF1EF
```

Slide：

- 视觉中心
- 16:9
- 最佳 fit
- 14–16 radius
- weak shadow
- 不加品牌绿 border

周围只保留必要 whitespace。

---

## Play Overlay

取消原紫色 Glow。

推荐：

```text
64px circular surface
white / translucent
green icon
soft shadow
```

Hover：

```text
background → Green Soft
```

---

# 15. Interaction Panel

不是 IM Sidebar。

应该像参考设计那种：

> 模块化学习信息区。

宽度：

```text
320–360px
```

背景：

```text
Surface Soft
```

Panel 内部不是“一整片白”，而是多个结构化模块。

---

## 15.1 Panel Header

```text
课堂互动                     ● 进行中
```

状态 dot：

- live → Green
- agent thinking → Blue

Tabs：

```text
讲解    讨论    角色
```

active tab 不用巨大 pill。

---

## 15.2 AI Teacher Card

推荐：

```text
┌──────────────────────────────┐
│ [Avatar] Dr. Aris            │
│ AI 教师 · 正在讲解           │
│                              │
│ 第一步是基础元件，例如……     │
│                              │
│ ▶ 听讲解                     │
└──────────────────────────────┘
```

视觉：

- Lavender Soft / AI Blue Soft 可用于角色 header
- 内容 body 保持 neutral
- 头像不发光

---

## 15.3 Discussion

讨论信息使用轻模块。

AI：

```text
Avatar + Role
正文
```

User：

```text
small Green Soft card
```

避免传统大气泡聊天 UI。

---

## 15.4 Roles

角色卡可以带一点“参考设计”的 color-coded feeling：

```text
● Dr. Aris       正在讲解
● Alice          正在思考
○ Bob            等待
○ Carol          等待
```

语义：

```text
Teaching   Green
Thinking   Blue
Idle       Neutral
Attention  Yellow
```

---

# 16. Playback Bar

V2 继续强调：

> 控制必须集中。

```text
3 / 10    ◀   ▶    [▶ 播放]    1×    ↻     ✎ 编辑      ⛶
```

Active Play：

- Green
- 不用 purple

Secondary control：

- neutral
- hover surface

---

# 17. Generation Preview V2

这是最适合融合参考视觉的页面之一。

目标：

> **AI Course Construction Dashboard**

不是 loading page。

---

## 17.1 Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ 智域   正在生成 · 数字电路基础                       取消    │
├──────────────────────────┬───────────────────────────────────┤
│                          │                                   │
│  AI 正在构建你的课堂      │   Current Scene                  │
│                          │                                   │
│ [abstract 3D object]     │   ┌───────────────────────────┐   │
│                          │   │                           │   │
│  ● 学习目标       完成   │   │       Preview             │   │
│  ● 课程结构       完成   │   │                           │   │
│  ◉ Scene 4       生成中  │   └───────────────────────────┘   │
│  ○ 媒体资源       等待   │                                   │
│                          │   Scene 4 / 10                    │
└──────────────────────────┴───────────────────────────────────┘
```

---

## 17.2 Illustration

此页面可放一张高质量 abstract illustration。

例如：

- floating lesson cards
- connected agent nodes
- layered knowledge blocks

色彩：

- Green
- Blue
- Lavender
- Yellow small accent

不要出现 literal 机器人老师。

---

## 17.3 Progress module

每个状态不是传统 Stepper 大线条。

可以是轻卡片列表：

```text
✓ 解析学习目标
✓ 构建课程结构
● 生成教学场景
○ 准备媒体资源
```

状态：

```text
Done      Green Soft
Active    AI Blue Soft
Pending   Neutral
Error     Coral Soft
```

---

# 18. Workspace V2

Workspace 更像：

> AI Creation Workspace

不是“开发工具”。

---

## Layout

```text
┌──────────────┬─────────────────────────┬───────────────────────┐
│ ZHIYU        │                         │                       │
│              │ Conversation            │ Course / Editor       │
│ 课程         │                         │                       │
│ 会话         │                         │                       │
│ 最近         │                         │                       │
│              │                         │                       │
│ 设置         │                         │                       │
└──────────────┴─────────────────────────┴───────────────────────┘
```

---

## Workspace Rail

不做传统企业 sidebar。

使用：

- 轻 Canvas
- selected row = Green Soft
- small icon
- generous vertical rhythm

允许 small colored status dot，但不能成为彩虹 sidebar。

---

# 19. Settings V2

Settings 不适合过度参考教育 dashboard。

此处更克制：

> 保持专业工具感，但沿用智域 Surface / Typography / spacing。

结构仍然：

```text
Left Navigation
+
Content
```

推荐：

```text
通用
模型
语音
图像
智能体
文档
高级
```

右侧设置通过 section grouping 展示。

---

# 20. Settings 卡片规则

不要每个配置项一个浮卡。

应该：

```text
模型与服务
选择课程生成使用的模型与 API 服务

默认模型
[ DeepSeek V3                           > ]

视觉模型
[ ...                                   ]
```

只有复杂 Provider 才使用卡片。

---

# 21. Chat V2

Chat 要更像学习对话。

不做：

> Slack / Messenger。

---

## AI response

```text
[Avatar] AI 教师
解释正文……
```

---

## User

```text
              ┌─────────────────────┐
              │ 为什么这里要并联？  │
              └─────────────────────┘
```

Background：

```text
Green Soft
```

---

# 22. Editor

Editor 是工具型界面。

不强行塞 illustration。

只融合：

- modern surface
- soft canvas
- grouped controls
- clear active states
- calmer toolbar

---

# 23. Empty / Error

这是可以加入 illustration 的另一个地方。

例如：

## No Courses

```text
[abstract lesson blocks]

这里还没有课程
从一个问题开始创建你的第一堂互动课。

[创建课程]
```

---

## Course Not Found

```text
课程不在这里
它可能已被删除，或链接已经失效。

[返回智域]
```

---

# 24. Loading

不要只显示 spinner。

普通 loading：

```text
[small Z mark]
正在载入课堂…
```

Generation loading：

使用 Generation Preview，不使用普通 spinner。

---

# 25. Header 统一

Home：

```text
[Z] 智域                         我的课程    EN   ⚙   Avatar
```

Classroom：

```text
[Z] 智域   ←   数字电路基础              分享  导出  EN  ⚙
```

Generation：

```text
[Z] 智域   正在生成 · 数字电路基础                取消
```

Workspace：

```text
ZHIYU shell
```

不是每个页面一套不同导航。

---

# 26. 图标

继续使用当前 icon system（例如 lucide）时：

- stroke 统一；
- 16 / 18 / 20 size；
- 避免混入厚重彩色 icon；
- colorful status 尽量用 dot / soft background；
- 不为参考风格额外引入一整套陌生 icon pack。

---

# 27. Motion

参考作品视觉有活力，但智域不要变成动画展示站。

## Entry

```text
opacity
+
translateY(6px)
```

Duration：

```text
180–240ms
```

---

## Cards

hover：

```text
translateY(-1px)
shadow slightly stronger
```

不要：

```text
scale 1.06
```

---

## Illustration

可做非常微小的 floating：

```text
2–3px
6–8s
```

但比赛稳定性优先。

如果时间不足：

> illustration static。

---

# 28. Responsive

## Desktop Demo

重点：

```text
1366
1440
1512
1600
```

---

## Classroom

> 1280：

三列。

900–1280：

Interaction 默认 collapsed。

<900：

Scene → drawer  
Interaction → drawer / sheet

---

# 29. Original OpenMAIC content vs ZHIYU shell

必须再次强调：

AI 自动生成 Slide 内部的：

- 蓝
- 红
- 黄
- 紫
- 图表色

全部可以存在。

例如电子课件用蓝黄：

> 正常。

我们只改：

```text
Viewer shell
Navigation
Controls
Conversation
Panels
Settings
Loading
```

禁止 AI 生成课件被全局 CSS 的品牌色污染。

---

# 30. 首页课程内容色彩

Course Thumbnail 必须保持课程原色。

Card 周边可以是：

```text
Surface
soft colored meta
```

例如：

```text
2 slides · 今天
```

使用 Green Soft。

不要把 thumbnail 本身做 green overlay。

---

# 31. 不实现参考作品里不存在于智域的数据

以下内容除非 OpenMAIC 当前有真实数据来源，否则禁止实现：

- Homework
- Calendar
- Assignment percentage
- Streak
- Fake completion rate
- Weekly time
- Fake recommendations
- Fake grades

如果需要视觉丰富度：

优先使用真实数据：

- scenes
- agents
- created time
- last opened
- generation state
- course title
- type / mode

---

# 32. 主要工程边界

允许：

- 重组 JSX
- 新建纯展示 components
- layout wrapper
- CSS variables
- presentation-level context
- illustration asset
- icon wrapper
- visual status mapper

禁止：

- 重写 generation
- 重写 playback
- 重写 Chat state
- 重写 Stage lifecycle
- 搬 Store
- 改 Provider API
- 为 UI 添加重复业务流

---

# 33. 文件范围

## Global / Home

- `app/page.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `lib/brand/brand-config.ts`
- `public/*`
- i18n

---

## Classroom

- `components/stage.tsx`
- `components/header.tsx`
- `components/stage/header-controls.tsx`
- `components/stage/scene-sidebar.tsx`
- `components/stage/scene-thumbnail-content.tsx`
- `components/classroom/ClassroomSurface.tsx`
- playback presentation components

---

## Interaction / Chat

- `components/chat/chat-area.tsx`
- `components/chat/chat-session.tsx`
- `components/chat/proactive-card.tsx`
- `components/chat/inline-action-tag.tsx`
- `components/chat/lecture-notes-view.tsx`

业务 hook 不做 UI 重构。

---

## Generation Preview

- `app/generation-preview/page.tsx`
- `app/generation-preview/layout.tsx`
- `app/generation-preview/components/visualizers.tsx`

---

## Workspace

- `components/workbench/workspace-shell.css`
- workspace presentation components

---

## Settings

- `components/settings/index.tsx`
- settings presentation components

---

# 34. P0

比赛前必须：

## P0.1 Brand

```text
智域 / ZHIYU
```

品牌完成。

---

## P0.2 Home V2

完成：

- modern header
- creation feature card
- illustration slot
- course cards
- brand cleanup

---

## P0.3 Generation Preview

完成：

- generation dashboard
- progress modules
- preview
- AI illustration
- state semantics

---

## P0.4 Classroom

完成：

- unified header
- Scene Rail
- Stage
- Interaction Panel
- Playback Bar

---

## P0.5 Loading / Error

统一。

---

# 35. P1

- Chat detail
- Workspace rail
- Settings

---

# 36. P2

- Editor polish
- export dialogs
- mobile
- Dark mode detail
- secondary dialogs

---

# 37. 实施顺序

```text
01 Brand tokens
02 Global visual primitives
03 Home V2
04 Generation Preview shell
05 Classroom Header
06 Scene Rail
07 Learning Stage
08 Playback Bar
09 Interaction Panel
10 Loading/Error
11 Workspace
12 Chat
13 Settings
14 Editor polish
15 Regression
```

---

# 38. Behaviour Contract

必须保持：

- generate
- generation resume
- course open
- Scene navigation
- play / pause
- TTS
- AI agent speaking
- Chat
- edit
- Pro workspace
- share
- export
- settings
- language
- theme
- import
- folder
- search
- history

全部正常。

---

# 39. QA

执行：

```bash
pnpm lint
pnpm check:i18n-keys
pnpm test
pnpm build
```

并人工走：

```text
Home
→ 创建课程
→ Generation Preview
→ Classroom
→ Scene navigation
→ Play
→ Chat
→ Agents
→ Edit
→ Settings
→ Return Home
→ Open existing course
```

---

# 40. 视觉验收

必须全部满足：

1. 首页比 V1 更像完整 AI 教育产品，而不是单输入框。
2. 没有文学 / 书院视觉暗示。
3. 内部页面明显属于智域。
4. Classroom 不再像 OpenMAIC PPT Viewer。
5. Scene navigation 明确。
6. Interaction Panel 是学习交互区，不是 IM。
7. Generation Preview 是 AI 建课过程展示。
8. 多色有语义，不是随机彩色。
9. 紫色不再承担品牌主色。
10. 课程内容本身不被智域 UI 染色。
11. 3D / Illustration 克制、原创、辅助而非喧宾夺主。
12. 不制造 OpenMAIC 不存在的假业务模块。
13. 即使遮住 Logo，也可以从布局和 UI 判断属于智域。
14. 功能不因视觉重构受损。

---

# 41. 参考融合比例

目标不是复刻。

建议心智比例：

```text
50% 参考 Dribbble 的视觉气质
    ├─ soft canvas
    ├─ modular cards
    ├─ friendly education
    ├─ illustration
    └─ semantic colors

40% 智域自己的产品信息架构
    ├─ AI Course Creator
    ├─ Generation Preview
    ├─ Classroom
    ├─ Interaction Panel
    └─ Workspace

10% OpenMAIC 原有成熟 interaction patterns
    └─ 只保留确实好用且无需重做的部分
```

---

# 42. 最终产品画面

## Home

> **今天想探索什么？**

一个让用户感觉：

> “我可以从任何问题开始一堂课。”

的 AI Learning Home。

---

## Generation

让用户感觉：

> “多个 AI 正在把我的问题真正构建成课程。”

---

## Classroom

让用户感觉：

> “这里不是 PPT Viewer，而是一堂正在发生的互动课。”

---

## Workspace

让用户感觉：

> “这里是课程、AI 会话和编辑工作的中心。”

---

# 43. 最终一句话

> **智域 ZHIYU — 一句话，生成一堂互动课。**

---

# 44. Implementation note for coding agent

Do not implement this as a palette replacement.

Before editing each major surface, identify:

1. existing business handlers;
2. existing state ownership;
3. visual components that can move;
4. layout wrappers that can be replaced safely.

For each surface:

> Preserve behavior first, replace hierarchy second, style third.

Do not make the implementation depend on hardcoded mock learning data.

---

# 45. Reference note

The Dribbble project is a **visual inspiration source only**.

Use only high-level design patterns:

- clean intuitive hierarchy;
- modular educational dashboard;
- friendly visual elements;
- 3D-inspired illustration direction;
- color-coded status;
- learning-focused atmosphere.

Create original ZHIYU layouts and assets.

Do not reproduce proprietary artwork, exact composition, logo, or screenshots.
