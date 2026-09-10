# Separate generation navigation, cancellation and shared admission

## Status

Accepted planning decisions from interview answers Q1–Q7 and explicit overall confirmation on 2026-09-09; not implementation evidence. Complements ADR-0016. Detailed answers are tracked in the [generation interview](../archive/investigations/zhiyu-generation-concurrency-interview-2026-09-09.md).

## Context and decision

Course generation is durable server work, while navigation only changes which work a browser observes. Leaving a course currently keeps its job running but hides why subsequent work waits. Preserve durability on refresh/tab close and offer three explicit choices on return-home: continue in background and return, cancel generation and return, or stay. Explicit cancellation is terminal and preserves completed pages as an unfinished course; it is not a pause/resume contract. Generating again creates a new job.

Use the existing deployment admission boundary across ordinary generation, Pro long-running work, independent parsing and media. Each account runs at most one root heavy task; the site starts at one and may increase to two after combined-load validation. Children inherit root admission. Execution slots are distinct from pure queue capacity (five per account, twenty globally), human review and provider quotas. Pure queue waits expire after sixty minutes with input retained; manual outline review releases execution capacity and expires after twenty-four hours with its outline retained. Restarting expired work requires an explicit user action; automatic review mode keeps its existing flow.

Waiting-for-review and needs-attention jobs have a separate combined admission threshold of five per account and twenty site-wide. Reaching it blocks new root-task submissions with a reason, without discarding accepted work that subsequently transitions to these states or deleting unresolved billing evidence. These thresholds are not execution slots or pure queue capacity.

Append truthful server-derived status to “构建课程中”; completed, failed and cancelled work uses a terminal title. Browser observation loss must not be treated as a confirmed worker failure.

## Consequences

Users can leave without losing server work and explicitly stop unwanted work. UI and API must agree on queue, execution, review and terminal states across devices. Existing owner limits and per-process Worker counts are insufficient to enforce the shared admission boundary; create, claim and nested tools require consistent database coordination. Existing queue counters include more states than pure waiting and must be changed. Late results cannot revive cancelled jobs; provider calls already sent can incur charges and must follow the existing evidence-based settlement rules. No model-call throughput is guaranteed by the host's CPU count.
