# Purpose JSON and native tool compatibility

A provider can support JSON object responses and native tool calls separately
without supporting their combination. An authorized synthetic qualification sent
the same lookup instruction and read-only `lookup_fixture({key:"alpha"})`
definition to the same provider twice. With `response_format: {type:"json_object"}`,
the response finished with `stop`, a valid purpose object, and no native tool call.
Omitting only `response_format` produced `tool_calls`, the requested native call
with the exact synthetic argument, and no content. Both requests returned HTTP
200. No tools were executed. This two-request comparison demonstrates a
compatibility failure for that configuration, not a universal provider guarantee
or the exact wire cause of any separate incident.

Two follow-up controls omitted `response_format` while retaining the strict
purpose contract: an arithmetic request with tools available returned a valid
purpose object with the correct answer and no call; a Python request returned
one native `ipython` call with the expected synthetic code. Across these four
requests, each returned HTTP 200 with measured usage, no retry, and no tool
execution. These are narrow compatibility probes, not a reliability benchmark.

The [SiliconFlow API reference](https://docs.siliconflow.cn/docs/api/chat-completions-post)
documents `json_object` as valid-JSON output and lists native tools independently.
It does not establish that every configured model supports their combination.
Hosts should qualify the exact model, endpoint, and mode before setting this flag.

## Explicit compatibility setting

```ts
new OpenAIChatDriver(modelId, {
  apiKey,
  publicTextProtocol: 'purpose-json-v1',
  capabilities: { jsonObjectWithTools: false },
})
```

`jsonObjectWithTools` defaults to `true`, preserving existing request behavior.
Setting it to `false` omits `response_format` only when the generation request
actually exposes native tools, including `ipython`. The purpose instructions and
strict incremental parser remain enabled. Responses with no tool call still need
a nonempty declared answer. Empty content accompanied by a valid native tool call
remains legal. Unframed or malformed content with a tool call rejects the entire
turn; text-embedded tool instructions never become calls.

Requests exposing no tools still request JSON object mode. Structured and
compaction calls retain their JSON format. The driver still requires the
independent `jsonObject` and `toolCalls` capabilities where applicable. There is
no provider-name heuristic, fallback to raw text, new retry, or extra model call.
The opt-out participates in the configuration fingerprint and survives
`singleAttempt()` wrappers. Omitted or explicit `true` preserves the pre-capability
fingerprint because it retains the existing wire request.

## Regression boundaries

`test/purpose-native-tools.test.ts` first reproduces the incompatible request
combination with a synthetic provider. It checks the native call and exact request
fields after opting out, the default request, no-tool generation, implicit Python,
auxiliary JSON responses, and configuration identity. It also checks that
malformed framing is rejected and tool-shaped answer text remains text. Existing
purpose, model, cancellation, usage, and recovery tests remain owning checks.

This setting changes request encoding only. Tool authorization, safety,
cancellation, idempotency, public-purpose attribution, and final acceptance remain
the responsibility of their existing validated boundaries.
