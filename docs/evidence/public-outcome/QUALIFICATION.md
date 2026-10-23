# Synthetic qualification

Base: published source `37a87729b450ee85457e65c65b17e578b335529b`.
The package version is unchanged in this development candidate; release integration
must publish a new version rather than replacing a published package.

Tests were added before implementation. The initial build succeeded and 58 tests
reported 49 pass / 9 fail, including partial/blocked being inferred satisfied,
missing terminal declaration falling back to satisfied, and unsupported v2 wire.

After implementation, the build and this owning selection passed **104 / 104**,
zero skips and zero failures:

```sh
npm run build
node --test --test-concurrency=1 \
  dist/test/public-outcome.test.js \
  dist/test/conversation-content-repair.test.js \
  dist/test/public-purpose.test.js \
  dist/test/public-purpose-worker.test.js \
  dist/test/protocol-recovery.test.js \
  dist/test/completion.test.js
```

Coverage includes real driver synthetic SSE parsing, answer delivery before
metadata, Unicode/escaping, mandatory bounded declarations, tool-only and
intermediate null declarations, cancellation, observed usage on rejection,
immutable v1 identity, custom-producer behavior binding, native unresolved action
precedence, and refusal to execute calls carrying invalid terminal metadata.
The PGlite-backed actual Worker executes one read, publishes answer content before
provider EOF/tool execution, commits the v2 declared partial result, and replays
it through public state and SSE. There are two generation calls for the tool
round trip and zero auxiliary model calls. Plain terminal fixture cases each use
one generation and zero judges.

All requests, model responses, identities and tool effects are synthetic and local.
This is not a production completion-rate or latency measurement. No paid provider,
production state, schema migration, dependency/version change or publishing action
was used by this candidate. Exact remote CI and independent review remain separate
gates recorded on the pull request.
