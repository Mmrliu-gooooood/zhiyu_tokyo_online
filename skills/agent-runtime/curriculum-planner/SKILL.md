---
name: curriculum-planner
title: "系列课规划"
description: Plan a connected zhiyu course series, from 「7 天学 Python」 to onboarding tracks, semester units, or one lesson per book chapter. It clarifies the brief, gets the user's explicit sign-off on the full lesson list before spending anything, then builds stages one by one in a shared folder. Use for a sequence of classrooms, not one oversized stage.
---

# Planning and building a stage series

A series is many stages — many classrooms — that a learner takes in order. The
unit of work is still one stage, and `stage-design` governs how each one is
built. Three things are yours and only yours: getting the brief straight,
getting the user's sign-off on the whole list, and carrying the series from the
first stage to the last without losing the thread.

Your tools for the series layer are `create_folder`,
`submit_course_generation`, `get_course_generation_status`,
`list_folder_stages`, `read_stage_outline`, and `ask_user`. Use
`move_to_folder` only to repair the filing of an existing stage. Material and
research tools may prepare evidence before submission; the generation worker
owns every new complete lesson after submission.

## `ask_user` ends the run

Calling `ask_user` turns the user's composer into a question form and **stops
this run**. Their answer starts the next one, with the conversation intact. Two
consequences shape how you clarify:

- **One round is one call.** Everything you are asking at this point goes into a
  single `ask_user` — two calls back to back is two waits for one round of
  questions, and the second card lands on a user who is still reading the first.
- **The rounds themselves are sequential, on purpose.** What you ask second
  depends on what they answered first: you cannot offer 「案例领域偏好：生活化小
  工具 / 办公自动化 / 小游戏」 before you know they have never written code. Two
  or three rounds that each build on the last are how someone who knows the
  subject takes a brief; one giant form is a questionnaire.

## Gate 1 — Clarify, in rounds

A series request is almost always underdetermined. A single sentence like
「7 天学 Python」 fixes the topic and the lesson count and leaves open everything
that decides what the lessons actually contain. Work through it in **two or three
rounds**, one `ask_user` per round, each round narrower than the one before.

**Round 1 — where this lands.** The two or three things nothing else can be
decided without:

- **who the learner is** — absolute beginner, someone who codes in another
  language, a team with mixed levels;
- **what they want out of it** — a working script of their own, an exam they have
  to pass, a concept they can hold up in a meeting.

Put the example inside the option label: 「完全零基础，没写过一行代码」 tells the
user what you mean by beginner, 「初级」 makes them guess.

**Round 2 — the shape, fitted to Round 1's answers.** Now ask what Round 1 made
askable: how long one session is, the pace, the language of instruction, how
hands-on it should be. **Build the options out of what they just told you** —
「零基础」 turns into 「案例领域偏好：生活化小工具 / 办公自动化 / 小游戏」, and
「平时写 Java」 turns into 「从 Python 与 Java 的差异切入，还是从语法从头讲一遍」.
An option set that could have been written before their answer is the giveaway
that this is a form and not a conversation.

**Round 3 — the edges, and only when they are real.** Whether a book, syllabus or
deck they already have should be the source the series is built from; how much
checking they want (a quiz per lesson, one at the end, none). Skip this round
whenever neither question would change the plan.

Rules that hold for every round:

- **At most three big things per round.** A round carrying six questions is the
  giant form again, wearing three hats.
- **Open each round by saying what you took from the last one.** «既然是零基础、
  每天 30 分钟，我把每课压到一个当天能跑起来的小工具» — the user has to see their
  answer being used. This is the whole reason several rounds read as professional
  rather than slow: a round that does not visibly consume the previous answers is
  just a second form.
- **Never ask what you already know.** Anything the request settled, or that you
  can safely default, is **stated as your decision for them to overrule** rather
  than asked: 「默认中文讲授、每课 30 分钟，要改直接说」 costs no round at all.
- **Two or three rounds, not four.** Opening a round to ask something you could
  have decided yourself is padding, and padding reads as stalling, not as care.
  When the next round has nothing load-bearing left in it, go to Gate 2.

**The question IS the tool call, never the text.** Writing the questions into
chat prose is not asking: the user gets no answer form, only a turn that ended
in a paragraph, and nothing to answer with. Two patterns are banned outright —
listing the questions in narration instead of calling the tool («为确保安排合适，
请一次确认以下信息：…» followed by no `ask_user`, which is exactly how this gate
fails), and narrating the question before asking it. The sentence you write
before the gate says what you are about to do; it must not contain a question
mark, and it must not preview the questions themselves.

When the request is already specific enough — the user described the audience
and the shape they want, or attached the syllabus — skip this gate. Go straight
to a proposal and let Gate 2 be the one place they confirm.

## Gate 2 — The confirmation gate

**Never start building before the user has signed off on the full series.** A
series of seven stages is seven times the work of one stage; the user has to
see the whole plan before anything is built. This is its own
round, after the clarification rounds are done — never folded into one of them,
because a plan proposed before the answers are in is a plan built on guesses.

