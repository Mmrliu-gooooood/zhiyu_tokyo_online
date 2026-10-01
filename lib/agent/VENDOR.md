# Vendoring Intent: pi-agent-core

## Upstream

- Repository: github.com/earendil-works/pi
- Author: Mario Zechner (MIT License)
- Agent kernel baseline tag: `0.78.0` (`@earendil-works/pi-agent-core`)
- Model runtime: `0.99.1` (`@earendil-works/pi-ai`)

## What we use

- `@earendil-works/pi-agent-core@0.78.0` — agent loop / harness (session management, skills, compaction, hooks)
- `@earendil-works/pi-ai@0.99.1` — the text-model runtime behind the model gateway
  (`lib/model-gateway`, see `docs/plans/2026-09-30-model-gateway-refactor.md`).
  Only the gateway runtime/adapters/testing modules may import its runtime values.

We do NOT use:
- `pi-tui` (terminal UI)
- `pi-coding-agent` (coding-specific agent)

## Two pi-ai copies

pi-agent-core 0.78 declares `"@earendil-works/pi-ai": "^0.78.0"`, so pnpm installs a
nested pi-ai 0.78.x next to it while the root resolves 0.99.1. Do not use npm
aliases or `pnpm.overrides` to collapse them.

- Types exchanged with the agent kernel come from
  `lib/model-gateway/adapters/agent-pi-types.ts` (derived from pi-agent-core's own exports).
- The kernel's `compact()` dispatches through the nested 0.78 global API registry, and it
  consumes event streams created by that instance. `lib/model-gateway/adapters/agent-legacy-pi.ts`
  locates and loads that exact instance; it is the only code that touches the 0.78 runtime.
  Delete it when the agent kernel is upgraded (a separate migration: 0.99 changed the
  Session/storage contracts).

## Pinning rationale

Both packages are pinned at exact versions (no caret range) in the root `package.json`. This
ensures reproducible installs and a stable baseline for any future fork/vendor operation.

## Fork / vendor rule

**Do not vendor the source until you actually need to modify the loop.**

When that time comes:

1. Vendor the source at the recorded baseline (agent kernel `0.78.0`) by copying the relevant packages into this repository.
2. Run `diff baseline..upstream` to identify changes in newer upstream releases.
3. Cherry-pick any desired upstream improvements onto the vendored copy.
4. Remove the npm dependency and update all imports to point at the local copy.

This "lazy modification" approach avoids the module-resolution overhead of full source vendoring until it is actually necessary.

## MIT Attribution

```
Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
