# ZHIYU Product Interface Context

This context defines the product-facing language used by the ZHIYU redesign. It separates OpenMAIC behavior from the visual product chrome that may be redesigned.

## Product and surfaces

**ZHIYU (智域)**:
The product identity presented by the redesigned application chrome. OpenMAIC remains the underlying platform and must be credited as `基于 OpenMAIC 构建`.
_Avoid_: 青衿, 书院, OpenMAIC as the English expansion of 智域

**Product chrome**:
The navigation, headers, rails, panels, controls, dialogs, notices, and empty/loading/error states surrounding learning content. This is the redesign boundary.
_Avoid_: generated course content, business behavior

**Generated learning content**:
Slides, quizzes, interactive HTML, whiteboards, and PBL experiences generated or stored by OpenMAIC. Their authored colors and layouts remain intact while their surrounding chrome is redesigned.
_Avoid_: product chrome, ZHIYU skin

**Home**:
The classic one-prompt course creation and course-library surface at `/`.
_Avoid_: Workspace home

**Generation Preview**:
The classic generation, outline review, retry, and current-scene preview surface at `/generation-preview`.
_Avoid_: classroom, Workspace generation

**Standalone Classroom**:
The route-owned classroom at `/classroom/[id]`, including its own loading, missing, error, playback, edit, chat, settings, and export states.
_Avoid_: Hosted Classroom

**Hosted Classroom**:
A classroom rendered inside a Workspace pane, where the host owns surrounding navigation and may suppress standalone chrome.
_Avoid_: Standalone Classroom

**Workspace**:
The optional Pro workbench at `/workspace`, covering home, conversation, classroom, and combined multi-pane states.
_Avoid_: Home, classic workbench

**Classic Chat**:
The classroom discussion UI under `components/chat`.
_Avoid_: Workbench Conversation

**Workbench Conversation**:
The Workspace agent conversation UI under `components/workbench/chat`.
_Avoid_: Classic Chat

**Compatibility Bridge**:
The `/workbench/new` route that forwards old links into Workspace and owns only loading, failure, and retry presentation.
_Avoid_: independent product page

**Evaluation Surface**:
The developer-only `/eval/whiteboard` route used for layout and automated evaluation. It is regression-tested but not product-branded.
_Avoid_: user-facing route

## Delivery language

**Surface Matrix**:
The inventory mapping every product surface to its owner, states, viewport/theme coverage, and acceptance evidence.
_Avoid_: route list

**Behavior-preservation test**:
A test that proves existing handlers, stores, navigation, persistence, and generation/playback semantics still work after presentation changes.
_Avoid_: visual snapshot test

## Learning and assessment

**Course**:
The complete learner-facing unit stored as one OpenMAIC `Stage` and opened at `/classroom/[id]`; completing its ordered scenes completes the Course. The first assessment release does not introduce a Subject aggregate above Course.
_Avoid_: Subject, curriculum

**Scene**:
One ordered learning-content unit inside a Course, such as a slide, quiz, interactive experience, or PBL experience.
_Avoid_: Course, subject

**Lesson**:
A meaningful learning section within a Course, represented by a stable identity, title, learning objectives, and a contiguous group of Scenes rather than by one Scene. Course generation creates two to five Lessons; legacy or imported Courses receive an AI-generated grouping when assessment first needs it, falling back to one Lesson for the whole Course.
_Avoid_: Scene, Course

**Learning-check plan**:
Course-owned assessment intent created with the course outline, defining coverage objectives, fixed checkpoint placement, target question count, and difficulty without containing a learner's generated questions. A plan groups one or two related Lessons per checkpoint, caps process checkpoints at three, and always includes a final checkpoint; a short Course may have only the final checkpoint.
_Avoid_: Question set, quiz attempt

**Question set**:
The immutable questions generated from completed Lesson content when a learner starts a Learning check. It belongs to that learner's attempt so later Course edits cannot rewrite assessment history.
_Avoid_: Learning-check plan, shared quiz scene

**Course Quiz**:
A shared, authored Quiz Scene stored as Course content. It remains distinct from learner-owned Learning checks, appears in a separate Course-report section, and may inform learning advice without contributing to the Home learning-check score.
_Avoid_: Learning check, assessment attempt

**Quiz attempt**:
One learner-scoped answering lifecycle for a quiz scene, progressing from draft to submitted to reviewed and retaining answers and grading results.
_Avoid_: Quiz definition, course report

