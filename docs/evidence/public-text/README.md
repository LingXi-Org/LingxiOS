# Durable public text validation

The exact implementation commit is `e03cc2dbd8aa178253d37c4931fd7ba6d5e5eef6`. The [manifest](manifest.json) records Node, build/test commands, result counts, raw-log hashes and explicit limits. [Source hashes](source-sha256.json) identify every changed source/test file. [Case results](test-cases.json) contain only synthetic case names and durations.

The final selected suite passed **171/171** in **83.01 seconds**, with build exit 0. It includes durable authorization, storage/backpressure, child-process recovery, safety coalescing, cancellation, result-commit rollback, lost COMMIT acknowledgement, current native authorization, old-fence replay and protection against unrelated or forged acceptance associations. The measured first-content-to-tool-reading-durable-prefix time was **65.66 ms** in one local synthetic sample; this does not measure browser rendering or define an SLA.

Earlier failing behavioral cases are preserved as red evidence; they are not replaced with green receipts. The safety matrix used the actual product policy at its recorded ancestor commit. The local package still has base-version metadata and is **not an official release**. Formal publication and product end-to-end acceptance remain separate gates. No production trace, memory body, credential, topology or operational inventory is included.
