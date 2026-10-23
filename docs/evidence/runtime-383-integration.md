# Combined protocol, content repair and review qualification

Failure inventory before integration changes:

- Joining delivery and scope review reduces each candidate review from two calls
  to one. Owning budget tests must use the new actual invocation count, keeping
  the same boundary immediately before another generation. Counts must not be
  relaxed to ignore unaccounted calls.
- Two malformed public responses still exhaust the lifetime protocol allowance.
  With the trusted additional content allowance of three, a subsequent complete
  protocol frame with missing content must be able to repair the answer without
  creating another protocol allowance or skipping the joint content check.
- Persistent omissions must stay partial, cancellation must prevent the next
  generation, and checkpoint restoration must not replenish spent corrections.
- Call, token, cost and elapsed-time caps must stop before the extra generation
  at their configured boundary. Reduced review counts change fixture caps, not
  production root limits.
- The real HTTP driver must exercise the combined protocol/review/budget path;
  native model and tool authorization remain unchanged. All inputs are synthetic.

Initial combined owning run reproduced ten expected count/boundary fixture
failures after the independent review optimization was merged; no test was
changed before recording that result. The change below reconciles those fixture
expectations with the single joint review and adds the HTTP-driver scenario.

Combined owning validation passed 75/75: protocol decoder/recovery, real Worker,
conversation content repair, correction counters, joint content/scope review,
closed operation metadata and public run trace. The HTTP-driver case performs
two malformed generations, one incomplete candidate plus joint review, then one
complete candidate plus joint review: four generations, two reviews, six settled
calls and an exact satisfied result. Root boundary fixtures now stop at call four
(480 measured tokens/cost units), immediately before the extra generation. The
runtime root caps and protocol correction cap are unchanged.

The HTTP fixture initially asserted the separate completeWork callback on a
successful commitResult path. The fixture only records non-result terminal paths
through that callback; this assertion was corrected while retaining exact body,
satisfied outcome, settlement counts and bound allowance checks.

Release 3.8.3 changes only the package/runtime version, the reviewed protocol,
bounded content allowance and joint review implementations, plus these combined
regressions. Native schema remains 14 with identical SQL bytes, control-plane
protocol 11, public-text protocol 2 and run-trace protocol 1. Package qualification
and the final main commit's CI remain required before the version tag is pushed.
