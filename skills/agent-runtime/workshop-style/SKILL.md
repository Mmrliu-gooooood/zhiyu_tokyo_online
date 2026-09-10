---
name: workshop-style
title: "互动工作坊"
description: "Run a zhiyu workshop in which learners do more than watch: frequent exercises or checks, short task-setting slides, question-led narration, and a small closing project. Use for a workshop, bootcamp, 「动手」「实操」「练中学」 or 「边做边学」; choose `lecture-style` for systematic explanation and `vocational` for safety-gated occupational procedures."
---

# Workshop design

You are designing a **workshop**. Nothing is explained for longer than it takes
to set up the next thing the learner does, and every idea is followed
immediately by a page where they try it. The learner leaves having built
something, not having been told about it.

`stage-design` still governs the whole-course boundary: plan here, submit once
to the durable generation worker, and observe later. This skill governs what
the course contains and how it sounds.

## The shape

- **Scene 1 is a `slide`, and it is short**: what the learner will have made by
  the end, and the first thing they are about to try. No agenda, no history of
  the field.
- **Every concept is followed at once by a hands-on page.** The rhythm is
  concept → do it, concept → do it: roughly **one `interactive` or `quiz` page
  for every two pages** in the course. If two explanatory pages ever sit next to
  each other, one of them is unnecessary.
- **`interactive` pages are the exercises.** Each isolates one thing to build,
  vary or trace. Consecutive interactive pages must not reuse the same
  `widgetType` — as the learner moves from trying to predicting to applying, the
  modality moves with them.
- **`quiz` pages are quick self-checks**, not exams — placed right after a
  hands-on page to make the learner state what they just observed. Short, two or
  three questions.
- **The last page is a small integrating project**: one `interactive` page whose
  task needs several of the workshop's pieces at once, with the earlier
  exercises as its parts. Not a summary slide. This is the page the learner
  screenshots afterwards.

## Slides are task briefs

A slide in a workshop exists to make the next exercise possible. Keep it to
**two or three `keyPoints`** — the rule, the shape, the one gotcha — and put
everything else in the exercise. A workshop slide that could be read on its own
as a lesson is too long: cut it and let the interactive page teach.

## widgetOutline

Every `interactive` page must carry a populated `widgetOutline`, always
including `concept` — the one thing this exercise is about. An interactive page
with an empty widget outline degrades into a generic page, which in this style
takes the course's whole point with it.

- `simulation`: `concept`, `keyVariables` (the actual things the learner moves)
- `code`: `concept`, `language`
- `diagram`: `concept`, `diagramType`, `nodes`
- `game`: `concept`, `gameType`, `challenge`, `playerControls`
- `visualization3d`: `concept`, `visualizationType`, `objects`, `interactions`

`keyPoints` on an interactive page describe **the task and what doing it
reveals** — what the learner changes, what they should notice, what conclusion
that forces. Not facts to be read aloud.

## Narration is facilitation

This is where the style is heard, so it is the part to get right.

- Lines are **short — one or two sentences**. Nobody in a workshop listens to a
  paragraph while a task is waiting on screen.
- **Ask more than you tell.** Most narration lines on a hands-on page are
  questions or instructions: 「先把这个值调到最大，看看会发生什么」「你觉得下一步
  会往哪边偏？」「试完再往下看。」 Statements are reserved for the moment after
  the learner has already seen the effect.
- **Hand the work over and get out of the way.** Say what to do, then stop. A
  narration that explains the answer before the exercise runs has cancelled the
  exercise.
- **Two voices, in dialogue.** The teacher sets the task; the assistant
  co-facilitator reacts, tries the wrong thing on the learner's behalf, or asks
  what everybody is wondering. Alternating short turns, not monologue.
- Encouragement is fine and belongs after an attempt, tied to something
  specific — 「注意你刚才那一下，曲线立刻翻过去了」 rather than 「太棒了」.

## The roster

The runtime allows **exactly one teacher**, so the dialogic pair is a lead
teacher plus a co-facilitator `assistant` — not two teachers. If this cast is
deliberately fixed, pass complete entries in `agents`: a hands-on practitioner
who talks in tasks and an assistant who is warm, quick and unafraid to be wrong
out loud. Put 「short turns, question-first, encouraging」 in their `persona`
fields, then bind only a valid `voiceConfig` returned by the session voice
directory. Otherwise omit `agents` and let the worker choose and freeze the
roster.

## Carrying the style into submission

Plan the entire workshop in the Pro conversation, then call
`submit_course_generation` exactly once. Pass `workshop-style` in `skillIds` so
its structural constraints are enforced. Also make the concrete intent visible
to the worker:

- put concept → exercise cadence, the learner action, widget intent, and the
  closing project into each page's `outlines[].description`;
- put verified material facts plus page-specific short, question-first
  narration directions in `outlines[].keyPoints`;
- put the two-voice facilitation manner into each custom `agents[].persona` and
  its pacing into `agents[].voiceConfig`, when using a custom cast;
- put source boundaries and cross-page evidence notes in `researchContext`, and
  set `courseTitle` and `languageDirective` explicitly when settled.

After submission, use `get_course_generation_status` for one observation when
needed. Do not busy-wait or poll in a loop, and do not manually continue page
generation after an accepted job.

This rule is only for a new complete course. A single-page or existing-course
edit keeps the `pro-editing` path, and an original PPT import keeps the
`pptx-import` path.

## Scene naming

Titles name what the learner does, in the imperative.

- Good: 「把这段循环改成能跑的」「调参数，找出它崩掉的那一刻」「用今天的三块拼一个
  能用的小工具」
- Bad: 「循环的概念」「参数敏感性分析」「综合练习」

## If the request is not a workshop

If the subject has nothing to practise — a historical narrative, an appreciation
course, a body of knowledge the learner only needs to understand — say so in one
sentence and use `lecture-style` instead. Bolting exercises onto a topic with no
task produces busywork, which learners recognize faster than anything else.
