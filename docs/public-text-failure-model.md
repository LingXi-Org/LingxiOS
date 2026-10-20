# Durable public text: failure model before implementation

Baseline: 3.5.6 (`e44fb862c1a1a0d94eb5213fcfaf56f3dfccae73`). This is a design and pending validation record, not a passing test report.

Independent user-text must be authorized and durably appended before it can be displayed. Candidate JSON, reasoning, tool arguments, auxiliary output and previews are not durable public commentary. Final answers retain the existing verified envelope contract.

Failure cases to cover before changing implementation:

- A user-text prefix disappears when a tool starts, the provider fails, or the run is cancelled.
- Provider retries within one lease overwrite each other; request revisions and new fences also need separate identities.
- A current terminal state arrives before historical events and discards older attempts.
- A delayed/failed append publishes an uncommitted prefix; an uncertain acknowledgement duplicates a committed chunk.
- Async callbacks are ignored by the official driver or execution wrapper, leaving unbounded writes or unhandled rejections.
- A cancelled or crashed worker cannot emit its terminal event; replay must not leave published text permanently running.
- Current audience authorization or request version changes while text is in flight.
- 100-event pages, more than 80 parts, or old failed runs hide published content. Product history discovery remains a separate consumer responsibility.
- Final delivery duplicates commentary or labels an incomplete attempt as a final answer.

Use existing JSONB events and published APIs, no schema migration. Tests use synthetic text/providers and isolated databases; never log provider payloads or credentials. Measure persistence and rendering separately. Preserve bounded cancellation, model budget settlement, lease fencing and business-tool receipts.

## Implementation and evidence follow-up

The initial five baseline behavioral tests failed before implementation. Additional targeted failures exposed inferred-versus-explicit terminal ordering, same-fence revisions, loss of publication-error identity after usage wrapping, pre-gate public content, premature `completed`, and commentary invented from a final return without deltas, missing accepted-result association, unrelated pre-tool source association, and a forged result-commit event. Each has a dedicated regression. See [the public contract](public-text.md) and its evidence manifest for tested commits and counts. Early harness type errors, a storage-fixture assertion/table-name correction, and a build blocked by disk exhaustion are retained as non-passing development evidence; none are counted as product successes.

The accepted-result follow-up also preserves the existing control-plane candidate-size check. An exploratory full-app 100,001-character final was rejected before `commitResult`; it is not counted as a successful large-answer delivery. The new source binding does not use the retained-candidate cache size as an additional acceptance limit.
