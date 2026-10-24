# v3 optional commentary contract

Observed synthetic public prefix:
`{"operation":{"kind":"append","supersedes":[]},"answer":"`

The v3 instructions describe commentary as optional, but PublicPurposeParser's
post-operation state requires the literal commentary token. The supplied prefix
therefore fails before answer text. This is a deterministic contract discrepancy;
no inference about unseen keys, values or provider reasoning is needed.

Write tests before the fix:
- Accept this exact prefix incrementally and release typed answer characters before
  outcome completion; operation must already be validated.
- Omitted commentary and explicit empty commentary yield the same answer,
  operation and outcome. Explicit nonempty commentary stays commentary.
- Every character split, Unicode/escape boundary, append/replace, null final and
  null intermediate outcome retain their existing rules.
- Unknown fields (including reasoning), duplicate fields, answer before operation,
  commentary after answer, malformed values and truncation remain invalid.
- v1/v2 omission still fails and their fingerprints remain exact. All v3 bindings
  gain an explicit parsing-policy fingerprint field, including envelope mode,
  which also reuses this parser. No prior v3 run silently changes semantics.
- Actual driver and Worker accept optional commentary without an extra correction
  call; ordinary terminal and intermediate phase handling stay unchanged.

Implementation boundary: reuse the existing bounded PublicPurposeParser token
states. Only its v3 first-key selection may skip the commentary states and enter
its existing answer-key state. The installed @streamparser/json parser remains
unchanged; no new JSON tokenizer, grammar, transport wrapper or router is added.
Native tool schemas, budgets, permission gates, final validation and retries do
not change. This offline fix does not claim that provider early-text selection or
product first-useful timing has passed; the prior real graph is not rerun.

## Offline evidence

- Effective red: /workspace/optional-commentary-red.log, 3/3 expected failures
  (exact observed prefix, real Worker omitted-commentary sequence, old v3 binding).
  The first test build had a TypeScript empty-array assertion inference error;
  that compiler error is not counted as protocol evidence.
- /workspace/optional-commentary-green.log: 13/13 passing parser, driver and
  existing typed-content/native-tool tests, including every split boundary.
- /workspace/optional-commentary-worker-green.log: 1/1 real Worker sequence;
  omitted-commentary intermediate → native read → omitted-commentary terminal,
  exactly 3 model generations, 1 tool effect, 0 judge, 0 model.failed, 2 seals.
- /workspace/optional-commentary-binding-green.log: 1/1 affected replay/clone
  identity test. All v3 hashes intentionally change; v1/v2 gold hashes do not.
- /workspace/optional-commentary-private-contract.log: 1/1 existing real private
  child fixture with the public continuation option enabled. Captured actual
  fetch system content selects v2, includes nonempty answer and terminal outcome
  status/gaps plus delivery/authorization obligations, and excludes v3 operation
  and typed-message rules. This is actual serialized request evidence, not just
  comparison of a configuration object.
- Final build and git diff --check pass. No real provider, product graph replay,
  production changes, budget adjustment, merge or package publication.
