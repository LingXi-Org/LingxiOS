# Open task verification schemas with required native calls

The task receipt expectation accepts every JSON value. The task resource checker
accepts open argument and expected-field maps, retaining its 1–16 field limit.
The catalog now states those defaults explicitly: all six JSON value types for
the receipt expectation, and `additionalProperties: true` for both resource maps.
These are equivalent to the previous empty schema and omitted map keyword.

An isolated synthetic SiliconFlow / DeepSeek-V4.1-Flash probe reproduced empty
`stop` responses with no native tool calls when the original resource checker
was present under `tool_choice: required`. The explicit open-map spelling
returned a valid native answer in the matched follow-up. The original receipt
schema reached the diagnostic's 512-token limit; its explicit JSON type union
returned a native answer. These observations support the narrow serialization
compatibility candidate; they do not establish supplier internals or failure
rates, and the receipt truncation is not the same symptom as the empty response.

The full catalog, native selection policy, schema validation, authorization,
receipt comparison, resource refresh and bounded protocol corrections remain
active. No fallback parses prose as tool calls, restricts arbitrary JSON values,
removes a tool or replays a business action. Normal catalog fingerprints include
the changed schemas. There are no database or credential changes.

Offline tests compare both schema forms across JSON values and open maps, retain
negative verification cases, and check estimated and actual native wire schemas.
`scripts/probe-task-schema-compat.mjs` provides an explicit opt-in synthetic
live reproduction. It requires existing provider configuration, accepts 1–4
named cases, permits one HTTP request per case, limits output to 512 tokens and
logs only structural results/usage. It never dispatches returned business calls.
Run through the environment's normal proxy-aware fetch setup. Full product
qualification remains a separate release gate.
