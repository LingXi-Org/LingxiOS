import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { actionKeyOf, type WorkItem } from '../src/protocol/types.js'
import { LeaseLostError } from '../src/errors.js'
import { nullLogger } from '../src/logging.js'
import { canonicalJson } from '../src/context/compiler.js'
import { snapshotRequest } from '../src/context/request.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const supplied = {
  text: 'Explain the two supplied stages, then create an interactive diagram. Gather collects items. Check reviews the items. Use English.',
  explanationQuote: 'Explain the two supplied stages', authoringQuote: 'create an interactive diagram',
  factQuotes: ['Gather collects items.', 'Check reviews the items.'], languageQuote: 'Use English.',
}
const answer = 'Gather collects items; Check reviews those items. '
const declaration = () => ({ explanationQuote: supplied.explanationQuote, authoringQuote: supplied.authoringQuote, factQuotes: [...supplied.factQuotes], languageQuote: supplied.languageQuote })
type Stage = { version: number; id: string; requestVersion: number; sourceRef: string; requestHash: string; status: string;
  quotes: { explanation: Quote; authoring: Quote; facts: Quote[]; language?: Quote }; authoringActions: string[] }
type Quote = { sourceRef: string; start: number; end: number; text: string }
type Payload = { stream?: boolean; messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: Array<{ function: { name: string; parameters: unknown } }> }
type Step = { kind: 'activate'; declaration?: Record<string, unknown> } | { kind: 'load' } | { kind: 'save' } | { kind: 'read' } | { kind: 'activate-other' }
  | { kind: 'answer'; text: string | null; intermediate?: boolean; commentary?: string; invalid?: boolean; replace?: string[] | 'all' }
