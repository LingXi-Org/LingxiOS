# Native tool failure recovery matrix

Written before implementation for LingxiLoop #159. Native authorization is a
read-only preflight. Its failure never grants access or substitutes a success.

| Failure / phase | Stable outcome | Recovery bound | Evidence |
| --- | --- | --- | --- |
| Structured forbidden / 401 / 403, including nested causes | authorization, terminal | One authorization call, zero executions | `tool-failure-recovery.test.ts` |
| Blocked DNS / permanent DNS failure | dependency, terminal | One authorization call, zero executions | same |
| Contract / observation / approval version stale | version, refresh required | No automatic repeat | same |
| Invalid native input | invalid input, terminal | Zero authorization / execution calls | same |
| Known transient authorization dependency | dependency | At most two read-only authorization attempts within original signal/deadline | same |
| PostgreSQL serialization/deadlock before COMMIT, rollback acknowledged | dependency | At most two complete transactional attempts; same action identity; reauthorize each time | same |
| Unknown transactional exception, rollback acknowledged | no effect, terminal | No repeat; sanitized diagnostics | same |
| Uncertain external exception / COMMIT acknowledgement lost / rollback failed | unknown effect | No execution retry; reconciliation remains authoritative | same + existing `native-tools.test.ts` |
| Cancelled / deadline elapsed | cancelled, terminal | No repeat | same |

The one recovery delay is 25 ms, bounded by the original deadline and interrupted
by the original signal. Authorization retries repeat only the read-only check;
transaction retries repeat the same identity after rollback and reauthorization.

Diagnostics contain only a category, recovery hint, retry eligibility, allowlisted
cause code, and opaque UUID correlation. They exclude resource identities,
arguments, provider payloads, raw messages, prompts, credentials, and stacks.
Classification uses structured fields, never message matching. A terminal nested
cause overrides a transient wrapper. Unknown errors remain terminal. Retry
eligibility is advisory and never establishes whether an effect happened.

The action transaction, intent, ledger, receipt and reconciliation contracts are
unchanged. Executor errors carry sanitized diagnostics; its own no-effect results
also carry diagnostics. The integrating control plane must preserve that optional
field through prepare rejection, execution failure, transport and public exports.

## Validation evidence

Baseline: `npm run build` passed before implementation. The five initial tests in
`tool-failure-recovery.test.ts` all failed, exposing lost forbidden reasons,
unbounded/unavailable recovery, raw rollback messages, and missing diagnostics.

Final owning checks, 2026-10-17:

- `npm run build` — passed.
- `npm run typecheck` — passed.
- `node --test --test-concurrency=1 dist/test/tool-failure-recovery.test.js dist/test/tool-recovery-transaction.test.js dist/test/native-tools.test.js dist/test/async-audit.test.js dist/test/memory-synthesis.test.js` — 22 passed, 0 failed.
- `git diff --check` — passed.

The PGlite integration test mutates inside the first attempt before an injected
serialization failure, verifies rollback, commits exactly one effect and receipt
under the original identity, then replays the receipt without another execution.
This is deterministic local fault injection, not a real provider or live external
dependency regression. No package version, product dependency, schema, release,
deployment, or external-service state changed.
