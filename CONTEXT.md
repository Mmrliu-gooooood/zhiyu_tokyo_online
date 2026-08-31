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
