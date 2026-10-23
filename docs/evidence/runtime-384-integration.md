# Direct execution and selective workflow qualification

The default path is the model/tool/observation loop. Ordinary answers do not
automatically invoke a semantic evaluator or regenerate merely because the
model reports a partial result. Deterministic authorization, cancellation,
budget, action-receipt, resource, artifact and final-commit checks remain active.

This follows the basic loop described in the
[LangChain agent documentation](https://docs.langchain.com/oss/javascript/langchain/agents).
[Anthropic's workflow guidance](https://www.anthropic.com/research/building-effective-agents)
recommends adding complexity for demonstrated benefit; its evaluator/optimizer
pattern is appropriate for tasks with clear evaluation criteria, not every
response. These sources inform the design; they do not prove this runtime's
behavior or guarantee that every undeclared natural-language omission is found.

Trusted deployments can nominate a bounded task-specific review rubric. The
control plane resolves that scope again at final commit and requires evidence
for the current request, candidate and rubric. No additional routing model is
used. A selected scope receives one focused review while it remains unresolved;
a repair that leaves the same scope unresolved stays partial instead of entering
another review/rewrite loop. An old positive result cannot certify changed text.
Explicitly required generic review remains available for workflows that need it.

The separate provider capability opt-out omits native JSON mode only for
generation requests that expose tools. Strict public-purpose parsing and native
tool validation remain active. The omitted/true capability preserves the legacy
wire configuration and fingerprint; false has a distinct fingerprint.

Qualification failure inventory:

- A default question must finish with one useful generation and zero evaluators.
- A trusted selected workflow may require one scoped check. Missing work must
  remain partial if the single repair does not perform the necessary actions.
- A disabled evaluator cannot silently satisfy a nominated requirement.
- Malformed, stale, revoked or changed scope/candidate evidence fails closed.
- Recovery must retain the review allowance, behavior binding and global budget.
- Native tool requests must not lose public-purpose framing, tool identity,
  cancellation or measured usage when JSON mode is omitted.
- Package version, exact CI and published artifact identity must agree before
  a version tag or downstream dependency update is used.

Release 3.8.4 retains native schema 14, control-plane protocol 11, public text 2
and run trace 1. The new behavior mode, policy identity and prompt contract are
pinned; an older bound execution must finish on its original compatible worker.
Deployments must drain or reject incompatible unfinished work rather than reset
its binding, checkpoint or budget. No schema migration accompanies this release.

Combined validation results are recorded on the exact candidate PR and CI.
