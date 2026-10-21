# 3.7.0 release preparation and reader-first handoff

This is an unpublished release candidate. It changes runtime/package version to 3.7.0 and advertises `releaseVersions.publicText=2`. Control-plane11, kernel2, native schema14 and assistant-message2 are unchanged. All native SQL files and dependency resolutions remain unchanged. Product migration50 remains a separate product invariant. This document authorizes no merge, tag, package publication or production action.

## Minimum formal release chain

1. Review the exact candidate and its successful upstream PR release gates. The repository's `release.yml` performs build, package-install/public-export checks, native store/recovery/workspace/capacity/operation gates and Worker confinement checks, then retains a source-bound qualification. Local source-overlay or `npm pack` evidence is not a registry release.
2. The designated release owner merges the approved candidate. Require a successful **main push** `release.yml` run on the exact commit to be tagged; a green PR run is not a substitute. Existing `publish-package.yml` enforces this and a matching `v3.7.0` tag. Check that the registry version is available before publication; do not overwrite any published version. Use existing authorized registry access only.
3. The release owner alone tags that commit and verifies the publication workflow's terminal success and actual registry package identity, dist integrity and compiled capabilities. Verify package/runtime3.7.0, publicText2 and unchanged SQL checksums. No tag or package was published during this preparation.
4. In an isolated Loop integration branch, use the real published `@lyyzka/lingxios@3.7.0` with an exact dependency and lock integrity. Run owning CI on that exact integration commit. Do not use `file:`, a local tarball, source overlay, vendored implementation or guessed lock integrity. The current Loop draft still depends on formal3.6.0; its failing formal CI is expected evidence of the missing API, not a deployment-ready result.

## Reader phase, then explicit producer phase

The public producer option is `WorkerOptions.model.publicTextProtocol: 'purpose-json-v1'`. Omit it to retain legacy v1/plain output. `releaseVersions.publicText===2` is a reader capability, not an enable switch.

The companion Loop draft explicitly sets the option in `server/src/agent-runtime/runtime.ts`. **Do not deploy it unchanged for the reader phase.** Remove only `publicTextProtocol: 'purpose-json-v1',` from `runtimeModelConfiguration`, retain the publicText2 reader guard, and use the formal3.7.0 lock. Stage this reader-only build on all Web/API/SSE/history readers and Workers under a separately reviewed runtime upgrade plan. The existing formal3.6.0 same-schema driver deliberately rejects3.7.0 even with unchanged SQL; this document does not permit weakening its formal-key guard or forging a migration plan.

Confirm every active reader/Worker has the exact qualified reader build before a second, explicit producer-enable build restores that one option. No new environment/credential/security knob is necessary. Record the producer phase as a separate immutable source/image decision. During a mixed-reader interval the producer must stay disabled.

After any v2 history is written, old3.6.0 strict readers cannot safely return. Turning the producer off only stops new v2 output; it does not rewrite old JSONB history. Keep v2-capable readers and fix forward. Do not delete history or silently reinterpret it to permit a downgrade.

## Smallest producer compatibility contract

The configured adapter needs streaming Chat Completions with JSON-object output and ordinary native tool calls. Its declared capability flags must support both. Deterministic public-adapter tests already cover:

- Ordered commentary/answer fields, split escapes and decoded answer delivery before provider EOF. Both are public; provider private-reasoning fields are ignored.
- Native tool-only turns and tool turns with an independently declared substantive answer. The answer streams before the tool executes, retains answer purpose through end(tool), and does not become the accepted final merely because the tool ran. A later no-tool answer binds the accepted identity.
- Malformed/reordered/duplicate/truncated/trailing framing rejects through existing bounded protocol repair; no unframed fallback, whole-answer buffering or new retries. Cancellation prevents subsequent same-frame text.
- Actual native Worker persistence, authorized events, SSE replay and the product's declared-purpose foreground routing/supersession; existing safety/authorization/fencing and final-commit checks remain in force.

No paid or real external-provider request was made here. Synthetic coverage proves adapter behavior, not whether every model labels arbitrary prose correctly. This limitation does not block formal publication or the reader-only phase and does not request a new broad model/browser evaluation. The release owner may enable the producer under its existing authorization after confirming the configured provider exposes the stated API capabilities; unsupported output fails within existing limits. If a concrete incompatibility is observed, disable the producer while retaining capable readers. Do not claim semantic classification of arbitrary prose or hide substantive answers as commentary.

Evidence: [public-purpose results](evidence/public-purpose/RESULTS.md), [contract](public-purpose.md), [failure model](public-purpose-failure-model.md). Exact CI status belongs to the immutable handoff for each commit, not a claim that a prior run covers later changes.
