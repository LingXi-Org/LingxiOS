# Background scheduling failure matrix (written before implementation)

Scope: upstream LingxiOS background scheduling only. Baseline `de79dd355a08e2b18a4a32ccd099eef29e9b7678`.

| Failure | Required behavior | Evidence planned |
| --- | --- | --- |
| A context-only worker creates another control app | Explicit passive role starts no maintenance/outbox timers or LISTEN connection; public API still works | PGlite public app test, query/connect counters |
| Existing caller omits background options | Active scheduling and durable outbox delivery still happen | Default app integration test |
| Empty queues indefinitely consume SQL/pool slots | Empty scans double delay to configured maximum; periodic sweeps remain bounded | Fake-time scheduler test |
| Busy queues inherit old empty backoff | Activity resets delay to minimum | Fake-time scheduler test |
| Notification arrives while sleeping | Wake immediately, coalescing duplicates | Scheduler test + public app notification test |
| Notification arrives during a scan | Remember another scan after completion, with no lost wakeup | Deferred-operation scheduler test |
| One transport lane stalls while a healthy stream arrives | Other free lanes restart, bounded by lane and global DB limits | Existing outbox lane integration + overlapping scheduler test |
| Database or callback repeatedly fails | Bounded exponential retry, no unhandled rejection; later success recovers | Fake-time scheduler test |
| Multiple channels, maintenance and a transaction contend | Background acquisitions stay within one shared cap; permit held through transaction and released once | Controlled pool concurrency test |
| Shutdown while waiting for a permit | Abort waiters without acquiring new connections or retaining listeners | Pool cancellation test |
| Shutdown during an acquisition/query/delivery | Cancel active work, release late clients, retain durable pending intent if acknowledgement fails | Pool shutdown test, outbox test |
| Repeated shutdown / notification after shutdown | Same shutdown promise, no timers, queued jobs or further scans | Scheduler and public app tests |
| Notifications unavailable or disabled / notification lost | Backoff maximum and low-frequency sweep still find durable work | Scheduler periodic sweep + default app polling test |
| Invalid role, concurrency or timer range | Reject before acquiring DB resources | Public option validation test |
| Stale result, revised/cancelled run, expired owner | Existing fencing predicates and claim-token acknowledgements stay intact | Existing outbox and fencing/reliability tests |

No production deployment, 24-hour soak, heap-leak resolution, or product #153 metrics/configuration claim is made here.
