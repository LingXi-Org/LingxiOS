# LingxiLoop #683 maintenance fix

Consumer issue: https://github.com/LingXi-Org/LingxiLoop/issues/683
Base: release/3.8, 9e5742a (v3.8.24). Candidate: 3.8.25.

The 14→10→1→1→1 deterministic receipt fixture reproduces the oldest batch's false failure. The old forward scan also erased the fields required to trace an intermediate replacement. Latest-to-earliest verification now combines later authoritative receipts per mismatched field, retains original readback fields/observations and records final proving action IDs. Readback disagreement remains a failure. Missing, unknown, pending-approval and no-effect receipts cannot be substitution evidence; an explicit authorized deletion can be. Selection also binds the complete work/request authorization identity in SQL.

Failed or unobservable task.check_resource checks are gaps, not fresh verified progress for the correction allowance. The tool description documents shallow exact comparison and retaining not_observed; the resource check implementation and its authorization remain unchanged.

Build and 67 focused assertions passed, including the new 13-case receipt/scope suite (PGlite executes the actual PostgreSQL selection). The 3.8.24 algorithm has matching action-check logic to the initial red reproduction; the initial main-branch reproduction failed the chain, concurrent-readback and no-progress assertions before the fix. The formal patch is on release/3.8, not the incompatible slim 4.x distribution. No database resource, public export or dependency contract is changed.

The full release gate, package qualification, independent review and exact merged maintenance SHA remain required before tagging v3.8.25. Local scripted tests do not establish real-model Slides latency, rendered content or export acceptance. Production rollout belongs to sole integrator task 01a19a90-dfc4-77f7-9803-e9035c481026. The product must use the published exact package and existing runtime patch process; never copy this source into node_modules.