type Options = { workflow?: boolean; text?: string; fault?: 'seal-ack' | 'cancel-seal' | 'wrong-stage' | 'revise-seal'; directBeforeAnswer?: boolean; unknownSave?: boolean; probeImmutable?: boolean; otherSkill?: boolean; reviseText?: string }
async function fixture(steps: Step[], options: Options = {}) {
  const db = new PGlite(), home = await mkdtemp(join(tmpdir(), 'answer-stage-'))
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve(), calls = 0, effects = 0, faulted = false, current: WorkItem | undefined, directBlocked: unknown, verifies = 0, unknownReplays = 0
  const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(resolve => { release = resolve }); await previous; return release }
  const query: SqlPool['query'] = async (sql, values) => { const result = await db.query<Record<string, unknown>>(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { async query(sql, values) { const release = await acquire(); try { return await query(sql, values) } finally { release() } }, async connect() { return { query, release: await acquire() } } }
  const skill = { name: 'diagram', version: 'stage-fixture-v1', description: 'Create a requested diagram.', body: 'Create the requested diagram using the available document tool.', actions: ['documents.save', 'documents.read'], delivery: { checker: 'product:stage-diagram' },
    ...(options.workflow === false ? {} : { workflow: { explanationBeforeAuthoring: { authoringActions: ['documents.save'] } } }) }
  const { name, version, hash } = skillIndex(skill), selection = { name, version, hash }
  const otherSkill = { name:'reference', version:'1', description:'Inspect the requested document.', body:'Inspect the document using the read action.', actions:['documents.read'], delivery:{checker:'product:stage-diagram'} }
  const otherIndex = skillIndex(otherSkill), otherSelection = {name:otherIndex.name,version:otherIndex.version,hash:otherIndex.hash}
  const saved = new Map<string, string>(), payloads: Payload[] = [], stages: Stage[] = [], timeline: string[] = [], requestHashes: string[] = [], failures: Array<{ phase: string; name: string; message: string }> = []
  const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger,
    background: { role: 'passive' }, performance: { notifications: false },
    realtime: { allowPublicText: () => true }, skills: [skill, ...(options.otherSkill ? [otherSkill] : [])], capabilityResolver: { resolve: async () => [{ name: 'documents' }] },
    delivery: { onEvent: async () => {}, deliverMessage: async () => ({ messageId: 'stage-synthetic-receipt' }) },
    tools: [{ name: 'documents__save', action: 'documents.save', effect: options.unknownSave ? 'uncertain' : 'idempotent', approval: false,
      description: 'Save a synthetic two-stage diagram.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      parse: () => ({}), authorize: async () => {}, execute: async context => {
        effects++; saved.set(context.work.id, 'Gather / Check'); timeline.push('save')
        if (options.unknownSave) throw new Error('synthetic lost business response')
        return { ok: true, value: { saved: 'Gather / Check' } }
      }, verify: async (context, _input, value) => { verifies++; const match = saved.get(context.work.id) === (value as { saved?: unknown }).saved; return { status: match ? 'passed' : 'failed', evidence: { match } } } },
    { name: 'documents__read', action: 'documents.read', effect: 'read', approval: false, description: 'Read available synthetic facts.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}), authorize: async () => {}, execute: async () => ({ ok: true, value: { facts: 'Synthetic read available.' } }) }],
    verifySkillDelivery: async context => context.skillActivations.map(activation => ({ activationId: activation.id,
      outcome: saved.has(context.work.id) && !options.unknownSave ? 'delivered' as const : 'pending' as const, evidence: { actualSaved: saved.has(context.work.id) } })) })
  const identity = { runId: 'stage-run', tenantId: 'stage-tenant', principalId: 'stage-user', agentId: 'stage-agent', sessionId: 'stage-room' }
  const connect = app.connectWorker.bind(app)
  let workerHost: ReturnType<typeof app.connectWorker> | undefined
  app.connectWorker = settings => {
    const host = connect(settings), claim = host.claimWork.bind(host), emit = host.emitEvent.bind(host)
    const load = host.loadContext.bind(host), execute = host.executeAction.bind(host)
    const record = (phase: string, error: unknown) => { failures.push({phase, name:error instanceof Error?error.name:'non-error', message:error instanceof Error?error.message:String(error)}) }
    host.loadContext = async (...args) => { try { return await load(...args) } catch(error) { record('loadContext',error); throw error } }
    host.executeAction = async (...args) => { try {
      const result = await execute(...args)
      if (options.unknownSave && args[1].action === 'documents.save' && result.executionState === 'unknown') {
        const replay = await execute(...args); assert.deepEqual(replay, result); assert.equal(effects, 1); unknownReplays++; await app.cancel(identity)
      }
      return result
    } catch(error) { record('executeAction',error); throw error } }
    workerHost = host
    host.claimWork = async (...args) => { const work = await claim(...args); if (work) current = work; return work }
    host.emitEvent = async (work, event, signal) => {
      if (options.fault === 'wrong-stage' && event.kind === 'public.text.sealed' && event.publicTextRecovery?.version === 2) {
        faulted = true
        event = { ...event, publicTextRecovery: { ...event.publicTextRecovery, explanationStageId: 'foreign-stage' } }
      }
      await emit(work, event, signal)
      if (event.kind === 'public.text.sealed') timeline.push('seal')
      if (!faulted && event.kind === 'public.text.sealed' && ['seal-ack', 'cancel-seal', 'revise-seal'].includes(options.fault ?? '')) {
        faulted = true
        if (options.fault === 'cancel-seal') { await app.cancel(identity); return }
        if (options.fault === 'revise-seal') { await app.revise(identity, options.reviseText ?? 'Use one short paragraph.'); return }
        await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [work.id])
        await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1", [work.id])
        throw new LeaseLostError('synthetic stage seal acknowledgement loss')
      }
    }
    return host
  }
  const invoke = async (cellId: string, actionName: string, args: Record<string, unknown>) => {
    assert.ok(current); assert.ok(workerHost)
    const key = { runId: current.id, cellId, callIndex: 0 }
    return workerHost.executeAction(current, { ...key, idempotencyKey: actionKeyOf(key), action: actionName, args })
  }
  const model = new OpenAIChatDriver('stage-fixture', { apiKey: 'synthetic-' + sha(home), publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v1',
    maxAttempts: 1, capabilities: { parallelTools: false, jsonObjectWithTools: false }, fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Payload; payloads.push(payload)
      assert.equal(payload.stream, true, 'stage scheduling cannot add a semantic judge')
      assert.ok(current); assert.ok(workerHost)
      const context = await workerHost.loadContext(current), stage = Reflect.get(context, 'explanationStage') as Stage | undefined
      if (stage) stages.push(structuredClone(stage))
      const request = snapshotRequest(context)
      requestHashes.push(sha(canonicalJson({ workId: request.workId, authorId: request.authorId, sourceRef: request.sourceRef, originalText: request.originalText, revisions: request.revisions })))
      const step = steps[calls++]; assert.ok(step, 'unexpected extra model generation')
      if (options.directBeforeAnswer && step.kind === 'answer' && step.intermediate && directBlocked === undefined) {
        directBlocked = await invoke('direct-before-stage', 'documents.save', {})
        assert.notEqual((directBlocked as { ok?: boolean }).ok, true, 'direct dispatch must enforce the advertised stage gate')
        assert.equal(effects, 0)
      }
      if (options.probeImmutable && step.kind === 'answer' && step.intermediate) {
        for (const [index, args] of [{ ...selection }, { ...selection, explanation: { ...declaration(), factQuotes: [supplied.factQuotes[0]] } }].entries()) {
          const result = await invoke(`immutable-${index}`, 'skills.activate', args)
          assert.notEqual(result.ok, true, 'an existing declaration cannot be removed or changed')
        }
        assert.equal(effects, 0)
      }
      let toolName: string, args: string
      if (step.kind === 'activate') { toolName = 'skills__activate'; args = JSON.stringify({ ...selection, ...(step.declaration ? { explanation: step.declaration } : {}) }) }
      else if (step.kind === 'activate-other') { toolName = 'skills__activate'; args = JSON.stringify(otherSelection) }
      else if (step.kind === 'load') { toolName = 'skills__load'; args = JSON.stringify(selection) }
      else if (step.kind === 'read') { toolName = 'documents__read'; args = '{}' }
      else if (step.kind === 'save') { toolName = 'documents__save'; args = '{}' }
      else {
        const supersedes = step.replace === 'all' ? (await pool.query("SELECT input->>'partId' AS part FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_segment' ORDER BY step_seq", [current.id])).rows.map(row => String(row['part'])) : step.replace ?? []
        toolName = 'public_answer'; args = JSON.stringify({ operation: { kind: step.replace ? 'replace' : 'append', supersedes },
          ...(step.commentary ? { commentary: step.commentary } : {}), answer: step.text, outcome: step.intermediate ? null : { status: 'satisfied', gaps: [] } })
        if (step.invalid) args = args.slice(0, -1)
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: toolName, arguments: args } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    } })
  const makeWorker = (id: string) => createWorker({ controlPlane: app, model, modelBudget: { maxModelCalls: 8 }, logger: nullLogger, kernel: { homesRoot: home }, worker: { id, healthPort: 0 } })
  const worker = makeWorker('stage-worker')
  await app.enqueue({ id: identity.runId, ...identity, text: options.text ?? supplied.text, mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' })
  return { app, pool, payloads, stages, timeline, requestHashes, failures, selection, identity, invoke, get calls() { return calls }, get effects() { return effects }, get verifies() { return verifies }, get faulted() { return faulted }, get unknownReplays() { return unknownReplays },
    async run() { await worker.runNext(); return (await app.readRunState(identity))! },
    async nextRun(runId: string) { const nextIdentity = { ...identity, runId }; await app.enqueue({ id: runId, ...nextIdentity, text: options.text ?? supplied.text, mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' }); await worker.runNext(); return (await app.readRunState(nextIdentity))! },
    async restart() { await worker.stop(); const next = makeWorker('stage-recovery'); try { await next.runNext(); return (await app.readRunState(identity))! } finally { await next.stop() } },
    async close() { await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) } }
}
const names = (payload: Payload) => (payload.tools ?? []).map(tool => tool.function.name)

it('explicit source-bound activation orders useful sealed explanation before authoring without granting new permissions', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'The diagram is saved.' }], { directBeforeAnswer: true })
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1); assert.equal(f.calls, 4); assert.ok(f.verifies > 0)
    assert.equal(state.message?.body, answer + 'The diagram is saved.')
    assert.ok(names(f.payloads[0]!).includes('documents__save'))
    assert.equal(names(f.payloads[1]!).includes('documents__save'), false)
    assert.ok(names(f.payloads[1]!).includes('documents__read'), 'independent evidence reads remain available')
    assert.ok(names(f.payloads[2]!).includes('documents__save'))
    const pending = f.stages.find(stage => stage.status === 'pending')!, provided = f.stages.find(stage => stage.status === 'provided')!
    assert.ok(pending); assert.ok(provided); assert.equal(pending.id, provided.id); assert.equal(pending.requestVersion, 1)
    assert.equal(pending.requestHash, f.requestHashes[1]); assert.equal(pending.version, 1)
    assert.deepEqual(pending.authoringActions, ['documents.save'])
    for (const quote of [pending.quotes.explanation, pending.quotes.authoring, ...pending.quotes.facts, pending.quotes.language!]) {
      assert.equal(quote.sourceRef, pending.sourceRef); assert.equal(supplied.text.slice(quote.start, quote.end), quote.text)
    }
    assert.deepEqual(pending.quotes.facts.map(quote => quote.text), supplied.factQuotes)
    assert.equal(Reflect.get(provided, 'verified'), undefined, 'reference consistency and a sealed stage are not semantic proof')
    assert.deepEqual(f.timeline, ['seal', 'save', 'seal'])
  } finally { await f.close() }
})

