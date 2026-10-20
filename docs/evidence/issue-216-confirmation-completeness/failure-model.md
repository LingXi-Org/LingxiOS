# Failure model, written before the fix

Base: b8bbef2762c782c75079c3f81113296e95d17bb1. PR35 preserves the previous
independent worker and real-provider failures.

1. A native reviewed deletion commits and advances the scope epoch. The next
   context read correctly rejects the previous admission; no final message
   is committed. Recovery must acknowledge only a successful, current-request,
   identity-bound native receipt, without another model call, old body,
   citations, contract, resource checks or artifacts. It must not renew the
   admission epoch or claim completion of unrelated work. Crash after commit
   must not repeat deletion. Cancellation, stale request, revoked scope and
   stale lease must prevent the acknowledgment.
2. A rejected middle page advances the cursor so the unseen tail can still be
   inspected. An approved last page currently overwrites that earlier failure
   with processed. Persist content-free page outcomes in the existing durable
   job metadata, bind them to source version/hash/scope epoch, and report
   processed only when every window has passed and the source is complete.
   Review rejection is terminal for that window, not an unbounded retry.
   Transient worker failures retain the existing three-attempt retry policy.
   Aggregate source state must not hide pending/rejected scopes behind one
   successful scope. Incomplete capture must remain incomplete.

Tests precede source edits: official createWorker deletion probe; mixed
reject/approve pages, all approved pages, incomplete capture and multiple
scope outcomes. Preserve existing all-rejected tail traversal and no-loop test.
Keep schema13 / product0047; no package publication, merge or deployment.

The first real-provider probe after the initial fix found a second completeness
failure: an empty proposal bypassed independent verification, lost the tail
fact and marked the source processed. Preserve that red result. Every human
page, including empty proposals, needs a separate coverage decision. A single
shared repair allowance may correct syntax or coverage; the replacement still
requires independent approval and complete coverage. Exhausted review rejects
the window; failed/aborted calls leave it pending for the existing bounded retry.

The retained assistant-only test previously fabricated a cursor without a
preceding accepted page. Its setup will process an actual first page before
testing the no-model assistant continuation; an unproven legacy cursor must not
be used as proof of source completeness.
