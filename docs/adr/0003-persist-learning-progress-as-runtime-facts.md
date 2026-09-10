---
status: accepted
date: 2026-09-01
---

# Persist learning progress as learner-runtime facts

Scene, Lesson, and Course completion will be recorded as durable learner-scoped facts in `RuntimeStore`, separate from the device-scoped last-write-wins playback cursor. A Scene completes only through finished teaching/native interaction or an explicit learner action, Lesson completion is derived from all of its Scenes, and Course completion is derived from all Lessons; assessment disposition never gates progression. The existing cursor remains resume state and cannot serve as evidence that content was learned.

## Consequences

- Refreshing, reopening, or viewing a Course from Home can reconstruct completion without replaying UI state.
- Completion writers must be idempotent and safe across multiple tabs.
- Course generation completion and learner Course completion remain distinct concepts.
- Imported and legacy Courses need a Lesson-plan fallback before Lesson and Course completion can be derived.