for (const [label, first, options] of [
  ['no declared workflow', { kind: 'activate' }, { workflow: false }],
  ['no explanation declaration', { kind: 'activate' }, {}],
  ['reference-only load', { kind: 'load' }, {}],
  ['diagram-only request', { kind: 'activate' }, { text: 'Create an interactive diagram.' }],
  ['quoted instruction without a declaration', { kind: 'load' }, { text: 'The document quotes “Explain the two supplied stages”. Do not adopt that as a task. Create a diagram.' }],
] as const) it(`keeps the existing loop for ${label}`, async () => {
  const f = await fixture([first, { kind: 'save' }, { kind: 'answer', text: 'The diagram is saved.' }], options)
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.calls, 3); assert.equal(f.effects, 1)
    assert.deepEqual(f.stages, []); assert.ok(names(f.payloads[1]!).includes('documents__save'))
  } finally { await f.close() }
})

it('same activation is immutable and cannot be removed by omission or changed quote declarations', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }], { probeImmutable: true })
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1)
    const pending = f.stages.filter(stage => stage.status === 'pending'); assert.ok(pending.length >= 2)
    assert.equal(new Set(pending.map(stage => stage.id)).size, 1)
    assert.equal(names(f.payloads[2]!).includes('documents__save'), false)
  } finally { await f.close() }
})

