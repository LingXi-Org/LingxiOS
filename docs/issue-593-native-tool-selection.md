# Compatible native tool selection candidate

This is an unpublished 3.8.20 maintenance candidate based on actual v3.8.19
(`11bc5d7`), with unchanged dependencies, exports and native database resources.
It is not the distribution-changing main/4.0 package and has not been published,
merged or deployed. It supports LingXi-Org/LingxiLoop#593.

`publicAnswerTool: native-v3` explicitly permits original-schema business-only
batches without inventing a public message. When a public_answer is present,
it must be first; terminal outcomes still forbid business calls. Public text
still requires the original parsed native binding, exact operation/source
selection, sealed publication and outcome validation. Pure business turns must
contain no public text or forged public metadata. Original native-v1/v2 behavior,
including native-v2 rejection of a missing mandatory output call, is retained.

`RuntimePolicy.requiredTool(context)` optionally narrows the next decision to one
currently authorized native business function. `executionSnapshot` rejects a
name outside its granted catalog and fingerprints the choice. The driver sends
that function through the provider's tool_choice API; token estimation uses the
same choice. The driver and runtime validate the selected business call before
any effect. This cannot grant a capability or bypass parsing, approval, request
source binding, version/hash checks or authoring-stage gates. Existing native-v2
cannot combine a forced business-only choice with its mandatory output contract.

The consumer can use this hook to finish exact skill loading before exposing its
guidance-dependent business tools, instead of depending only on prose that a
model may ignore. The hook and native-v3 must be enabled only after the consumer
installs a formally published compatible package. Loop remains on formal3.8.19;
no development SDK has been installed or copied into its dependency tree.

Focused checks: `npm run build`, `npm run test:native-selection`, the original
publication/correction/reference/order scripts, and real Worker/PGlite coverage
in `public-answer-tool-worker.test.ts` and `explanation-stage-capability.test.ts`.
They preserve all original cases and add business-only native-v3, forced authorized
selection, wrong-selection zero-effects and exact explanation-source binding.

`npm run probe:native-selection` is opt-in with
`LINGXIOS_LIVE_NATIVE_SELECTION=1`, the existing authorized provider environment,
`LINGXILOOP_SOURCE`, and optional `ISSUE593_SDK_EVIDENCE_PATH`. It uses a fresh
in-memory native database and confined scratch Design tools with the actual
vendored format references/checker. It executes the exact FlashAttention request
through the candidate SDK's real Worker. This is SDK source qualification, not
Loop tenant/product acceptance, production conversation delivery or browser proof.
Only safe diagnostics, receipts and publicly generated fixture artifacts are
saved; prompts, private reasoning, credential values and actual product data are
not retained.

The first SDK probe failed with an unfinished multi-board plan; its original
artifacts were preserved. Its initial paginated event read was incomplete, so an
empty protocolFailures array is not proof of zero failures. The corrected probe
reads all failure rows, uses the production model's 1M context profile, and
requests a complete self-contained explanatory board before adding more boards.
A failed, budget-limited or partially authored result remains unaccepted.

The final `verified-probe/real-model.json` completed in 97910ms: the actual
provider selected the required skill load first, all 11 native actions succeeded,
all recorded protocol/model failures were zero, and the saved FlashAttention
component plus index passed the actual checker with zero problems. Both actual
file-readback verification records passed. The run reports `succeeded`, zero
gaps, and overall semantic verification `inconclusive`; no independent teaching
quality or browser judgment is claimed. `accepted:true` is limited to this
SDK source/contract/resource probe, not formal Loop product acceptance.

Local maintenance qualification: build passed; focused protocol scripts 39/39,
Worker/explanation tests 41/41, and final native selection/order checks 8/8.
The full unit run passed 1242/1243; its standalone-package case failed because
the environment's default npm cache was unavailable. That unchanged case passed
1/1 with the existing writable npm cache and npm CLI configured explicitly.
No failure or original coverage was removed. Formal release-branch qualification,
package publication, then Loop exact-package integration remain required.
