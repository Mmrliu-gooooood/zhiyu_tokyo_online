# 青衿 Design System — Round 2 Product Shell

Product: **青衿** (Qingjin) — an AI teaching workspace on top of OpenMAIC.
Audience: teachers and learners in a competition demo (desktop 1440 / 1600 first).
Single job of the product shell: make every internal page feel like the same Qingjin product as Home — not OpenMAIC with a green theme.

This document is a **hard constraint**. Do not invent fonts, colors, or chrome that are not listed here.

---

## Product context

Qingjin is already branded on Home (celadon / paper / bronze seal / Noto Serif SC wordmark). Classroom, Generation Preview, Chat, Settings, and Workbench chrome still look like OpenMAIC (purple pills, floating capsules, 80px transparent header, 192px bottom Roundtable).

**Qingjin owns the product shell. Course / Slide content stays independent.**

- Shell = top bar, background, nav, toolbars, chat chrome, cards, settings, loading/empty/error, workbench rails.
- Slides / PPT / charts keep their own teaching colors (blue, yellow, etc. are allowed **inside the slide card only**).
- Do not recolor generated course content celadon.

JTBD by screen:

| Screen | Job |
| --- | --- |
| Home | Start a class from one prompt |
| Generation Preview | Show multi-agent class construction as a console |
| Classroom | Learn + interact with AI teacher, scenes, playback |
| Workspace | Teaching creation workbench |
| Settings | System configuration center |

---

## Brand lockup

- Bronze seal: 28×28px, `#8A6A3D`, 3px radius, inner hairline ring `#FBFCFB`/`#F4F6F3`, glyph **衿** in Noto Serif SC 700, color `#FBFCFB`.
- Wordmark **青衿** immediately to the right, Noto Serif SC semibold ~22px, `#1B2420`.
- Never replace the seal with a cube, purple mark, OpenMAIC logo, initials-only, emoji, or invented SVG.
- Bronze is **only** for the seal / brand stamp. Never use Bronze as a CTA fill.

---

## Color (named tokens — use these hex values)

| Token | Value | Usage |
| --- | --- | --- |
| Paper | `#F4F6F3` | Page background |
| Porcelain | `#FBFCFB` | Cards, top bar, panels |
| Ink | `#1B2420` | Primary text |
| Muted | `#5C6B64` | Secondary text |
| Celadon | `#3D6B5A` | Primary buttons, active, focus ring |
| Celadon Soft | `rgba(61,107,90,.08)` | Hover / selected wash |
| Bronze | `#8A6A3D` | Seal only |
| Hairline | `rgba(27,36,32,.09)` | Borders |
| Canvas | `#EEF1EE` | Classroom stage / work area behind the slide |

Rules:

- Celadon is the **interaction accent**, not a wallpaper.
- **No purple / violet / indigo in product UI.** Purple may appear only inside AI-generated slide content.
- No purple glow, no large glassmorphism glow, no pink announcement bars.

---

## Typography

- Brand + page H1: `Noto Serif SC` (display). Use sparingly — wordmark, Home headline, empty-state title.
- Product UI (nav, buttons, settings, labels, body): `Inter` + CJK fallback.
- Slide interior: do not restyle; keep whatever the course generated.
- Do **not** set the entire UI in Song/serif.

Scale (desktop):

- Wordmark: 22px / semibold
- Page title in top bar: 15–16px / medium Inter, Ink
- Section title: 13px / medium Inter
- Body: 13–14px / regular Inter
- Meta / captions: 12px / Muted
- Scene numbers: 12px tabular, current scene bold Ink

---

## Radius

| Level | Radius |
| --- | --- |
| Small button / chip | 8px |
| Input / tool group | 10–12px |
| Card | 14px |
| Large panel / dialog | 16px |
| Composer | 18px |

Avoid OpenMAIC full-pill (`rounded-full`) chrome. Playback icon buttons may be circular. Top-bar utilities are **rounded-md squares**, not a single giant pill cluster.

---

## Shadow

Only this pair:

```css
0 1px 2px rgba(20,30,25,.04),
0 8px 24px rgba(20,30,25,.05)
```

No purple glow. No large bloom. No heavy frosted floating layers.

---

## Motion

- Page enter: opacity + 8px rise, 180–240ms
- Panel open: 180–220ms
- Scene rail expand: 200ms
- Hover: 120–160ms
- Dialog: 160–200ms

Forbidden: bounce, colored glow pulse, infinite sparkle, large scale animation.

---

## Unified App Shell — QingjinAppShell

Height **52px** (Home currently 56px; Round 2 target 52px). Full width. Porcelain / 72% + light blur + bottom Hairline.

```
┌────────────────────────────────────────────────────────────┐
│ [衿] 青衿          当前课程 / 当前页面          EN  ⚙  ⋯   │  52px
├────────────────────────────────────────────────────────────┤
│                      Page Content                           │
└────────────────────────────────────────────────────────────┘
```

