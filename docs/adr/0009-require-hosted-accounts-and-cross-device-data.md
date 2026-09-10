# Require hosted accounts and cross-device data

## Status

Accepted product boundary on 2026-09-07; implementation and authentication provider remain undecided.

## Context and decision

The hosted application targets students and teachers, initially an invited group of 10–50 users primarily outside mainland China, and has a commercial purpose. The user requires formal registered accounts and cross-device access to each user's courses, conversations, and learning records. A shared access code, public persistence development token, or signed anonymous device cookie cannot be treated as fulfilling that account requirement. Earlier account exclusions in the Pro model-binding bugfix applied to that narrower task; this deployment introduces an additional account-system requirement.

## Consequences

The design must unify identity and authorization across ordinary persistence, Pro sessions, materials, assets, learning runtime, and saved credentials. Default course visibility, sharing, teacher/student permissions, login methods, and migration of existing device data require further discussion. Owner migration must consider encrypted credentials whose authenticated encryption binds to the owner identity.

The user also intends to fund model calls through purchased credit packages while retaining user-provided API support. Code reconnaissance did not identify a complete payment/order/credit-ledger implementation. That functionality must be planned explicitly rather than inferred from existing usage logs; real-payment launch timing and settlement rules are not yet decided. Infrastructure budget is CNY 350/month excluding model API costs, and the invited user count is not a claim about simultaneous expensive-task concurrency.
