# Repeatable synthetic delivery measurements

The same [harness](../../../scripts/measure-protocol-experience.mjs) exercises the
real HTTP driver, public answer persistence, Worker, PGlite schema, model ledger
and terminal result. It sends no external requests and uses no credentials or
external conversation content. Baseline source is
`64f2adbac3310280a9bd776531d464e6acb48686`; candidate runtime source is
`155f680c945a9719b2002f0ff6742b0875929d1b`. Both were freshly built and run
sequentially with Node 22.23.3, three repetitions and identical 25 ms + 25 ms
stream pacing per model attempt. Raw samples, source IDs and harness SHA-256 are
in [baseline](experience-baseline.json) and [candidate](experience-candidate.json).

First useful answer time starts at Worker execution and ends after the substantive
synthetic answer has passed the real public callback's durable append. Commentary
is excluded. This deliberately waits for the useful short answer, rather than
counting its framing or an isolated first character. Full delivery requires the
exact expected durable body, `succeeded` and `response.committed`. Tail time runs
from the last answer callback to completion of `worker.runNext()`. It includes
native terminal work but excludes browser rendering and external IM delivery.
Failed answers have null timings, never zero.

| Scenario | Full delivery before → after | Generation calls before → after | First useful answer, candidate median | Native tail, candidate median |
| --- | --- | --- | --- | --- |
| Normal LF stream control | 3/3 → 3/3 | 1 → 1 | 231.007 ms | 181.458 ms |
| Buffered CRLF/LF separator | 0/3 → 3/3 | 3 → 1 | 192.056 ms | 153.373 ms |
| Empty answer requiring targeted correction | 0/3 → 3/3 | 3 → 2 | 295.815 ms | 123.170 ms |

The normal baseline medians were 267.697 ms first useful answer and 206.965 ms
native tail. Those small differences are local timing noise, not evidence of a
general performance improvement. The relevant change is deterministic recovery
of the two failing fixtures with fewer calls, exact committed answers and every
reservation settled. Persistent errors still stop at the existing protocol cap.
These measurements do not establish live-provider completion rates, browser
latency or a production service-level guarantee.

Reproduce after building both checkouts, using the same harness file for both:

```sh
node scripts/measure-protocol-experience.mjs /path/to/baseline baseline 3 > baseline.json
node scripts/measure-protocol-experience.mjs /path/to/candidate candidate 3 > candidate.json
```

The harness rejects dirty runtime sources. Its recorded source ID identifies
runtime behavior; a later evidence-only commit does not change that behavior.
