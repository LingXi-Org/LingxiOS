# LingxiOS

灵犀通用 Agent 执行运行时，为应用提供持久任务、故障恢复、工具事务、审批与可验证结果。

Part of [LingXi · 灵犀](https://github.com/LingXi-Org). Source lives in [LingXi-Org/LingxiOS](https://github.com/LingXi-Org/LingxiOS); [LingxiLoop](https://github.com/LingXi-Org/LingxiLoop) is a consuming learning-collaboration application, and [LingxiLit](https://github.com/LingXi-Org/LingxiLit) is the organization's OpenLIT-based observability project. The published package remains `@lyyzka/lingxios` on GitHub Packages.

LingxiOS is a product-neutral agent execution runtime for Node.js and PostgreSQL. It provides durable requests, fenced workers, native tool transactions, recovery, approval and input waits, model budgets, verified outcomes, committed artifacts, delivery outboxes, and versioned memory.

The package has four public entries: `@lyyzka/lingxios`, `@lyyzka/lingxios/worker`, `@lyyzka/lingxios/ui`, and `@lyyzka/lingxios/eval`. Product rules and services stay in the consuming application.

## Install

```sh
npm install @lyyzka/lingxios@4.0.1
```

Configure the GitHub Packages registry for the `@lyyzka` scope before installing:

```ini
@lyyzka:registry=https://npm.pkg.github.com
```

Requires Node.js 22.13+, PostgreSQL, and Python 3. Install `packageResources().schema` through the product's explicit migration process before an application starts. LingxiOS performs read-only schema checks at startup and never applies DDL itself.

See [performance configuration and measured framework results](docs/performance.md) for authenticated SSE drafts, notification wakeups, resource limits, and the required schema-10 additive migrations.

## Control plane and Worker

```ts
import { createLingxiOS } from '@lyyzka/lingxios'
import { createWorker } from '@lyyzka/lingxios/worker'
import { pool } from './database.js'
import { context, delivery, tools } from './native-agent-bindings.js'

const control = await createLingxiOS({
  database: pool,
  tools,
  contextProvider: context,
  delivery,
  homesRoot: '/persistent/agent-homes',
})

const worker = createWorker({
  controlPlane: control,
  model: { apiKey: process.env.AGENT_MODEL_API_KEY! },
  kernel: { homesRoot: '/persistent/agent-homes' },
})

await control.enqueue({
  id: 'request-1',
  tenantId: 'tenant',
  agentId: 'assistant',
  sessionId: 'conversation',
  principalId: 'authenticated-user',
  text: 'Create the requested document and verify it.',
})
await worker.runNext()
console.log(await control.readRunState({
  runId: 'request-1', tenantId: 'tenant', agentId: 'assistant',
  sessionId: 'conversation', principalId: 'authenticated-user',
}))

await worker.stop()
await control.stop()
```

Creating a control plane never claims work. A Worker receives the model, Kernel, runtime policy, and optional native processors. Web/API processes expose authenticated ingress and control operations; Worker processes alone execute tasks.

## Native tools and recovery

Each `ToolDefinition` supplies one input parser and model-visible schema plus authorization, effect type, execution, approval preview, reconciliation, and verification. Validation and authorization occur before an action intent is recorded. PostgreSQL writes receive the same transaction as their action receipt. Reads may be retried; confirmed receipts are restored; unknown external effects wait for reconciliation.

Work lifecycle, goal outcome, and delivery state are separate. `readRunState()` returns a consistent snapshot of all three. A `satisfied` goal requires current authoritative checks when the request created resources; model self-assessment alone cannot mark verification as passed.

Evolution candidates remain inactive until a frozen benchmark improves target cases, passes authorization, approval, isolation and code-mutation gates, and does not regress its holdout set. Active strategy references are pinned per run and can be rolled back through the trusted control API.

Production Python execution requires OS isolation. The packaged Worker defaults to Linux Bubblewrap in production and fails readiness when the isolation self-check fails. Artifact downloads verify the committed path, size, and SHA-256 digest.

See [runtime and deployment details](docs/packaged-runtime.md), [Harness semantics](docs/harness-v3.md), and [production recovery](deploy/README.md).

Optional `control.memory` provides scoped Markdown documents, always-loaded core memory, Chinese/English PostgreSQL search, committed history, versioned edits, background reflection, diagnostics and rollback. Version 4.0.1 requires schema 11 and protocol 12, including distributed workspace checkpoints. Schema-9 installations apply `packageResources().migration010`, then `migration011` and `migration012` and `migration013` (schema-10 installations need migrations 011-013); existing memory and business records remain intact. IM conversation policy, multi-Agent reply slots, durable DAGs and field-versioned shared state are available through the [IM collaboration API](docs/im-collaboration.md). See the [memory configuration and cutover procedure](docs/packaged-runtime.md#cognitive-memory).

## Jev semantic decisions

Pass `decisions: { apiKey: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0', mode: 'shadow' }` to `createWorker`. The standalone worker reads `TYPESAFE_API_KEY`, `JEV_MODEL` and `JEV_MODE` (default `shadow`). No key leaves existing generative reviewers unchanged. `active` replaces memory-write and memory-synthesis verification, adds grounded delivery/citation checks and reranks authorized recalled memory. Memory proposals and user-facing generation still use the generative model.

`modes` overrides individual purposes: `memory-write-review`, `memory-synthesis-verification`, `content-review`, `memory-relevance`, and product-defined purposes. `off` skips a purpose; `shadow` pays for Jev but retains existing results; `active` uses Jev. Approval requires both confidence and chosen probability >= 0.95; this conservative threshold is not a claim of calibration. Active safety-review failures fail closed; advisory ranking failures preserve original context. Question/state limits reject oversized inputs without truncation. No automatic retries.

All worker decisions use existing fenced root reservations and durable model accounting, at $0.042 per million input tokens and zero output cost by default. The optional trusted `RuntimePolicy.prepareDecisionContext` hook receives the budgeted driver, live authorized context and frozen request; it must never grant permissions or change product state. `reviewAnswerWithDecisions` in the eval export is an explicit standalone review API; callers own its separate budget.

Protocol 12 adds `decision` model observations. Drain existing work before upgrading the control plane and workers together; schema stays at 11. Old workers/control planes cannot mix with protocol 12. Downgrade requires restoring a matching installation version and draining again, never rewriting active run bindings. Validate Chinese/domain quality before switching sensitive purposes from shadow. Run the opt-in synthetic smoke with `node scripts/eval-jev.mjs ENV_FILE REPORT_FILE`; only aggregate results and case IDs are recorded.

The control plane recognizes the pinned Jev model rate independently of the generative model. For other fixed model versions or price changes, supply trusted `createLingxiOS({ modelPrices: { 'jev-1.13.0': { inputCostMicrosPerMillion: 42000, outputCostMicrosPerMillion: 0 } } })` alongside matching Worker prices. Reservations retain their original price through settlement; never derive billing from the worker's reported total. Use 4.0.1 or later for Jev accounting (4.0.0 incorrectly used the generic control-plane rate).