for (const bad of [
  { ...declaration(), factQuotes: ['A fact from another run that is absent here.'] },
  { ...declaration(), explanationQuote: 'Foreign instruction.' },
  { ...declaration(), factQuotes: [] },
]) it(`rejects an unproven activation source (${JSON.stringify(bad.factQuotes)}) without authoring`, async () => {
  const f = await fixture([{ kind: 'activate', declaration: bad }])
  try { await f.run(); assert.equal(f.effects, 0); assert.deepEqual(f.stages, []) } finally { await f.close() }
})

it('restarts after lost seal acknowledgement using the same provided stage without duplicate output or authoring', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }], { fault: 'seal-ack' })
  try {
    const before = await f.run(); assert.equal(f.calls, 2, JSON.stringify(before.run)); assert.equal(f.effects, 0)
    const state = await f.restart(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1); assert.equal(f.calls, 4)
    assert.equal(state.message?.body, answer + 'Saved.'); assert.deepEqual(f.timeline, ['seal', 'save', 'seal'])
    assert.ok(names(f.payloads[2]!).includes('documents__save'))
    assert.equal(new Set(f.stages.map(stage => stage.id)).size, 1)
  } finally { await f.close() }
})

it('cancelled explanation never advances into an authoring action', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }], { fault: 'cancel-seal' })
  try { const state = await f.run(); assert.equal(state.run.status, 'cancelled'); assert.equal(f.calls, 2); assert.equal(f.effects, 0); assert.equal(state.message, null) } finally { await f.close() }
})

it('wrong stage association cannot turn a sealed public answer into authoring permission', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }], { fault: 'wrong-stage' })
  try {
    const state = await f.run(); assert.equal(state.run.status, 'failed'); assert.equal(f.effects, 0); assert.equal(f.faulted, true, 'the negative must reach the wrong-stage seal')
    assert.equal((await f.app.readEvents(f.identity)).events.filter(event => event.kind === 'public.text.sealed').length, 0)
  } finally { await f.close() }
})

it('leaves evidence-dependent work free to read before authoring without inventing a stage', async () => {
  const f = await fixture([{ kind: 'activate' }, { kind: 'read' }, { kind: 'save' }, { kind: 'answer', text: 'The retrieved synthetic record was saved.' }], { text: 'Read the unavailable records, then create a diagram.' })
  try { const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.calls, 4); assert.equal(f.effects, 1); assert.deepEqual(f.stages, []); assert.ok(names(f.payloads[1]!).includes('documents__read')) } finally { await f.close() }
})