Top bar contains **only** global actions:

- Brand lockup (left)
- Current course / page title (center-left, after a back chevron when nested)
- Language, Settings, Share/Export (course pages only)

Do not dump every control into one right-side capsule.

---

## Classroom — three-column workbench (P0)

This is the primary Round 2 screen. Desktop >1280:

```
┌──────────────────────────────────────────────────────────────────────┐
│ [衿] 青衿   ←  课程导览                              EN  分享  ⚙   │
├──────────┬───────────────────────────────────────┬───────────────────┤
│ Scene    │                                       │ 课堂互动          │
│ Rail     │               Slide                   │ ● 进行中          │
│ 72px     │               Canvas                  │ 讲解 | 讨论 | 角色│
│ 01       │               16:9                    │                   │
│ 02*      │               max 1100px              │ AI 教师 · Dr. Aris│
│ 03       │               14px radius             │ 讲解卡片          │
│          │               Hairline + soft shadow  │                   │
├──────────┴───────────────────────────────────────┴───────────────────┤
│  1 / 10       ◀    ▶    播放    1×    ↻    ✎ 编辑            ⛶     │ 48px
└──────────────────────────────────────────────────────────────────────┘
```

### Scene Rail

- Collapsed 72px; expanded 220px.
- Collapsed: stacked scene numbers `01 02 03`.
- Current scene: 3px Celadon left indicator + Celadon Soft wash + bold number.
- Expanded: thumbnail + title + page number.
- Canvas around the slide: `#EEF1EE`. Slide ↔ container gap 20–28px.
- Center play overlay: translucent Porcelain circle, Celadon icon, slight shadow. Hover emphasis only. **Not purple. Not glowing.**

### 课堂互动 panel (300–340px)

Header: `课堂互动` + green live dot `进行中`.
Tabs: `讲解 | 讨论 | 角色`.
- 讲解: avatar + name + compact speech card (not a giant IM bubble) + play-voice.
- 讨论: classroom chat, assistant-notes tone (not WeChat).
- 角色: roster with status (正在讲解 / 等待).
- Collapses to 44px rail.

### Playback bar

Porcelain, top Hairline, 48px. Transport grouped in the center. Page index left. Edit + fullscreen right.

### What Classroom must NOT look like

- OpenMAIC 80px transparent header with “CURRENT SCENE” eyebrow
- 192px bottom Roundtable speech capsule
- Purple play glow on the slide
- Floating white/zinc pill cluster in the top-right
- OpenMAIC horizontal cube logo in the scene rail

---

## Generation Preview — generation console (P0)

Not a waiting spinner card. Split console:

```
┌──────────────────────────────────────────────────────────────┐
│ [衿] 青衿     正在生成 · 数字电路基础              取消      │
├──────────────────────────┬───────────────────────────────────┤
│ 课程生成                 │  当前生成内容 Preview             │
│ ● 解析需求      完成     │  ┌─────────────────────┐          │
│ ● 生成课程大纲  完成     │  │   Scene Preview     │          │
│ ● 创建 AI 教师  完成     │  └─────────────────────┘          │
│ ◉ 生成 Scene 3  进行中   │  Scene 3 · 模拟电路               │
│ ○ 生成媒体      等待     │                                   │
│ 6 / 10 Scene             │                                   │
└──────────────────────────┴───────────────────────────────────┘
```

Timeline states: completed = Celadon check; active = thin spinner / progress line; pending = Muted; failed = red + retry.
Finished state (must be visible, not an instant redirect):

```
课程已准备好
10 个教学场景 · 4 位 AI 角色
[进入课堂]   ← Celadon CTA
```

No pulsing blue/purple blobs. No Sparkles-as-brand.

---

## Chat

- AI messages: no traditional bubble — avatar + text on a subtle Porcelain surface.
- User messages: right-aligned light celadon wash `rgba(61,107,90,.08)`.
- Composer: Porcelain, 1px Hairline, 16–18px radius, Celadon focus ring. Placeholder `向老师提问…`. Mic + send.

Tone: classroom record / teaching assistant — not an IM app.

---

## Settings

Dialog 900–980px wide, max-height 80–85vh. Left nav 180–200px: 通用 / 模型与服务 / 语音 / 图像 / 智能体 / 文档 / 高级. Right pane scrolls. Each block = title + one-line description + hairline + control. Close is a quiet ×, not a giant footer-only action.

---

## Loading / empty / error

Loading: bronze seal + `正在准备课堂…` + Celadon spinner.
Not found:

```
课程不在这里
它可能已被删除，或链接已经失效。
[返回青衿]
```

No generic shadcn empty illustration.

---

## Signature

The memorable thing is the **classroom workbench**: numbered scene rail + paper canvas slide + 课堂互动 column + a real 48px playback bar — all under the bronze 衿 lockup. Quiet, scholarly, celadon-only accents. Everything else stays disciplined so the slide remains the hero of the center column.
