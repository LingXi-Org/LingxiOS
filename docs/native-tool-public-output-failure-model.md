# Native tool public output v1 — failure model and verification

The explicit v3/no-combined-JSON/single-tool driver option must carry declared
public output in the same native call as business arguments. It must expose
answer characters before the answer string closes and before business arguments
finish. It must not add a generation, infer purpose from prose, or change old
bindings. The existing public-purpose parser owns public grammar and operation.

Failure cases to exercise:

- Character fragmentation, raw Unicode, escaped surrogate pairs and nested
  business strings containing apparent envelope delimiters cannot corrupt text.
- Missing/duplicate/extra outer keys, malformed or truncated JSON,
  terminal outcome in a tool envelope, trailing JSON and invalid business schema
  fail the whole attempt. Early text remains provisional; no valid result exists
  for runtime sealing or dispatch.
- Either outer member order is valid; arguments-first must not be reported as
  early public output. Public operation still precedes public answer text.
- A second native call, unknown/late-mutated tool identity, content plus envelope
  output, inconsistent finish and cancellation cannot produce a successful turn.
- Original business argument bytes, tool identity, history and side-effect hashes
  remain canonical. Provider history alone is rewrapped with null public output.
- Embedded schema resources preserve draft-07/2020-12, local root references,
  definitions, IDs and anchors. No remote lookup or coercion is introduced.
- The opt-in policy enters the fingerprint and survives singleAttempt. Private
  protocol selection disables the feature with its own distinct binding.
- Real wire schema/history/instruction overhead is included in context and ledger
  admission. No-tool requests remain one ordinary v3 generation.

These are synthetic tests, with no provider calls, production access or side
effects. Actual provider support and performance remain separate qualifications.

## Source reuse and binding

The installed dependency is `@streamparser/json@0.0.26`, MIT, npm gitHead
[`d0008ab997e0c86f6f8c544d172a3f7e0b096357`](https://github.com/juanjoDiaz/streamparser-json/tree/d0008ab997e0c86f6f8c544d172a3f7e0b096357).
The adapter directly imports its public `Tokenizer` and `TokenParser`, enables
`emitPartialTokens`, and uses UTF-8 byte offsets to locate the two outer members.
The dependency owns JSON grammar and tokenization. Original public JSON slices
go to the existing `PublicPurposeParser` on every input write, before string
closure; the adapter does not create another JSON grammar or infer text purpose.
The ordinary v3 segment/operation seal and native execution lifecycle remain the
only publication and effect authority. Package distribution retains the license.

This follows the schema-to-native-tool binding and typed parse separation in
LangChain's [`OutputToolBinding`](https://github.com/langchain-ai/langchain/blob/3d3b0034a94e49c8547ec38b371a31f8620850d9/libs/langchain_v1/langchain/agents/structured_output.py#L318),
adapted to the qualified single-call provider. It does not import LangChain's
extra structured-output tool, graph executor or retry loop. Existing installed
LangChain chunk/segment reducer reuse continues downstream unchanged.

`nativeToolPublicOutput: 'envelope-v1'` explicitly binds v3, no combined JSON
response mode, and `parallelTools:false`. Its fingerprint differs from old
bindings; singleAttempt preserves it, private v2 selection removes it. Plain
companions retain their prior unpublished policy. Typed content/envelope
conflicts and JSON-framed primitive companions fail. No provider capability is
inferred from successful synthetic fixtures.

The development-only `scripts/probe-native-public-output.mjs` is prepared for the
sole release owner, not executed by this task. It requires clean frozen source,
matching expected SHA, a fresh exclusive evidence file, the existing approved
provider environment, and a rebuilt driver. It makes exactly one generation,
dispatches no tools, and records only bounded synthetic public answer/timing and
structural diagnostics. Its result is not a product or semantic qualification.

## Offline verification

The failure matrix was written before implementation. The final focused command
passed **105/105 tests**, including **8 actual PGlite/Worker scenarios**:

```sh
npm run build
node --test --test-concurrency=1 \
  dist/test/native-tool-public-output.test.js \
  dist/test/native-tool-public-output-driver.test.js \
  dist/test/native-tool-public-output-worker.test.js \
  dist/test/public-purpose-tool-turns.test.js \
  dist/test/react-wire-boundaries.test.js \
  dist/test/model-execution.test.js \
  dist/test/tool-failure-recovery.test.js
node --check scripts/probe-native-public-output.mjs
git diff --check
```

The Worker gate observes a persisted provisional answer while both its JSON
string and business arguments are unfinished. A valid batch then seals once and
executes the original business action once; its null terminal answer retains the
sealed source. Invalid schema, truncation, typed dual-channel conflict and a
second native call do not seal the early source or dispatch. Cancellation and
authorization denial retain existing runtime behavior. The uncertain-effect case
calls the real host execution path again with the same work/action identity and
gets the same durable unknown receipt without another execution. This is a
same-identity receipt check, not a simulated process-restart qualification.

Schema tests compare original and wrapped validation, including draft-07 and
2020-12 local definitions, empty and relative IDs, named draft-07 root anchors,
recursion and nested relative child resources. Relative document IDs resolve
against an isolated absolute base using the standard URL implementation; refs
inside the business schema are not rewritten. Draft-07 named root fragments use
a sibling alias back to that resource. Invalid original schemas remain invalid.
Alternating same-ID schemas and catalog isolation verify Ajv resource cleanup.

Input reservation and context admission use the greater of the old estimate and
the actual wrapped generation wire estimate through quota/execution wrappers.
The unchanged path retains its fingerprints and input estimates; private v2,
structured calls and compaction do not receive the envelope. Plain companions
remain unpublished while JSON primitive and typed dual-channel conflicts fail.
No live provider, production, browser or release qualification was performed.