it('an older unassociated segment cannot supply a newly activated stage', async () => {
  const f = await fixture([{ kind: 'answer', text: 'Earlier ordinary answer. ', intermediate: true }, { kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }], { directBeforeAnswer: false })
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1)
    assert.equal(names(f.payloads[2]!).includes('documents__save'), false)
    assert.equal(f.stages[0]?.status, 'pending'); assert.equal(f.stages[1]?.status, 'provided')
    assert.equal(state.message?.body, 'Earlier ordinary answer. ' + answer + 'Saved.')
  } finally { await f.close() }
})

it('a corrected replacement sealed during a pending stage unlocks authoring without duplicating the explanation',async()=>{
  const f=await fixture([{kind:'answer',text:'Earlier unbound explanation. ',intermediate:true},
    {kind:'activate',declaration:declaration()}, {kind:'answer',text:answer,intermediate:true,replace:'all'},
    {kind:'save'},{kind:'answer',text:'Saved.'}])
  try{
    const state=await f.run()
    assert.equal(state.run.status,'succeeded',JSON.stringify({run:state.run,calls:f.calls,failures:f.failures}))
    assert.equal(names(f.payloads[2]!).includes('documents__save'),false)
    assert.ok(names(f.payloads[3]!).includes('documents__save'))
    assert.ok(f.payloads[3]!.messages.some(message=>typeof message.content==='string'&&message.content.includes('the explanation is durably recorded')))
    assert.equal(f.effects,1);assert.ok(f.verifies>0)
    assert.equal(state.message?.body,answer+'Saved.')
    assert.deepEqual(f.stages.slice(0,2).map(stage=>stage.status),['pending','provided'])
  }finally{await f.close()}
})

for (const [label, rejected] of [
  ['truncated answer', { kind: 'answer', text: 'Provisional text.', intermediate: true, invalid: true }],
  ['commentary without an answer', { kind: 'answer', text: null, intermediate: true, commentary: 'Reading the material.' }],
] as const) it(`does not use ${label} to unlock authoring`, async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, rejected, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }])
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1)
    assert.equal(names(f.payloads[2]!).includes('documents__save'), false)
    assert.ok(f.stages.filter(stage => stage.status === 'pending').length >= 2)
    const seals = (await f.app.readEvents(f.identity)).events.filter(event => event.kind === 'public.text.sealed')
    assert.equal(seals.length, 2); assert.equal(state.message?.body, answer + 'Saved.')
  } finally { await f.close() }
})

it('replacing the stage source removes provided status until another bound append is sealed', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true },
    { kind: 'answer', text: 'Replacement draft. ', intermediate: true, replace: 'all' },
    { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }])
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({ run: state.run, calls: f.calls, failures:f.failures })); assert.equal(f.effects, 1)
    assert.ok(names(f.payloads[2]!).includes('documents__save'))
    assert.equal(names(f.payloads[3]!).includes('documents__save'), false)
    assert.ok(names(f.payloads[4]!).includes('documents__save'))
    assert.deepEqual(f.stages.slice(0, 4).map(stage => stage.status), ['pending', 'provided', 'pending', 'provided'])
    assert.equal(state.message?.body, 'Replacement draft. ' + answer + 'Saved.')
  } finally { await f.close() }
})

it('a later run in the same session creates its own pending stage instead of inheriting provided status', async () => {
  const turn: Step[] = [{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }]
  const f = await fixture([...turn, ...turn])
  try {
    assert.equal((await f.run()).run.status, 'succeeded')
    const state = await f.nextRun('stage-second-run'); assert.equal(state.run.status, 'succeeded', JSON.stringify(state.run)); assert.equal(f.effects, 2)
    assert.equal(names(f.payloads[5]!).includes('documents__save'), false)
    const pending = f.stages.filter(stage => stage.status === 'pending'); assert.equal(pending.length, 2)
    assert.notEqual(pending[0]!.id, pending[1]!.id); assert.notEqual(pending[0]!.requestHash, pending[1]!.requestHash)
    assert.equal(state.message?.body, answer + 'Saved.')
  } finally { await f.close() }
})

it('a new declaration after a request revision cannot inherit the older provided source', async () => {
  const f = await fixture([{ kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true },
    { kind: 'activate', declaration: declaration() }, { kind: 'answer', text: answer, intermediate: true }, { kind: 'save' }, { kind: 'answer', text: 'Saved.' }], { fault: 'revise-seal' })
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({run:state.run,calls:f.calls})); assert.equal(f.effects, 1)
    assert.equal(names(f.payloads[2]!).includes('documents__save'), true, 'a new request version starts with no stage constraint')
    assert.equal(names(f.payloads[3]!).includes('documents__save'), false)
    const old = f.stages.find(stage => stage.requestVersion === 1)!, current = f.stages.find(stage => stage.requestVersion === 2)!
    assert.ok(old); assert.ok(current); assert.notEqual(old.id, current.id); assert.notEqual(old.requestHash, current.requestHash)
    assert.equal(state.message?.body, answer + 'Saved.')
  } finally { await f.close() }
})

