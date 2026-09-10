---
status: accepted
date: 2026-09-01
---

# Own dynamic assessment questions in learner runtime

Course generation will persist only a shared Learning-check plan, while the exact Question set is generated from completed Lesson content after a learner chooses to start a check and is stored immutably with that learner's Assessment attempt in learner runtime. This preserves what the learner was actually asked even when the shared Course is edited later, avoids spending an AI call when a learner skips a check, and permits personalized or retry-specific questions without cloning the Course document.

## Consequences

- Assessment history must retain both questions and submitted answers rather than resolving historical questions from the current Course document.
- Course deletion continues to cascade into learner runtime, while Course edits do not mutate prior Question sets.
- Question-generation failure can be retried or bypassed without changing Course progress.
- Shared authored Quiz scenes remain Course content and are not silently converted into learner-owned Learning checks.
