---
name: k12-core-literacy-planning
title: "核心素养教学设计"
description: "Design one zhiyu classroom around Chinese K-12 core literacy and authentic performance tasks. Use for 中小学课程、核心素养、素养导向、2022 课标、真实情境、任务群、表现性评价 across primary, junior-high, and senior-high subjects, rather than a content-delivery-only lesson."
---

# K-12 core-literacy classroom design

Design or reshape **one persisted OpenMAIC stage** around the Chinese curriculum
standards' core-literacy model. The deliverable is the classroom itself: pages,
roles, learner activity, assessment evidence and narration written into the
stage. Do not produce a Word lesson plan, a `lesson.json`, HTML, or instructions
for running local render scripts.

The invariant is:

**authentic context → performance task → learning activity → observable evidence → transfer**

`stage-design` still governs the durable submission boundary for a new complete
course. This skill governs the pedagogy and the information carried in every
planned page. If the stage already has pages, edit it surgically under the
`pro-editing` rules; do not create a duplicate stage.

## Ground the lesson before planning

Before proposing pages, determine the subject and school stage. Then use the
native `read` tool to load both:

1. [`references/core-literacy.md`](references/core-literacy.md), always;
2. exactly one matching subject guide:
   - Chinese / languages: [`references/subjects/languages.md`](references/subjects/languages.md)
   - mathematics: [`references/subjects/mathematics.md`](references/subjects/mathematics.md)
   - science / physics / chemistry / biology: [`references/subjects/science.md`](references/subjects/science.md)
   - history / geography / morality and law / politics: [`references/subjects/humanities.md`](references/subjects/humanities.md)
   - IT / arts / PE and health / labor: the matching section in `core-literacy.md`

Loading the relevant reference is mandatory. Do not rely on a remembered
dimension name when the reference distinguishes compulsory and senior-high
wording.

If grade or topic is genuinely unknown, ask at most two load-bearing questions
in one `ask_user` call. Default the rest to 45 minutes, general curriculum
quality expectations and UDL support. Never ask again for information already
present in the request or attached material.

If the teacher names a textbook edition, standard clause or supplied material,
align to it. Otherwise use general curriculum wording and say the lesson is not
aligned to a specific textbook edition. Never invent a standard number, quote
or material fact.

## Settle the learning contract

Choose only **one or two** primary literacy dimensions for one lesson. State
the contract in this form before the page list:

> Students will **do X** in order to make **literacy dimension Y** observable
> through **evidence Z**.

Weak targets such as “understand”, “master” and “cultivate thinking” are not a
contract. Use visible verbs: annotate, model, compare, justify, test, revise,
design, decide, create or present.

The authentic context must carry all the way through the lesson:

- it creates the opening problem;
- learners use it in the central task;
- assessment returns to it with a new case or changed condition.

A story discarded after page 1 is decoration, not context. A normal exercise
with a person's name pasted on it is not an authentic problem.

## Plan pages around learner work

Default to 6–10 pages for a 45-minute lesson, but do not treat that range as a
hard page cap. Each proposed page includes `title`, `type`, `brief`, the learner
action, the evidence collected and its link to adjacent pages.

A useful default arc is:

1. `slide`: the authentic situation, the unresolved question and the final task;
2. `interactive` or evidence page: observe, manipulate, read, map or collect evidence;
3. `interactive` or `slide`: compare, classify, model, closely read or reason;
4. `quiz`: diagnose the most likely misconception and require a reason;
5. `interactive`, `pbl` or task page: produce the main explanation, model,
   decision, text, design or performance;
6. `slide`: success criteria, scaffold, worked fragment or peer-review method;
7. `quiz` or task page: transfer into a new version of the same context;
8. optional closing `slide`: consolidate the method learners established and
   name what remains open.

Choose the page type by the learning action:

- `slide` frames a problem, carries source material or evidence, or consolidates
  a method. It must not become a run of teacher exposition.
- `interactive` is for changing a variable, tracing a structure, running code,
  repeated rule-bound decisions or spatial inspection. One interactive page
  carries one mechanism and says what changes, what is observed and what the
  observation establishes.