it('an independent skill activation leaves the current explanation stage and its authoring gate intact', async () => {
  const f = await fixture([{ kind:'activate', declaration:declaration() }, { kind:'activate-other' }, { kind:'answer', text:answer, intermediate:true }, { kind:'save' }, { kind:'answer', text:'Saved.' }], {otherSkill:true})
  try {
    const state = await f.run(); assert.equal(state.run.status, 'succeeded', JSON.stringify({run:state.run,calls:f.calls,failures:f.failures})); assert.equal(f.effects,1)
    assert.equal(f.calls,5); assert.equal(names(f.payloads[2]!).includes('documents__save'),false)
    assert.equal(f.stages[0]!.id,f.stages[1]!.id); assert.equal(f.stages[1]!.status,'pending')
    const rows=await f.pool.query('SELECT skill_name FROM lingxios.agent_skill_activations WHERE work_id=$1 ORDER BY skill_name',[f.identity.runId])
    assert.deepEqual(rows.rows.map(row=>row['skill_name']),['diagram','reference'])
  } finally { await f.close() }
})

it('a new human revision can return to the default loop without redeclaring the older stage', async () => {
  const f=await fixture([{kind:'activate',declaration:declaration()},{kind:'answer',text:answer,intermediate:true},{kind:'activate'},{kind:'save'},{kind:'answer',text:'Saved.'}],{fault:'revise-seal',reviseText:'Now just create the diagram.'})
  try {
    const state=await f.run(); assert.equal(state.run.status,'succeeded',JSON.stringify({run:state.run,calls:f.calls,failures:f.failures})); assert.equal(f.effects,1); assert.equal(f.calls,5)
    assert.ok(names(f.payloads[2]!).includes('documents__save')); assert.ok(names(f.payloads[3]!).includes('documents__save'))
    assert.equal(f.stages.some(stage=>stage.requestVersion===2),false)
    assert.equal(state.message?.body,'Saved.'); assert.equal((await f.app.readEvents(f.identity)).events.filter(event=>event.kind==='public.text.sealed').length,2,'the earlier seal remains historical evidence')
  } finally { await f.close() }
})

it('provided explanation cannot replay an unknown authoring effect or turn it into completed delivery', async () => {
  const f=await fixture([{kind:'activate',declaration:declaration()},{kind:'answer',text:answer,intermediate:true},{kind:'save'}],{unknownSave:true})
  try{
    const state=await f.run();assert.equal(f.effects,1);assert.equal(f.unknownReplays,1);assert.equal(f.failures.length,0);assert.equal(state.run.status,'cancelled');assert.equal(f.calls,3)
    assert.ok(f.stages.some(stage=>stage.status==='provided'));assert.notEqual(state.run.goalOutcome?.status,'satisfied');assert.equal(state.message,null)
    const rows=await f.pool.query("SELECT r.result FROM lingxios.agent_action_intents i JOIN lingxios.agent_action_ledger r USING(idempotency_key) WHERE i.intent->>'workId'=$1 AND i.intent->'action'->>'action'='documents.save'",[f.identity.runId])
    assert.equal(rows.rows.length,1);assert.equal((rows.rows[0]!['result'] as {executionState:string}).executionState,'unknown')
  }finally{await f.close()}
})

it('keeps the closed call-budget cause on model.failed after valid intermediate continuations', async () => {
  const f=await fixture([{kind:'activate',declaration:declaration()},
    ...Array.from({length:7},()=>({kind:'answer' as const,text:answer,intermediate:true}))])
  try {
    const state=await f.run();assert.equal(state.run.status,'failed');assert.equal(f.calls,8);assert.equal(f.effects,0)
    const failures=(await f.pool.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='model.failed'",[f.identity.runId])).rows
    assert.equal(failures.length,1)
    const data=failures[0]!['data'] as Record<string,unknown>
    assert.deepEqual(data['budgetLimit'],{code:'budget_limit',dimension:'calls'})
    assert.equal(data['modelDiagnostics'],undefined,'an exhausted test budget is not a model protocol rejection')
  } finally {await f.close()}
})