Present, in the chat, before any stage exists:

- the **series title** and the **number of stages**;
- **every stage, one line each**: its title and, in a clause, what it is for and
  what the learner can do at the end of it;
- anything you decided for them that they might disagree with — the level you
  pitched it at, the order, what you deliberately left out.

Then call `ask_user` for an explicit go, and offer the obvious alternatives to
a plain yes: change the count, reorder, drop or add a lesson, adjust the level.
A silent or ambiguous answer is not a go. If they change something, show the
revised list and ask again — a second confirmation round is far cheaper than
seven stages built to the wrong brief.

The list above belongs in the chat — it is what the user reads. **The ask does
not.** The go is an `ask_user` call with those alternatives as its options; a
turn that presents the list and then asks «可以开始吗？» in prose ends with no
way to answer, and treating that silence as consent is the one thing this gate
exists to prevent. Same rule as Gate 1: no question mark in the narration, and
no preview of the question you are about to ask.

## Designing the series

- **Progression.** Each stage opens where the previous one closed. What is
  assumed to be known must have been taught, in an earlier stage, in a form the
  learner will recognize.
- **Self-contained lessons.** Every stage must stand on its own as a class: a
  learner who takes only day 4 gets a complete lesson with its own opening, its
  own payoff, and enough framing to make sense. A lesson that only works as the
  continuation of another is not a lesson, it is half of one.
- **Review hooks.** From the second stage on, open by reactivating what the
  learner needs from earlier — briefly, and as use rather than repetition:
  apply the earlier idea to the new problem instead of restating it.
- **Difficulty curve.** Difficulty rises steadily and never jumps. Watch for the
  usual failure: three easy lessons, then one that carries the whole hard part.
  If one lesson is doing too much, split it and say so at Gate 2 — the lesson
  count is a proposal, not a constraint the user imposed.
- **Titles that say what the lesson does**, in the series' own language, so the
  folder reads as a curriculum: 「第 3 天：把重复的活写成函数」 rather than
  「Python 基础（三）」.

## Durable series execution

Once you have the go:

1. Call `create_folder` for the series, named as the user would name it.
2. Prepare the first lesson completely in the Pro conversation, then call
   `submit_course_generation` once for that lesson. Map its learning contract
   to `requirement`, title to `courseTitle`, language to
   `languageDirective`, ordered page plan to `outlines`, active pedagogy to
   `skillIds`, evidence and continuity notes to `researchContext`, a deliberate
   custom cast to `agents`, and the series folder to `folderId`.
3. The per-page mapping is explicit: teaching/style/activity intent goes in
   `outlines[].description`; verified source facts and page-specific
   constraints go in `outlines[].keyPoints`.
4. Observe the submitted lesson later with `get_course_generation_status`.
   Do not busy-wait or poll in a loop. Submit the next lesson only after a
   status observation shows the prior lesson completed; this respects durable
   admission instead of manufacturing a synchronous series loop.
5. Before submitting a lesson that builds on an earlier completed one, use
   `read_stage_outline` on that earlier stage. Read what was actually built,
   not only what was planned, and carry the continuity delta into the next
   lesson's `researchContext` and page descriptions.
6. Use `list_folder_stages` to check which completed stages exist and their
   order. Because each submit carries `folderId`, new stages are filed by the
   worker. Use `move_to_folder` only as a narrow repair for an existing stage
   whose filing is already wrong.

## Long-run context discipline

A series is a long conversation, and everything you write stays in it. Your
per-lesson recap is the series' memory: keep it about the lesson — what it
teaches, what it assumed, what it left for later. Do not replay tool detail
(page counts per call, ids, which tool returned what); do not re-quote outlines
you already summarized; do not restate the whole series plan at every step. If
you need a detail from an earlier lesson, read it back with `read_stage_outline`
or `list_folder_stages` instead of keeping it alive by repetition.

## When something fails

One failed job does not erase a series. Preserve the reported evidence and
state. If the status says an external result is unknown or needs attention, do
not retry blindly; report the affected lesson and wait for an explicit safe
decision. Never restart the series or silently drop a lesson from the approved
plan.

This durable whole-course path does not replace focused operations. A
single-page or existing-course edit follows `pro-editing`; an original PPT
import follows `pptx-import` and preserves the imported deck.

## Finishing

Close with:

- the **folder link**, so the user lands on the series;
- a short **series summary**: the lessons that were built, in order;
- the **rework list** — anything that failed or that you would build differently
  — or a sentence saying there is none.

## Related skills

`stage-design` governs each individual stage; this skill adds the layer above it
and never replaces it — read both. If a lesson in the series has a shape of its
own — hands-on, vocational, research-backed — the matching topic skill applies
inside that stage. And if the subject rests on facts you would have to verify
rather than recall, run `deep-research` BEFORE Gate 2, not after: a series plan
the user approved is a plan you then have to build.
