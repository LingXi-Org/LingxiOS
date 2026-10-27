# LingxiLoop #533: public tool rounds

Base: `f24784b1c91a8591eeb4a921b9ac4db7bab4cb2c` (formal SDK 3.8.14 source).
Old interrupted task changes were unavailable in this environment and were not migrated. These are new changes and new measurements. No archived agent was resumed.

## Contract

`publicAnswerTool: native-v2`, with v3 typed messages, `jsonObjectWithTools:false` and `parallelTools:true`, requires exactly one `public_answer` at native index 0, followed by zero or more original-schema business calls. The mixed call carries a nonempty substantive answer and `outcome:null`. Commentary may accompany it. A terminal outcome cannot accompany business calls. Raw companion/reasoning stays private. `native-v1` remains supported with its original single-call policy and fingerprint.

The whole batch is validated before sealing or dispatch. Public text uses the existing operation/delta/end/seal and source recovery records. The existing scheduler overlaps read-only batches and serializes writes/mixed effects; approvals, idempotency, fencing, authorization, cancellation and budgets keep their owning paths. Native-v2 tool-error guidance remains an observation for the next decision; it does not invalidate already sealed answer content or force a full rewrite. Actual answer repairs retain replacement semantics.

No summary model, new review model, fixed extra loop or UI-generated summary is added. A simple answer finishes in one generation. Observation wording is model-generated, not semantically guaranteed by a parser.

## Verification

Commands run on Node 24.19.0 after `npm ci --cache /tmp/533-npm-cache --ignore-scripts --no-audit --no-fund`:

- `npm run build`: passed (includes source and test typechecking).
- `node --test dist/test/public-tool-rounds.test.js dist/test/public-answer-tool-driver.test.js`: 31 passed.
- `ISSUE533_EVIDENCE_DIR=docs/evidence/issue-533 node --test dist/test/public-answer-tool-worker.test.js`: 28 passed. Exercises the real Worker and PGlite; includes approval pause, cancellation, failures, sealed history recovery, source replacement and the unchanged native-v1 path.
- Synthetic comparison: identical useful answer, two read observations, one write, stage and final content. Native-v1 needs six generation responses and max one read at once; native-v2 needs three and max two reads at once. Both have one write and zero auxiliary calls. `native-v1.json` / `native-v2.json` retain actual public persisted events, final state and relative timings. Fixture tokens are fixed synthetic values, not provider charges.

The partial-failure regression initially caught tool-error continuation being treated as answer replacement. It now checks that the actual failed observation reaches the next request, the truthful limitation remains in the final partial message and no answer-correction intent is created.

## Controlled real provider

`NODE_USE_ENV_PROXY=1 node scripts/check-public-tool-rounds.mjs <evidence-path>` uses configured SiliconFlow credentials without printing them, explicitly selects DeepSeek-V4.1-Flash, and permits only two local synthetic read tools. No production database, product writes, Worker or browser is involved. Each request has maxAttempts=1; v1 is capped at one generation, v2 at three. There is no protocol correction loop.

`provider.json` records the actual 2026-10-27 sample:

| Profile | Result | Requests | First provisional public body | Tool starts | Total |
| --- | --- | --- | --- | --- | --- |
| native-v1 | protocol failure (`public_text_invalid`), no business call | 1 | 4566.99 ms (unsealed; not successful delivery) | none | 8592.66 ms |
| native-v2 | completed explanation, two reads, observation-based conclusion | 2 | 2058.94 ms | 5054.88 ms | 9401.76 ms |

V2 reported 2455 input tokens and 569 output tokens in total, zero reasoning tokens. Its concluding generation took 4346.69 ms. V1 failure usage was not retained by this script; cost was not measured for either profile and no provider billing receipt is available. A failed baseline and one successful sample do not establish a general latency improvement. Live result content described fixed demonstration observations, not a real network benchmark or a delivered interactive component.

## Delivery boundary

This is an upstream source change, not a published SDK. Do not enable native-v2 in LingxiLoop against SDK 3.8.14 or patch node_modules. After formal publication, update both product manifests and locks to that exact version and explicitly activate native-v2/parallelTools for the qualified model. The product UI change consumes the unchanged existing public event protocol.

No package publication, merge, deployment, production operation or browser acceptance was performed. The production screenshot's exact run/event history remains unverified; no claim is made that production #533 is resolved. Source-built Worker testing and controlled provider testing are separate evidence, not a live production end-to-end run.
