# 3.8.14 public output correction and publication diagnostics

This release includes PR #69: distinguish truncated public output from invalid
native tool identity, clarify terminal versus intermediate correction, and
retain bounded internal continuation/publication failure diagnostics. It does
not claim to establish every historical production cause or remove first-body
latency. Product consumers must retain failed-draft projection filtering.

Only the package/runtime patch identifier changes to 3.8.14. Native schema 14,
control-plane 11, kernel 2, assistant-message 2, publicText 3 and runTrace 1 remain
unchanged. Consumers require the formal registry integrity and exact locks;
product57 provenance must use the reviewed CAS boundary rather than a version
stamp or DDL shortcut.

PR #69 source 3e9da60fca07a7b158e19385dde3973661c74179 passed exact release gates
in run 40280161610. This versioned candidate still requires its own release gates
and successful exact main-push gates before matching tag publication. Registry
versions were read before preparation: 3.8.14 was unoccupied; no existing version
or tag is replaced. Qualification attachments were not read because their
storage endpoint denied access; no claim about their unseen contents is made.
