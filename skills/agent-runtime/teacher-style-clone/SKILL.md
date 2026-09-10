---
name: teacher-style-clone
title: "名师风格"
description: zhiyu 工作台会话中挂载了教师课堂录像或讲义，且需要提炼并迁移教师的表达方式、教学节奏与讲解习惯时使用。
---

# Teacher style extraction and transfer

Extract how the teacher teaches, then teach the user's requested topic in that
style. The source material is evidence about delivery and presentation; it is
not automatically factual source material for the new course.

The learner-facing name for this mode is 「名师风格」. Never expose the words
"clone" or "style transfer" to the learner. The result should simply feel like
a lesson taught in the evidenced style.

## Step 1 — confirm every derivative is ready

Call `list_materials` before drawing conclusions. Identify the attached source
materials and confirm extraction is complete. For recordings, verify that the
session exposes the transcript and keyframe derivatives. If extraction is idle,
call `extract_material` first; if it is pending or running, call
`wait_for_materials` and list again; if it failed, tell the user what failed instead
of inventing a profile from incomplete evidence.

## Step 2 — read the whole transcript in order

Use `read_material` to page through every transcript derivative from offset 0
to the final page. Do not sample only the beginning. As you read, build a
compact style profile in your reasoning covering:

- openings and transitions;
- catchphrases, address terms, and sentence rhythm;
- concrete-versus-abstract example habits;
- pacing, recaps, rhetorical questions, pauses, and humor;
- what is said aloud versus emphasized visually.

Support each claim with short transcript evidence and its timestamp. Frequency
and distribution matter: distinguish a repeated habit from a phrase used once.

## Step 3 — inspect keyframes for visual style

When the transcript contains a `[keyframe@mm:ss](mat_xxx)` marker, sample the
referenced frame with `read_material`. Use frames across the recording rather
than adjacent duplicates. Record visual evidence such as board-writing density,
slide composition, hierarchy, color use, teacher position, gestures, and the
relationship between speech and what remains on screen.

Do not infer visual style when the recording has no readable keyframes.

## Step 4 — verify hypotheses with search

Use `search_material` to test specific transcript hypotheses after the full
read. Search catchphrases and recurring sentence forms, compare their frequency,
and revisit the surrounding snippets. Search verifies a proposed pattern; it
never replaces reading the transcript in order.

Treat unsupported or contradicted hypotheses as absent from the final profile.

## Step 5 — transfer the profile into generation inputs

Plan the complete course in the Pro conversation, then call
`submit_course_generation` exactly once. Put `teacher-style-clone` in
`skillIds`, the requested subject and transfer boundary in `requirement`, and
the settled title and language in `courseTitle` and `languageDirective`.

Map the compact, evidence-backed style profile and its transcript/keyframe
provenance to `researchContext`. For every item in `outlines`, put the concrete
teaching and presentation directions in `outlines[].description`: opening
ritual, phrasing habits, example pattern, pacing, interaction rhythm, and
visual presentation. Put independently verified subject facts and the relevant
timestamped style evidence in `outlines[].keyPoints`. Do not merely refer to a
profile by name.

If the teacher-style cast is deliberately fixed, pass complete `agents` and
encode delivery in `agents[].persona` and `agents[].voiceConfig`; otherwise
omit it and let the worker choose and freeze the roster. Pass `folderId` when
the course belongs to a series.

After submission, use `get_course_generation_status` for one observation when
needed. Do not busy-wait or poll in a loop, and do not manually continue page
generation after an accepted job.

This is the boundary for a new complete course. A single-page or
existing-course edit keeps the `pro-editing` path. An original PPT import keeps
the `pptx-import` path and is not rebuilt as a newly generated deck.

## Hard rules

- Clone the evidenced style, not the teacher's identity. Never fabricate
  biography, opinions, endorsements, or personal claims.
- Keep the requested topic factually correct on its own terms. Do not import
  unrelated claims from the lecture just because they appear in the transcript.
- The source topic appears in the learner-facing course only when the user asks
  for that topic.
- Every style claim needs transcript or keyframe evidence. Omit guesses.