**Learning check**:
An optional formative assessment offered to a learner after completing one or more Lessons. Taking, postponing, or skipping it never blocks Course progress or completion; starting it generates a three-to-five-question Question set with mostly choice questions and at most two AI-graded short answers.
_Avoid_: Examination, pass gate, certification

**Checkpoint disposition**:
The learner's choice at an available Learning check: start now, postpone with reminders, or skip without reminders. A postponed or skipped checkpoint remains manually available and never gates Course completion.
_Avoid_: Assessment result, pass status

**Learner runtime**:
Learner-specific activity data associated with a Course, currently partitioned by a device-anonymous learner key and persisted through `RuntimeStore`. The first assessment release provides per-device learner history and does not add account or cross-device identity.
_Avoid_: Course content, account profile

**Learner assessment**:
The first-release assessment experience owned by an individual learner; it excludes teacher dashboards, cohort analytics, rankings, certificates, and proctored examination rules.
_Avoid_: Teacher analytics, formal examination

**Assessment attempt**:
One resumable draft or submitted run through a Question set. Submitted attempts are retained, retries are unlimited, the latest score is primary, the highest score and attempt count are secondary, and learning advice weighs the latest answers while considering improvement across attempts.
_Avoid_: Draft answer, overwritten score

**Latest learning-check score**:
The points-weighted percentage formed from the latest fully graded Assessment attempt at each participated checkpoint. Skipped and unattempted checkpoints are excluded and participation is always displayed alongside the score.
_Avoid_: Best score, Course Quiz score

**Best learning-check score**:
The points-weighted percentage formed from the highest fully graded Assessment attempt at each participated checkpoint.
_Avoid_: Latest score, combined Course Quiz score

**Scene completion**:
A durable learner fact recorded when a Scene's teaching actions or native interactive completion condition finishes, or when the learner explicitly marks it learned; merely opening or rapidly navigating past a Scene does not complete it.
_Avoid_: Playback cursor, page visit

**Lesson completion**:
A durable learner fact derived once every Scene in a Lesson is complete. It makes the Lesson's next checkpoint available and survives refresh or re-entry.
_Avoid_: Lesson visit, Course completion

**Course completion**:
A durable learner fact recorded once every Lesson in a Course is complete. Pending, postponed, or skipped Learning checks never block this fact.
_Avoid_: Course generation complete, last page visible

**Course report**:
The learner-facing, continuously updated projection of assessment history for a completed Course revision. With at least one successfully reviewed Assessment attempt it combines deterministic completion and scoring facts, immutable questions and answers, detailed feedback, participation, and versioned AI learning advice; otherwise it states that the Course was completed without participating in Learning checks. Course Quiz results are shown separately from Learning-check scores.
_Avoid_: Quiz review, teacher analytics

**Course revision**:
A version of Course learning content and its Lesson and Learning-check plans. Material edits create a new revision; completion, questions, answers, scores, and reports remain bound to the revision in which they occurred.
_Avoid_: Updated timestamp, assessment retry

**Pending grade**:
A submitted Assessment attempt whose AI-graded answer has not received a durable grade. It may expose a provisional score but cannot contribute to final latest or best scores until grading succeeds.
_Avoid_: Incorrect answer, automatic partial credit

## Pro model-configuration fix (revised scope, 2026-09-05; implementation pending)

**Pro learning consultation**:
The Workspace conversation through which the learner can express goals, prior knowledge, and intended scope before generating a Course. Deeper questioning can be requested through skills; the current bugfix adds no fixed consultation rounds or new global proposal-confirmation workflow.
_Avoid_: mandatory questionnaire, required one-to-three-round interview

**Shared Home model configuration**:
The default model connection selected in Home and reused by Pro when no explicit administrator stage route overrides it. Unsupported tool-use capability and administrator overrides must be explained; this bugfix does not require new advanced model-selection screens.
_Avoid_: automatic use of an unrelated server model, separate mandatory Pro credentials

**Saved Pro connection**:
A server-encrypted model connection isolated to its current owner, removable from settings and referenced by version from background tasks. This is accepted product intent, not an already implemented credential service.
_Avoid_: plaintext session credentials, shared administrator key

The Learning and assessment terminology above records the wider project direction. New diagnostics, Lesson plans, checkpoints, dynamic question sets, assessment attempts, reports, and advice loops are deferred and are not requirements or evidence of implementation for this Pro bugfix.
