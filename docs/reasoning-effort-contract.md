# Explicit reasoning effort

The built-in OpenAI-compatible driver accepts `low`, `high`, or `max` for the
main/structured `reasoningEffort` and the independent
`compactionReasoningEffort`. Both are omitted by default. Compaction does not
inherit the main effort. For a provider that supports these parameters:

```ts
const worker = createWorker({
  controlPlane,
  model: {
    id: 'your-model',
    apiKey: process.env.MODEL_API_KEY!,
    baseUrl: process.env.MODEL_BASE_URL!,
    reasoningEffort: 'low',
    compactionReasoningEffort: 'low',
    maxThinkingTokens: 0,
    auxiliaryStreaming: true,
  },
})
```

`maxThinkingTokens: 0` still sends `enable_thinking: false` without a thinking
budget. An explicit effort does not override that setting. Explicit compaction
effort also disables thinking and omits a budget. Provider interpretation of these fields
varies; `low` itself does not mean reasoning is disabled.

`auxiliaryStreaming` defaults to `false`. When enabled, structured and compaction
requests use SSE internally, including usage chunks; only final content is
returned. Existing first-byte, idle, request, total, and cancellation bounds
still apply. Reasoning chunks count as received body bytes but never become
user previews or returned content. A stream needs an explicit `stop` finish
reason; clean EOF without `[DONE]` remains compatible. Structured output must
parse as JSON; compaction continues to return a string.

Standalone workers expose `AGENT_OS_REASONING_EFFORT`,
`AGENT_OS_COMPACTION_REASONING_EFFORT`, and `AGENT_OS_AUXILIARY_STREAMING`.
Unknown effort values and invalid booleans fail configuration validation.
Explicit new options change the provider configuration fingerprint; leaving
them unset (or setting streaming to false) preserves the existing fingerprint.
Retry clones retain all three options. No schema or protocol migration is needed.

Usage already received is retained when a later stream read, idle timeout, or
parse failure rejects the response. Caller cancellation can still settle the
outer runtime reservation before the driver reports that usage; the existing
conservative estimated settlement in that race is unchanged. Cancellation
continues to close the stream and allow a subsequent request.

## Failure model and validation

Failure model recorded before implementation for LingxiLoop issue 197:

- A supported `low` effort is rejected by public worker configuration, driver
  validation, or the standalone worker's environment parser.
- Structured reviews lose the configured main effort, or compaction silently
  removes an explicitly configured compaction effort.
- Adding an effort enables thinking despite `maxThinkingTokens: 0`, adds a
  thinking budget to compaction, or changes requests from existing callers that
  omit the new option.
- Retry/single-attempt clones lose either option, or a changed compaction policy
  reuses the previous provider configuration fingerprint.
- Unknown effort values reach a provider; tests claim provider compatibility
  without observing actual provider behavior.

Validation uses a local HTTP model fixture through the public worker factory,
including streamed turns, structured JSON, compaction, retry, and durable usage
observations. Driver and CLI checks cover invalid configuration and unchanged
defaults. No production credentials, model responses, prompts, or memory are
included in evidence. This is a parameter contract test, not a live-provider
performance or compatibility claim.

The GLM-5.3-Flash publisher documents `low`, `high`, and `max`, with omitted effort
defaulting to `max`: <https://huggingface.co/zai-org/GLM-5.3-Flash#note>.
Provider-specific acceptance of these parameters requires separate validation.

The optional auxiliary streaming extension has additional failure modes:

- Existing callers silently switch protocols, or a retry clone loses the opt-in.
- Reasoning fields leak into structured values or compaction summaries.
- Separate usage chunks are lost, including usage from rejected output.
- Length truncation, malformed JSON, missing finish reason, premature DONE, empty content, or
  unexpected tool calls become a successful auxiliary result.
- Cancellation, idle, request, or total deadlines stop bounding a stream; a
  failed stream leaves the next request unusable.
- Usage received before a later idle/read failure is replaced by an estimated
  full reservation, or a truncated trailing SSE event is silently discarded.
- Attaching received usage changes the original error category and consequently
  the circuit/retry policy for malformed provider events.
- Configurations with different auxiliary protocols share a fingerprint, or
  explicit false changes an otherwise unchanged configuration fingerprint.

HTTP regression fixtures cover these failures before implementation. Compaction
retains its string return contract; structured calls additionally parse JSON.
Clean EOF with an explicit `stop` remains accepted, even without a `[DONE]` event.
Trailing complete comment lines remain valid; an unfinished data event does not.

## Auxiliary first-byte reproduction

Before changing timeout or wire behavior, a synthetic HTTP server tests the
following failure model separately: a non-streaming response has no body bytes
until its complete JSON is ready, so a 60 ms first-byte budget can abort it even
when its 120 ms completion fits within a 500 ms request/total budget. Structured
and compaction calls should reproduce that timeout. The same server streams a
reasoning delta every 20 ms and final content at 120 ms; a streamed turn should
complete, and only final content may appear in text previews. This is a
characterization of current timeout semantics, not a claim about any provider.

Reproduce with `npm run build`, then
`node --test --test-concurrency=1 dist/test/auxiliary-timeout.test.js dist/test/auxiliary-streaming.test.js dist/test/reasoning-effort.test.js`.
Tests print synthetic timing samples for both default and opt-in behavior.
