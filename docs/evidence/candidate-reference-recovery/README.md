# Failed candidate correction and exact request references

Addresses LingxiLoop #579 and #582. It does not establish the missing historical rejection field for #515/#518/#560, or prove a real provider completed an artifact.

## Behavior

Failed v3 answer candidates now have metadata-only recovery records written atomically with their failed end. Corrections explicitly replace that failed revision; a failed append occupies one logical position without replacing an independently sealed prefix. Failed replacement chains inherit their original target set. Only sealed sources can enter a candidate, model history, or final accepted result. A lost end acknowledgement stops further generation until durable recovery. Native failure steps are reserved from generic worker saveStep, and the behavior binding changes so an old in-flight run cannot silently adopt this contract.

`skills.activate` retains exact request provenance. Existing unique literal quotations remain supported; a selector can instead use the existing trusted request `sourceRef`, optionally with exact UTF-16 `start`/`end` offsets. Whole-source selection avoids copying and rewriting line breaks or pasted formulas. Current-user authorization, source identity, range, Unicode, and immutable replay checks remain. Pure authoring does not require an explanation declaration. Invalid references produce closed `explanation_reference_invalid`, `explanation_reference_not_found`, or `explanation_reference_ambiguous` causes under `invalid_input`, with safe correction guidance and a correlation ID. They are not automatic retryable writes.

## Owning checks

Run `npm run build`, then the focused scripts listed in `.github/workflows/release.yml`. Focused regressions cover the three failed lineage shapes, atomic publication rollback and duplicate acknowledgement, strict source selection, final commit verification, live/replayed projection, lost end ACK, multiline/repeated formulas, invalid/foreign/ambiguous references, current request source binding, schema compilation, and native-v2 argument preservation. SQL transaction tests use a controlled pool, not a claim of production PostgreSQL acceptance.

Independent peer review found an uncertain failed-end ACK problem; the subsequent change stops generation and retains the publication error. The final delta was reviewed. No raw provider text, private request, credential, or production data is in these fixtures.

## Release boundary

The native-v2 mandatory public output schema now appears first in both the actual tool catalog and its budget estimate. Its declaration and correction guidance make the required batch order explicit. Business schemas and dispatch validation are unchanged, and native-v1 retains independent business turns. Safe diagnostics distinguish `public_answer_missing` from `public_answer_misordered` after identity validation, without saving generated arguments. Regression fixtures prove both remain rejected without public deltas and preserve reported usage. Catalog alignment is a deterministic contract improvement, not proof that a live model will obey it; successful real-provider artifact delivery remains a separate acceptance requirement.

Main is the slim 4.0 line. A compatible implementation must also be qualified on `release/3.8`, retaining that branch's existing dependency, database and release gates. Do not release main as a 3.8 package. Formal package publication and exact Loop lock/provenance upgrade belong to the designated publisher. Existing readers and control plane must understand failure recovery metadata before a producer emits the new relationships. No package publication, production deployment, browser acceptance, or successful real-model artifact delivery is claimed here.