- `quiz` diagnoses a misconception, compares explanations or checks transfer.
  Distractors come from real misconceptions and feedback teaches, not merely
  marks wrong.
- `pbl` is for a genuinely multi-step inquiry, artifact or public performance.
  Do not wrap one simple exercise in PBL machinery.

Titles name what learners discover or make: 「拖动倾角，看射程怎么变」,
「两份史料为什么说得不一样」, 「给校园开放日改写导览词」. Do not use
「概念介绍」「知识讲解」「案例分析」「课堂总结」.

## New complete-course submission

After the teacher approves the page plan through `ask_user`, call
`submit_course_generation` exactly once:

1. Put the learning contract, audience, grade, scope, and authentic performance
   task in `requirement`; put the settled title and classroom language in
   `courseTitle` and `languageDirective`.
2. Pass the complete ordered plan in `outlines`. Each
   `outlines[].description` states the target literacy dimension, visible
   learner action, evidence or source, misconception and scaffold, assessment
   evidence, grade-appropriate register, and handoff. Each
   `outlines[].keyPoints` contains only verified material facts and concrete
   page constraints.
3. Put `k12-core-literacy-planning` and every other active generation skill in
   `skillIds`. Put curriculum/source provenance, alignment limits, and unresolved
   uncertainty in `researchContext`.
4. If a custom cast is deliberately settled, pass complete `agents` with
   exactly one teacher. The teacher persona embodies the subject method; another
   role surfaces a typical misconception or asks for evidence. Otherwise omit
   `agents` so the worker chooses and freezes the roster. Pass `folderId` when
   this lesson belongs to a series.

The generation worker owns persistence, pages, narration, media, and final
checks after submission. Use `get_course_generation_status` for one observation
when requested or after reconnecting. Do not busy-wait or poll in a loop, and
do not manually continue generation after an accepted job.

The durable boundary does not affect focused operations: a single-page or
existing-course edit follows `pro-editing`, and an original PPT import follows
`pptx-import` without replanning the imported deck.

## Existing-stage adaptation

When the current stage already has pages:

1. `list_scenes`, then `read_stage` the relevant pages before writing.
2. Audit subject/stage wording, context continuity, learner product, evidence,
   misconception handling, assessment alignment and narration.
3. Repair only the pages that break the contract. Prioritize decorative
   contexts, conclusions revealed before inquiry, no observable learner
   product, activity/assessment mismatch, wrong school-stage difficulty,
   literacy labels with no evidence, and exit tickets that collapse into recall.
4. Use `patch_stage` for narrow edits and `edit_deck` for page-list changes.
   Regenerate a whole page only when the user explicitly wants a rewrite.
5. Re-run `generate_tts` after speech changes, then read back touched pages and
   `list_scenes` for the final structure.

## Universal non-negotiables

- Learners do the cognitive work. The teacher supplies phenomena, sources,
  questions, models and scaffolds without announcing the conclusion first.
- The main task itself yields assessment evidence. The exit task uses a new
  case with the same reasoning or production structure.
- Primary school favors concrete manipulation, experience and short language;
  junior high favors concepts, evidence and explicit reasoning; senior high
  favors systems, models, multiple sources and justified value decisions.
- Include at least one visual or structural scaffold, one language-expression
  scaffold and one extension for learners ready for greater challenge.
- Create original cases, questions and activities. Textbooks and uploaded
  sources determine scope and facts, not learner-facing copy to reproduce.

## Completion check

Do not call the classroom done until all are true:

- the subject and school stage use the correct curriculum dimension wording;
- one or two dimensions appear as learner actions and observable evidence;
- the authentic context survives from opening through task to transfer;
- every approved page exists, has content and sits in the right order;
- learners acquire, process or compare evidence at least once;
- learners produce at least one explanation, model, text, design, decision,
  performance or other inspectable artifact;
- the central misconception is handled by an activity or quiz;
- assessment is isomorphic to the learning task and includes transfer;
- narration matches page content and every required speech line has audio;
- no curriculum quote, textbook edition, source fact or external lookup result
  was fabricated.

Close in one or two sentences: name the primary literacy dimensions and the
performance task that now makes them visible. Do not replay the whole page list.
