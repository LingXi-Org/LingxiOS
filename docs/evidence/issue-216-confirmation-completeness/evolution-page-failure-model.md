# Segmented evidence and optional strategy candidates

The real final product run has an apply receipt with approved=true, no fact
changes, one strategy candidate, and transaction_rolled_back. The first source
was a partial page. Native proposeEvolution requires global evidence processed,
so optional candidate handling rolls back the page. Existing durable retry later
succeeds when the model emits no candidate. This is distinct from malformed
review shape: the earlier inference from event timing was not sufficient.

Before changing code, cover: partial-page load must not advertise candidates;
ordinary fact apply on that page must advance without registry work; a complete
accepted source in the current scope can propose/evaluate while another scope
is still pending; rejected/incomplete/currently forgotten sources cannot do so.
Keep legacy unsegmented complete source compatibility, but never treat truncated
legacy evidence as complete. Preserve frozen benchmark/lease/version/epoch and
independent evaluation gates. Do not grant active strategy status at proposal.
