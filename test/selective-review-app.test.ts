import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex, type SemanticReviewContext } from '../src/index.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { ModelDriver } from '../src/model/driver.js'

// Trusted selection nominates one narrow question. Loading never activates or
// proves an authored result, and reference questions must remain valid.
it('selects focused review from exact current native workflow evidence without creating an authoring obligation',async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  const pool: SqlPool = { query: async (sql,params) => { const result = await db.query<Record<string,unknown>>(sql,params); return { rows: result.rows,rowCount: result.affectedRows ?? result.rows.length } },
    connect: async () => ({ query: pool.query,release: () => {} }) }
  const skill = { name: 'diagram',version: 'v1',description: 'A selected diagram workflow.',body: 'Use real tools to deliver diagrams. Reference reads do not activate authoring.',actions: [],delivery: { checker: 'product:diagram' } }
  const { name,version,hash } = skillIndex(skill),selection = { name,version,hash }
  const scope = { id: 'diagram-intent.v1',rubric: 'Only inspect whether the current request asks to create a diagram under the selected workflow and whether it was delivered. Reference-only explanations need no authored result.' }
  let contexts = 0
  const app = await createLingxiOS({ database: pool,background: { role: 'passive' },performance: { notifications: false },skills: [skill],
    capabilityResolver: { resolve: async () => [{ name: 'skills',methods: ['load','activate'] }] },
    semanticReviewPolicy: { id: 'selected-diagram',version: '1',resolve: async (context: SemanticReviewContext) => {
      contexts++
      assert.equal(context.request.workId,context.work.id)
      assert.equal(context.requestVersion,context.candidate.requestVersion)
      assert.ok(context.executionSteps.every(step => step.requestVersion === context.requestVersion))
      const loaded = context.executionSteps.some(step => step.kind === 'skills__load' && step.output !== undefined)
      if (!loaded) return undefined
      assert.ok(context.availableActions.includes('skills.load'))
      assert.ok(context.availableSkills.some(skill => skill.name === selection.name && skill.hash === selection.hash))
      assert.deepEqual(context.skillActivations,[],'reference selection must not activate authoring')
      return scope
    } } })
  const host = app.connectWorker({ workerId: 'selective-review-test',workKinds: ['turn'] })
  try {
    for (const mode of ['ordinary','reference','missing','disabled'] as const) {
      const text = mode === 'ordinary' ? 'What is two plus two?' : mode === 'reference' ? 'Explain the diagram workflow; do not create a diagram.' : 'Create a diagram.'
      await app.enqueue({ id: mode,tenantId: 't',agentId: 'a',principalId: 'u',sessionId: mode,text,deliveryMode: 'text',codeExecution: 'disabled' })
      const work = (await host.claimWork())!
      let generations = 0,reviews = 0
      const usage = { available: true,inputTokens: 100,outputTokens: 20 }
      const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
        structured: async call => { reviews++; assert.match(call.instructions,/Reference-only explanations/)
          return { model: 'synthetic',usage,value: { missing: mode === 'missing' ? [{ quote: text,reason: 'The requested diagram has not been created.' }] : [] } } },
        run: async () => {
          generations++
          if (mode !== 'ordinary' && generations === 1) return { text: '',output: [{ type: 'function_call',callId: 'select',name: 'skills__load',arguments: JSON.stringify(selection) }],usage }
          const body = mode === 'ordinary' ? 'Four.' : mode === 'reference' ? 'This workflow produces diagrams; nothing has been created.' : 'I will create the diagram.'
          return { text: body,output: [{ role: 'assistant',content: body }],usage }
        } }
      await new AgentRuntime(host,model,{ execute: async () => { throw new Error('no kernel needed') } },mode === 'disabled' ? { semanticReview: 'disabled' } : {}).runWork(work)
      const result = await app.readMessage({ runId: mode,tenantId: 't',agentId: 'a',principalId: 'u',sessionId: mode })
      assert.ok(result,`expected a truthful ${mode} result`)
      if (mode === 'ordinary') assert.deepEqual({ generations,reviews },{ generations: 1,reviews: 0 })
      if (mode === 'reference') assert.deepEqual({ generations,reviews },{ generations: 2,reviews: 1 })
      if (mode === 'missing') assert.deepEqual({ generations,reviews },{ generations: 3,reviews: 1 })
      if (mode === 'disabled') assert.deepEqual({ generations,reviews },{ generations: 2,reviews: 0 })
      assert.equal(result.envelope.goalOutcome.status,mode === 'ordinary' || mode === 'reference' ? 'satisfied' : 'partial')
      const active = await db.query('SELECT id FROM lingxios.agent_skill_activations WHERE work_id=$1',[mode])
      assert.equal(active.rows.length,0,'review selection cannot activate or resolve a skill')
    }
    assert.ok(contexts > 0)
  } finally { await app.stop(); await db.close() }
})
