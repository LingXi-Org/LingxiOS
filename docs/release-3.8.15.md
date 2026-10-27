# 3.8.15: public tool rounds

Adds explicit native-v2 public-answer/business-tool batches for v3 typed messages. Useful public text is persisted before effects; independent reads retain existing parallel scheduling and writes/approvals retain existing serialization, authorization, idempotency, fencing and cancellation. Native-v1 remains compatible. Failed tool observations do not force a rewrite of prior useful native-v2 answer text.

No schema/control/kernel/public-event version change. Consumers opt in explicitly with publicAnswerTool native-v2 and parallelTools true only for qualified providers. Published product dependency locks must match this exact formal package before enabling it.

See docs/evidence/issue-533 for the 31 driver / 28 Worker-PGlite tests, synthetic 6-to-3 generation comparison and bounded real DeepSeek sample. The latter used two synthetic reads, not a live product run or network benchmark. Formal release remains gated by successful PR and exact main release-gates, then the existing tagged publish-package workflow.
