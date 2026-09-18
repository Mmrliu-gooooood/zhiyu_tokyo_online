---
status: accepted
date: 2026-09-14
---

# Focus the competition release on student learning

## Context

The user wants to develop ZHIYU, a secondary development of OpenMAIC, into a competition project with clearer value beyond UI and course-generation changes. The user explicitly requested student-first delivery and deferral of the teacher-facing product.

## Decision

Scope this competition product exploration to students' learning workflows. Defer a human-teacher product surface and its teaching-management workflows. Retain the distinction between human teachers using a product and AI teachers participating in a classroom. No separate application, database, or deployment is selected by this decision.

## Consequences

- Student workflows and evidence of their value take priority in the interview; teacher workflows do not become prerequisites for the proposed release.
- Existing classroom, generation, editing, and AI-teacher capabilities are not removed by this scope decision.
- The user subsequently confirmed a general-purpose course assistant with learner-chosen topics and testing, a ten-day deadline, and one developer plus AI at about thirty hours per week. Assessment extensions, business model, and detailed implementation schedule remain unsettled; the product is not restricted to one subject.
- The earlier UI-only redesign boundary remains applicable to that workstream; a future learning-feature implementation requires its own explicit scope.
- Future teacher-facing work will require its own requirements discussion; the student-first decision does not require an eventual second system.
