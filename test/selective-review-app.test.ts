import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex, type SemanticReviewContext } from '../src/index.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { ToolDefinition } from '../src/tools/definition.js'
import type { ModelDriver } from '../src/model/driver.js'

// Trusted selection nominates one narrow question. Loading never activates or
// proves an authored result, and reference questions must remain valid.
it('selects focused review from exact current native workflow evidence without creating an authoring obligation',async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  const pool: SqlPool = { query: async (sql,params) => { const result = await db.query<Record<string,unknown>>(sql,params); return { rows: result.rows,rowCount: result.affectedRows ?? result.rows.length } },
    connect: async () => ({ query: pool.query,release: () => {} }) }
  const skill = { name: 'diagram',version: 'v1',description: 'A selected diagram workflow.',body: 'Use real tools to deliver diagrams. Reference reads do not activate authoring.',actions: ['diagrams.save'],delivery: { checker: 'product:diagram' } }
  const { name,version,hash } = skillIndex(skill),selection = { name,version,hash }
  const scope = { id: 'diagram-intent.v1',rubric: 'Only inspect whether the current request asks to create a diagram under the selected workflow and whether it was delivered. Reference-only explanations need no authored result.' }
  await db.exec('CREATE TABLE test_diagrams (work_id text PRIMARY KEY, reference text NOT NULL)')
  const native: ToolDefinition = { name: 'diagrams__save',action: 'diagrams.save',description: 'Save an actual diagram.',effect: 'transaction',approval: false,
    parameters: { type: 'object',properties: {},additionalProperties: false },parse: value => value as Record<string,unknown>,authorize: async () => {},
    execute: async context => { await context.database.query('INSERT INTO test_diagrams(work_id,reference) VALUES($1,$2)',[context.work.id,'diagram://stable']); return { ok: true,value: { reference: 'diagram://stable' } } },
    verify: async context => { const result = await context.database.query('SELECT reference FROM test_diagrams WHERE work_id=$1',[context.work.id]);
      return { status: result.rows.length === 1 ? 'passed' : 'failed',evidence: { scope: 'actual-diagram-row' } } } }
  let contexts = 0
  const app = await createLingxiOS({ database: pool,background: { role: 'passive' },performance: { notifications: false },skills: [skill],tools: [native],
    verifySkillDelivery: async context => {
      const actual = await context.database.query('SELECT reference FROM test_diagrams WHERE work_id=$1',[context.work.id])
      return context.skillActivations.map(activation => ({ activationId: activation.id,outcome: actual.rows.length === 1 && context.candidate.body.includes('diagram://stable') ? 'delivered' as const : 'pending' as const,evidence: { rows: actual.rows.length } }))
    },
    capabilityResolver: { resolve: async () => [{ name: 'skills',methods: ['load','activate'] },{ name: 'diagrams',methods: ['save'] }] },
    semanticReviewPolicy: { id: 'selected-diagram',version: '1',resolve: async (context: SemanticReviewContext) => {
      contexts++
      assert.equal(context.request.workId,context.work.id)
      assert.equal(context.requestVersion,context.candidate.requestVersion)
      assert.ok(context.executionSteps.every(step => step.requestVersion === context.requestVersion))
      if (context.skillActivations.length) return undefined // Fresh native verification owns the actual delivery.
      const loaded = context.executionSteps.some(step => step.kind === 'skills__load' && step.output !== undefined)
      if (!loaded) return undefined
      assert.ok(context.availableActions.includes('skills.load'))
      assert.ok(context.availableSkills.some(skill => skill.name === selection.name && skill.hash === selection.hash))
      assert.deepEqual(context.skillActivations,[],'reference selection must not activate authoring')
      return scope
    } } })
  const host = app.connectWorker({ workerId: 'selective-review-test',workKinds: ['turn'] })
  try {
    for (const mode of ['ordinary','reference','missing','disabled','repair'] as const) {
      const text = mode === 'ordinary' ? 'What is two plus two?' : mode === 'reference' ? 'Explain the diagram workflow; do not create a diagram.' : 'Create a diagram.'
      await app.enqueue({ id: mode,tenantId: 't',agentId: 'a',principalId: 'u',sessionId: mode,text,deliveryMode: 'text',codeExecution: 'disabled' })
      const work = (await host.claimWork())!
      let generations = 0,reviews = 0
      const usage = { available: true,inputTokens: 100,outputTokens: 20 }
      const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
        structured: async call => { reviews++; assert.match(call.instructions,/Reference-only explanations/)
          return { model: 'synthetic',usage,value: { missing: mode === 'missing' || mode === 'repair' ? [{ quote: text,reason: 'The requested diagram has not been created.' }] : [] } } },
        run: async () => {
          generations++
          if (mode !== 'ordinary' && generations === 1) return { text: '',output: [{ type: 'function_call',callId: 'select',name: 'skills__load',arguments: JSON.stringify(selection) }],usage }
          if (mode === 'repair' && generations === 3) return { text: '',output: [
            { type: 'function_call',callId: 'activate',name: 'skills__activate',arguments: JSON.stringify(selection) },
            { type: 'function_call',callId: 'save',name: 'diagrams__save',arguments: '{}' }],usage }
          const body = mode === 'repair' ? 'The diagram is ready at diagram://stable' : mode === 'ordinary' ? 'Four.' : mode === 'reference' ? 'This workflow produces diagrams; nothing has been created.' : 'I will create the diagram.'
          return { text: body,output: [{ role: 'assistant',content: body }],usage }
        } }
      await new AgentRuntime(host,model,{ execute: async () => { throw new Error('no kernel needed') } },mode === 'disabled' ? { semanticReview: 'disabled' } : {}).runWork(work)
      const result = await app.readMessage({ runId: mode,tenantId: 't',agentId: 'a',principalId: 'u',sessionId: mode })
      assert.ok(result,`expected a truthful ${mode} result`)
      if (mode === 'ordinary') assert.deepEqual({ generations,reviews },{ generations: 1,reviews: 0 })
      if (mode === 'reference') assert.deepEqual({ generations,reviews },{ generations: 2,reviews: 1 })
      if (mode === 'missing') assert.deepEqual({ generations,reviews },{ generations: 3,reviews: 1 })
      if (mode === 'repair') assert.deepEqual({ generations,reviews },{ generations: 4,reviews: 1 })
      if (mode === 'disabled') assert.deepEqual({ generations,reviews },{ generations: 2,reviews: 0 })
      assert.equal(result.envelope.goalOutcome.status,mode === 'ordinary' || mode === 'reference' || mode === 'repair' ? 'satisfied' : 'partial')
      const active = await db.query('SELECT id FROM lingxios.agent_skill_activations WHERE work_id=$1',[mode])
      assert.equal(active.rows.length,mode === 'repair' ? 1 : 0,'only the explicit activation tool can create an authoring intent')
      if (mode === 'repair') {
        assert.equal(result.body,'The diagram is ready at diagram://stable','fresh native delivery may keep the exact candidate body')
        assert.equal((await db.query('SELECT reference FROM test_diagrams WHERE work_id=$1',[mode])).rows.length,1)
      }
    }
    assert.ok(contexts > 0)
  } finally { await app.stop(); await db.close() }
})
