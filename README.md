# LingxiOS

面向 Node.js 和 PostgreSQL 的持久 Agent 执行运行时。提供任务队列、租约与故障恢复、原生工具事务、审批、结果核验、交付 outbox、记忆和多 Agent 协作；业务规则与认证由宿主应用提供。

## 安装

需要 Node.js 22.13+、PostgreSQL；启用 Python 执行时需要 Python 3，生产环境需要 Linux Bubblewrap。

```ini
# .npmrc
@lyyzka:registry=https://npm.pkg.github.com
```

```sh
npm install @lyyzka/lingxios@4.0.0-slim.0
```

三个公开入口：

- `@lyyzka/lingxios`：控制面、工具、资源路径、记忆和协作契约。
- `@lyyzka/lingxios/worker`：Worker、模型和 Kernel 接口。
- `@lyyzka/lingxios/ui`：可在浏览器使用的消息与事件归约器。

发布包仅包含 JavaScript、类型声明、数据库安装/升级资源和 Python runner。测试、评测、历史报告和源码映射不再提供；`@lyyzka/lingxios/eval` 和 `lingxios-eval` 已移除。运行时仍执行授权、审批、隔离和结果核验。

默认安装只依赖流式 JSON 解析和 JSON Schema 验证库，不再引入 LangChain/LangGraph。PDF/DOCX 文本提取为可选能力，使用时安装对应解析器：

```sh
npm install pdfjs-dist@6.3.289  # PDF
npm install mammoth@1.12.2    # DOCX
```

未安装解析器时，`extractDocumentText` 对相应格式返回明确的安装错误。文本、JSON、HTML 和源代码提取无需额外依赖。解析仍在有时限、内存和输出限制的独立进程中执行。

## 使用

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
  id: 'request-1', tenantId: 'tenant', agentId: 'assistant',
  sessionId: 'conversation', principalId: 'authenticated-user',
  text: 'Create the requested document and verify it.',
})
await worker.runNext()
await worker.stop()
await control.stop()
```

`createLingxiOS()` 不领取工作；Worker 单独负责执行。宿主提供 PostgreSQL pool、认证、工具授权、业务服务和交付通道。工具的输入解析与授权先于动作持久化，执行和恢复时仍重新授权；未知外部效果必须先 reconciliation。数据库动作与回执共用事务，结果与 outbox 原子提交。

工作状态、目标结果和交付状态相互独立，通过 `readRunState()` 查询。模型自评不能代替资源读回和已提交动作回执。可选 `semanticReview` 默认 `selective`，仅接受可信宿主提名；`required` 强制评审，`disabled` 不调用评审模型。运行中的 Harness 与模型行为绑定不可通过改写检查点绕过。记忆、演化评估策略及协作权限由宿主显式配置。

`userInputWait(question, value?)` 让工具以成功回执请求用户输入；宿主通过 `control.continueInput()` 恢复。审批、输入继续及资源读取都需要匹配当前身份与请求版本。

## 数据库与升级

`packageResources()` 返回 `schema`、`schema013`、`migration016` 和 `runner` 的绝对路径。全新安装由宿主显式执行 `schema`，当前 schema 为 14；schema 13 使用 `migration016` 升级。启动只检查 schema，不自动执行 DDL。禁止将全新安装 schema 应用于现有数据库。

升级前停止入口、排空任务、停止旧 Worker、处理未知效果和待审批动作，并备份一致的数据库与产物。schema 14 无需数据库迁移。早于 schema 13 的安装先使用历史 3.8.16 包及宿主迁移流程到达 schema 14；其中 schema 8 的记忆重置会删除旧记忆，须检查历史步骤。当前包不提供 schema011/schema012、迁移 008–015 或 rollback015，宿主须更新旧资源引用。

旧 `purpose-json-v1` 模型配置不再支持，新任务使用 v2/v3。既有任务应由匹配的旧部署完成或排空，再升级宿主和 Worker；不要重写行为绑定以通过兼容性检查。回滚需要匹配的旧应用及一致的数据库/产物备份，并先核对外部效果；恢复备份会丢失备份后的写入，无自动降级迁移。

生产部署、沙箱与恢复约束见 [部署说明](https://github.com/LingXi-Org/LingxiOS/blob/main/deploy/README.md)。包附带 `lingxios-worker` 和 `lingxios-doctor` CLI；后者可通过 `--database-module path/to/pool.js` 使用导出 `pool` 的宿主模块。

## 构建与发布

```sh
npm ci --ignore-scripts
npm run build
npm pack
```

`build` 清理并生成 `dist/src`；`typecheck` 只做静态检查；`prepack` 自动构建。开发依赖中的文档解析器仅用于类型检查，不会进入默认生产安装。Docker 镜像同样默认不带可选解析器，需要对应能力时由消费端镜像安装。

CI 只验证构建、打包、独立生产安装、公开入口及资源存在性。发布标签必须与版本一致，并对应已通过 main 分支包检查的提交。测试、真实模型评测、数据库集成和隔离环境验收由消费端按部署需要执行，包检查不代表这些验收已通过。
