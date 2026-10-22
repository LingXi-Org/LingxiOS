# 3.8.1 conversation delivery repair

Ordinary public conversation turns now continue repairable missing deliverables
within the existing correction and root budgets. Previously, the conversation
flag alone skipped those repairs and could commit an answer promising a missing
interactive view as partial. Both parsed partial self-assessments and grounded
content-review findings use the corrected boundary.

Products that dispatch peer assignments after committing a public contribution
may implement the optional `RuntimePolicy.deferConversationRepair(text, context)`
hook. It defaults to false when omitted. Return true only when the trusted host
can identify an actual handoff to a current authorized recipient in the candidate.
The runtime consults it only for public `conversationTurn` work. The hook does
not grant permission, dispatch work, confirm delivery, or bypass native resource
and skill checks. The final contribution retains partial goal status while work
is pending. Ordinary prose, examples and arbitrary model intent are insufficient.

This is a bugfix with an optional product-policy extension. Existing root limits,
correction counters, approval/input waits, cancellation and durable checks are
unchanged. Control-plane 11, kernel 2, native schema 14, assistant-message 2,
publicText 2 and runTrace 1 remain unchanged; there is no SQL migration in this
package. Product consumers with exact provenance guards still need a reviewed
product migration and the exact formally published 3.8.1 dependency/lock.

The normal release sequence is: successful PR release gates, sole integrator
merge, successful `release-gates` on that exact main commit, then the sole
publisher creates tag `v3.8.1`. `publish-package` verifies tag/package equality
and the exact main qualification before publishing to GitHub Packages. Verify
registry integrity and compiled release identifiers before product adoption.
This branch does not tag, publish or deploy.

The controlled reproduction and tests use synthetic content. They establish
the control-flow defect and repaired boundary, not the cause of any original
production conversation or provider outage. Related issues:
[LingxiOS #42](https://github.com/LingXi-Org/LingxiOS/issues/42) and
[LingxiLoop #298](https://github.com/LingXi-Org/LingxiLoop/issues/298).
