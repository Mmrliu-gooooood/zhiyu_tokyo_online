# Defer MP4 rendering and real payments in the invited beta

## Status

Accepted on 2026-09-07. Supersedes ADR-0008's requirement to deploy MP4 rendering in the first release. Other existing application capabilities remain in scope.

## Context and decision

After considering infrastructure cost, the user explicitly stated that MP4 export is not currently needed and may be left out of the first deployment. Preserve its implementation, disable the entry and server-side capability, and do not provision the render service until it is requested later. The first invited beta will issue test credits and validate usage deduction before accepting real payments.

Asia-Pacific is the initial overseas target region. Cloud data starts empty while local data is retained. Courses, conversations, and materials are private by default; only explicitly published courses become shared. Authentication uses email and password with email verification and invitation restrictions.

## Consequences

The first-release server need not meet the MP4 service's 4/8 GiB render profile requirements. Pro and material processing still need persistent execution. Registration, authorization, synchronization, and an auditable test-credit ledger remain required implementation work. The initial CNY 350/month infrastructure budget may be increased, but its revised ceiling is still under discussion. Exact publication audience, concurrency, and BYOK charging rules are not decided by this record.

The user prefers a Hong Kong server if a server is required, and is weighing Vercel against hosting the Web app there too. Vercel can host the Web/API tier after appropriate adaptation, but does not by itself fulfill the current persistent-runner design. Exact hosting shape and provider are not settled in this ADR.
