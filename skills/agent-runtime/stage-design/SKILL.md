---
name: stage-design
title: "课堂设计"
description: The baseline zhiyu method for planning and submitting one new complete classroom course. Use beneath topic-specific course skills. Do NOT use as the procedure for single-page edits, existing-course repairs, or original PPT imports; those keep their dedicated edit/import paths.
---

# Building one complete course

A stage is one classroom: one settled plan, one roster, one deck of pages. A
topic skill (`deep-interactive`, `vocational`, `deep-research`,
`teacher-style-clone`, …) shapes what the course contains. This skill owns the
boundary between Pro planning and durable generation.

## Whole-course boundary

For a **new complete course**, finish planning, research, style decisions, and
material grounding in the Pro conversation. Then call
`submit_course_generation` exactly once. The generation worker owns stage
creation, roster creation, page generation, media generation, checkpoints, and
the final database state. The synchronous `create_stage` / `generate_scene`
whole-course path is forbidden.

After a successful submission, do not create or repair pages in the same run.
Use `get_course_generation_status` for one observation when the user asks,
after reconnecting, or when deciding whether later work may start. Do not
busy-wait or poll in a loop. A queued or running result means the worker still
owns the course; report that state and yield.

## Plan before submitting

Build the complete page plan in the conversation. Each planned page has a
stable `id`, unique integer `order`, `title`, `type` (`slide` / `quiz` /
`interactive` / `pbl`), a self-contained teaching description, grounded key
points, and an optional language note. Apply every active topic skill while
planning, before submission.

Use `ask_user` only when the Pro workflow or the user explicitly requires a
decision. Do not add an automatic-mode outline review gate.

## Map intent into the submit call

Do not leave load-bearing decisions only in chat. Map them into
`submit_course_generation`:

| Planned intent | Submit parameter |
| --- | --- |
| Complete learning goal, audience, scope, exclusions, and acceptance criteria | `requirement` |
| Settled course name | `courseTitle` |
| Course-wide language and register | `languageDirective` |
| Ordered page plan | `outlines` |
| Per-page teaching intent, activity, narration/style direction, and handoff | `outlines[].description` |
| Verified material facts, citations, examples, and page-specific constraints | `outlines[].keyPoints` |
| A page-specific language exception | `outlines[].languageNote` |
| Full custom cast, only when it is deliberately settled | `agents` |
| Every active installed generation skill, including guidance-only skills | `skillIds` (requires `outlines`) |
| Research ledger, source boundaries, conflicts, and unresolved uncertainty | `researchContext` |
| Destination series folder | `folderId` |

Every `agents` entry must be complete: stable id, name, role, concrete persona,
and optional `voice` copied exactly from `list_voices` (or a matching valid
`voiceConfig`). Platform identity/revision is filled from the fixed session snapshot;
never invent these fields. If both voice forms are supplied, they must agree.
IDs must be unique and the roster must contain exactly one teacher (1–10 agents).
If the cast is not deliberately fixed, omit `agents`; the worker will
choose and freeze an automatic roster. Do not pass a desired count as a
substitute for a roster.

Put skill ids in `skillIds`, not merely in prose. Put the skill's page-level
effects into each relevant `outlines[].description` and
`outlines[].keyPoints` as well. Installed skills with machine constraints (such
as `lecture-style`) enable structural validation before submission and again
in the worker. Guidance-only skills (such as `stage-design`) remain valid IDs;
their teaching effects travel in the page fields. Unknown/inaccessible IDs are
rejected individually. Do not remove all skills to work around a single invalid
ID, and do not submit skillIds without a complete page plan.

For any selected built-in skill with an `outline-constraints.json` resource,
read that file alongside its `SKILL.md` before submitting (for example,
`lecture-style/outline-constraints.json`). Check the complete page count,
allowed types and type mix against it, including short courses. The prose
describes teaching style; the JSON defines the enforced structural limits.
Keep the user's requested page count when a valid mix fits it.

If submission is refused, no job exists yet. Repair all reported fields and
resubmit the full plan with complete page objects, not an incremental patch.
Prefer description/keyPoints/languageNote; brief/materialFacts/language are
compatibility aliases, not additional fields for different content. Do not
call get_course_generation_status or retry_course_generation
until submission succeeds.

For a deliberate whole-course replacement, also pass `targetStageId`, the
observed `targetRevision`, and explicit `replaceExisting`. Never turn a narrow
edit into a replacement job.

## Paths that stay synchronous

This whole-course rule does not block focused work:

- Use `pro-editing` for a single-page edit or a narrow repair to an existing
  course. Read before patching, verify the changed page, and regenerate audio
  only when its speech text changed.
- Use `pptx-import` for an original PPT import. Preserve the imported deck and
  follow that skill's inspection and repair sequence; do not re-plan it as a
  newly generated course.
- Use the existing page tools when the user explicitly asks to insert or
  rewrite one page in an existing course. This is not a new complete-course
  generation run.

When an edit changes narration with `patch_stage` under `/actions/...`, call
`generate_tts` for that changed page. This edit rule does not authorize manual
post-processing of a submitted whole-course job.

## Completion

Submission is complete when the tool returns an accepted durable job. Course
generation is complete only when a later `get_course_generation_status`
observation reports a terminal completed state. Preserve failure evidence; if
an external result is unknown, report the attention state and do not retry
blindly.
