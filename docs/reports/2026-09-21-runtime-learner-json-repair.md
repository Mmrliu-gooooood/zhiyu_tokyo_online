# Runtime learner JSON migration repair

## Incident and cause

The migrated course `94c0ee87-31af-4db5-af39-93f7eb414220` showed no teach-back
history despite two completed sessions with twelve runtime records each.
The migration mapped the indexed `runtime_sessions.learner_key` but did not
map the serialized session's `data.learnerKey`.

The SQL session listing matched the current user. The HTTP records handler
then correctly compared the serialized learner with the authenticated
principal and returned `SESSION_NOT_FOUND`. The client maps that response to
an empty record list, so neither teach-back activity had a start event.
The ownership check was correct and remains unchanged.

## Scope and evidence

Completed migration run `79470579-fac7-5929-8a5a-47fd9dc64e22` records
`adminOwnerMapped=true`, an explicit administrator owner, and 38 source runtime
sessions. The read-only preflight found exactly 38 column/JSON mismatches:

| Kind | Before | Repaired | Remaining |
| --- | ---: | ---: | ---: |
| Chat | 12 | 12 | 0 |
| Quiz attempt | 24 | 24 | 0 |
| Teach-back | 2 | 2 | 0 |

Every candidate already belonged to the migration's administrator in the
authoritative learner column and its course owner. Its JSON learner was
anonymous, JSON ID and stage ID matched the indexed fields, and its creation
time preceded the completed migration. No signed-user JSON learner was eligible.

The authorized repair ran as one atomic SQL statement with row locks and an
exact-count guard of 38. It used `jsonb_set(data, '{learnerKey}',
to_jsonb(learner_key), false)` and did not change the indexed learner, IDs,
timestamps, status, or runtime records. Every repaired JSON object excluding
`learnerKey` compared equal to its original. The three pre-existing signed-user
JSON rows retained the same aggregate digest before and after:
`0df87ac31a21604b0306516e2db59881`.

After repair, all 41 sessions have matching column and JSON learners. Both
`teach-back:tb-G6WIzNTJzNF7Ge0AGKccX` and
`teach-back:tb-WM4Y3RKx0a6vAe6l_olT2` pass the serialized ownership condition
and retain twelve records each. Browser verification is recorded by the main
acceptance task after refreshing the course history.

## Prevention and verification

The migration now maps the indexed learner and serialized learner together,
preserves the rest of the historical session, refuses mismatched source data,
and refuses reassignment of a signed-user learner. Final migration verification
also rejects any remaining column/JSON learner mismatch before declaring the run
complete.

Regression coverage exercises teach-back, chat, and quiz sessions, source
immutability, idempotence, preservation of signed-user identity, and refusal of
ambiguous source ownership. The migration safety tests and lease configuration
tests pass together: 14 tests across two files. This data-only repair is separate
from account/capacity schema migration v19.
