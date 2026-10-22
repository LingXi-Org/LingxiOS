# 3.8.2 terminal trace streaming

3.8.1 preserved `partial` and `blocked` in the public trace reader, but the SSE
phase gate still classified these terminal outcomes as unknown. A correct,
current authorized trace was consequently rejected as null during streaming
or reconnect, although a direct read returned its actual start/end and spans.

The SSE gate now recognizes both states. Fence, request-version, phase,
authorization and bounded optional-read checks remain unchanged. Execution end
is still independent of goal satisfaction; partial/blocked never imply success.
No historical timestamps are reconstructed and no private data is added.

This patch leaves native schema 14, control-plane 11, kernel 2, assistant-message
2, publicText 2 and runTrace 1 unchanged. The public snapshot shape is unchanged.
No model, correction, child-admission or approval budget changes are included.

The new regression reads the actual terminal stream with `trace:true` for both
states, using fresh and beyond-last-event reconnect cursors, and requires the
exact direct-reader snapshot including revision and real boundaries. Before
the fix both cases failed with null traces (0/2); after the fix they pass (2/2).
This evidence is synthetic and cannot attribute an original production run.

Release uses exact-head PR gates, sole-integrator merge, exact-main release
gates, then tag `v3.8.2` and `publish-package`. Consumers must wait for the formal
package and verify registry integrity/compiled identifiers. This branch does
not merge, tag, publish or deploy. Related: [issue #42](https://github.com/LingXi-Org/LingxiOS/issues/42)
and [LingxiLoop #298](https://github.com/LingXi-Org/LingxiLoop/issues/298).
