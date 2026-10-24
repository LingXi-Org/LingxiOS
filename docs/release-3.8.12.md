# 3.8.12 explicit correction replacement

When the runtime requests a correction to a sealed answer, the new substantive
answer must explicitly replace all current candidate source IDs in order. A
correction that declares append is rejected before public answer text or a
replacement seal is emitted. The rejected model call remains metered, and the
original sealed answer remains available if correction fails.

Ordinary answers and answer → business tool → answer continuations retain their
declared append behavior. Correction intent is recorded in a fenced runtime
step, so it survives a lost acknowledgement, worker recovery and business-tool
continuation. A valid replacement seal retires that intent; a human request
revision clears it. This adds no model call or text deduplication.

The source change is [PR #65](https://github.com/LingXi-Org/LingxiOS/pull/65),
frozen at `c8754639449ac29d4744c567c66981e079c16f31`, for
[LingxiLoop #406](https://github.com/LingXi-Org/LingxiLoop/issues/406).
[The existing evidence](evidence/loop-406/README.md) records the author's build
and 20 focused tests, including tool/worker recovery and three machine-readable
operation/delta/seal records. Those synthetic results do not establish live
provider or production original-case acceptance.

This release changes the package and compiled runtime identifier to `3.8.12`.
Native schema 14, control-plane 11, kernel 2, assistant-message 2, publicText 3
and runTrace 1 stay unchanged. Existing package installation tests compare the
compiled runtime identifier with the package manifest dynamically.

The release owner must merge the source and version changes, obtain successful
release gates for the exact main commit, and publish through the existing
release process. Consumers must then pin the formal registry package and verify
its integrity and compiled identifiers. This preparation does not publish,
change distribution tags, update product dependencies or deploy.
