# LingxiOS

灵犀通用 Agent 执行运行时，为应用提供持久任务、故障恢复、工具事务、审批与可验证结果。

Part of [LingXi · 灵犀](https://github.com/LingXi-Org). Source lives in [LingXi-Org/LingxiOS](https://github.com/LingXi-Org/LingxiOS); [LingxiLoop](https://github.com/LingXi-Org/LingxiLoop) is a consuming learning-collaboration application, and [LingxiLit](https://github.com/LingXi-Org/LingxiLit) is the organization's OpenLIT-based observability project. The published package remains `@lyyzka/lingxios` on GitHub Packages.

LingxiOS is a product-neutral agent execution runtime for Node.js and PostgreSQL. It provides durable requests, fenced workers, native tool transactions, recovery, approval and input waits, model budgets, verified outcomes, committed artifacts, delivery outboxes, and versioned memory.

The package has four public entries: `@lyyzka/lingxios`, `@lyyzka/lingxios/worker`, `@lyyzka/lingxios/ui`, and `@lyyzka/lingxios/eval`. Product rules and services stay in the consuming application.

## Install

```sh
npm install @lyyzka/lingxios@3.5.6
```

Configure the GitHub Packages registry for the `@lyyzka` scope before installing:

```ini
@lyyzka:registry=https://npm.pkg.github.com
```

Requires Node.js 22.13+, PostgreSQL, and Python 3. Install `packageResources().schema` through the product's explicit migration process before an application starts. LingxiOS performs read-only schema checks at startup and never applies DDL itself.

See [performance configuration and measured framework results](docs/performance.md) for authenticated SSE drafts, notification wakeups, resource limits, and the required schema-10 additive migrations.

See [3.5.0 reliability and migration notes](docs/runtime-reliability-3.5.0.md) for schema 12, bounded recovery, child admission and terminal feedback.

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

See [reasoning effort and optional auxiliary streaming](docs/reasoning-effort-contract.md) for explicit provider parameters, compatible defaults, and deterministic HTTP timing tests.

## Native tools and recovery

Each `ToolDefinition` supplies one input parser and model-visible schema plus authorization, effect type, execution, approval preview, reconciliation, and verification. Validation and authorization occur before an action intent is recorded. PostgreSQL writes receive the same transaction as their action receipt. Reads may be retried; confirmed receipts are restored; unknown external effects wait for reconciliation.

See [3.5.3 native input wait notes](docs/native-input-waits-3.5.3.md) for the recovery contract and release requirements.

A product tool can pause for user input after durably creating its question or form:

```ts
import { userInputWait } from '@lyyzka/lingxios'

// Inside the authorized native tool's execute(context, input):
const card = await createInputCard(context, input)
return userInputWait('Which city?', { cardId: card.id })
```

`userInputWait(question, value?)` returns a successful `defer/user` receipt. The question must be nonempty and at most 4000 characters. The runtime accepts only a durable successful receipt for the same work and current request version, then parks in `awaiting_input` without another model turn. Unstarted calls later in that model batch receive `not_started` outputs; they are reconsidered after the reply, never executed with old arguments. Receipt recovery preserves the wait without creating another card. Existing successful `ActionResult.directive = { type: 'defer', reason: 'user', data: { question } }` results remain supported.

Resume through `control.continueInput({ ...identity, requestVersion, inputId, text })`. The product owns card identity, schema validation, answer authorization and submission deduplication; the runtime owns the durable wait and request continuation. A card-producing tool that returns an ordinary successful result does not request a wait.

Model-visible capabilities are derived from the current authorized tool catalog.
Hosts must provide tool definitions for capabilities they want advertised; advisory
grants without a registered tool do not appear in the prompt. Omit unavailable
capabilities instead of adding feature-specific denial instructions. Host grants,
authorization checks and generic evidence requirements still govern execution.

Work lifecycle, goal outcome, and delivery state are separate. `readRunState()` returns a consistent snapshot of all three. A `satisfied` goal requires current authoritative checks when the request created resources; model self-assessment alone cannot mark verification as passed.

Evolution candidates remain inactive until a frozen benchmark improves target cases, passes authorization, approval, isolation and code-mutation gates, and does not regress its holdout set. Active strategy references are pinned per run and can be rolled back through the trusted control API.

Production Python execution requires OS isolation. The packaged Worker defaults to Linux Bubblewrap in production and fails readiness when the isolation self-check fails. Artifact downloads verify the committed path, size, and SHA-256 digest.

See [runtime and deployment details](docs/packaged-runtime.md), [Harness semantics](docs/harness-v3.md), and [production recovery](deploy/README.md).

Optional `control.memory` provides scoped Markdown documents, always-loaded core memory, Chinese/English PostgreSQL search, committed history, versioned edits, background reflection, diagnostics and rollback. Version 3.3.0 requires schema 11 and protocol 11, including distributed workspace checkpoints. Schema-9 installations apply `packageResources().migration010`, then `migration011` and `migration012` and `migration013` (schema-10 installations need migrations 011-013); existing memory and business records remain intact. IM conversation policy, multi-Agent reply slots, durable DAGs and field-versioned shared state are available through the [IM collaboration API](docs/im-collaboration.md). See the [memory configuration and cutover procedure](docs/packaged-runtime.md#cognitive-memory).
