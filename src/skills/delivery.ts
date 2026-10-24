import { canonicalJson, textSha256 } from '../context/compiler.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import type { ActionContext, ToolDefinition } from '../tools/definition.js'
import { candidateHash, type Candidate, type VerificationRecord } from '../outcome/verification.js'
import { skillIndex, type SkillDefinition } from './definition.js'
import { createExplanationStage, explanationDeclarationSchema, parseExplanationDeclaration, readExplanationStage, type ExplanationStage } from './explanation-stage.js'

/** Authoritative intent only: activation does not prove delivery or numerical quality. */
export interface SkillActivation {
  id: string
  tenantId: string
  runId: string
  requestVersion: number
  skill: { name: string; version: string; hash: string }
  checker: string
  explanationStage?: ExplanationStage
}
/** A trusted product verifier must check current resource access and the actual candidate.
 * Unsupported/failed require an honest user-visible explanation; they never mean delivered. */
export interface SkillDeliveryDecision {
  activationId: string
  outcome: 'delivered' | 'unsupported' | 'failed' | 'pending'
  evidence: Record<string, unknown>
}
async function requireExplanationCapability(context: ActionContext): Promise<void> {
  if (context.work.conversation?.internal) throw new Error('explanation workflow requires public answer publication')
  const rows = (await context.database.query(`SELECT input FROM lingxios.agent_steps
    WHERE work_id=$1 AND kind='runtime.binding' AND completed_at IS NOT NULL LIMIT 2`, [context.work.id])).rows
  const binding = rows[0]?.['input'] as Record<string,unknown> | undefined
  if (rows.length !== 1 || binding?.['publicAnswerTool'] !== 'native-v1'
    || binding['publicTextContinuation'] !== 'typed-message-v1' || binding['publicTextProtocol'] !== 'purpose-json-v3'
    || binding['fastProvider'] !== undefined && (binding['fastPublicAnswerTool'] !== 'native-v1'
      || binding['fastPublicTextContinuation'] !== 'typed-message-v1' || binding['fastPublicTextProtocol'] !== 'purpose-json-v3')) {
    throw new Error('explanation workflow requires the pinned native public answer capability')
  }
}
const marker = 'skill-delivery:'
const fields = `a.id,a.tenant_id,a.work_id,a.request_version,a.skill_name,a.skill_version,a.skill_hash,a.checker`
export async function readSkillActivations(database: SqlQueryable, work: Pick<WorkItem, 'id' | 'tenantId' | 'principalId'>, requestVersion: number): Promise<SkillActivation[]> {
  const { rows } = await database.query(`SELECT ${fields} FROM lingxios.agent_skill_activations a
    JOIN lingxios.agent_work_items w ON w.id=a.work_id AND w.tenant_id=a.tenant_id AND w.principal_id=a.principal_id
    WHERE a.work_id=$1 AND a.tenant_id=$2 AND a.principal_id=$3 AND a.request_version=$4
      AND jsonb_array_length(w.steer_inputs)+1=$4 ORDER BY a.skill_name LIMIT 33`, [work.id,work.tenantId,work.principalId ?? null,requestVersion])
  if (rows.length > 32) throw new Error('too many activated skills')
  return rows.map(row => ({ id: String(row['id']), tenantId: String(row['tenant_id']), runId: String(row['work_id']), requestVersion: Number(row['request_version']),
    skill: { name: String(row['skill_name']), version: String(row['skill_version']), hash: String(row['skill_hash']) }, checker: String(row['checker']) }))
}
export function skillActivationTool(skills: readonly SkillDefinition[], allowed: (context: ActionContext, actions: string[]) => Promise<void>): ToolDefinition {
  const entries = skills.filter(skill => skill.delivery).map(skill => ({ skill: structuredClone(skill), index: skillIndex(skill) }))
  const entryFor = (input: Record<string, unknown>) => {
    const entry = entries.find(e => e.index.name === input['name'] && e.index.version === input['version'] && e.index.hash === input['hash'])
    if (!entry) throw new Error('unknown or changed authored skill delivery contract')
    return entry
  }
  return {
    name: 'skills__activate', action: 'skills.activate', effect: 'transaction', approval: false,
    description: 'Begin authoring under the indexed skill delivery contract. For a supported explanation-before-authoring workflow with directly supplied facts, explanation selects exact current human request quotes for the explanation, authoring, facts and optional language requirement. Reference-only reading uses skills.load. Activation records the delivery obligation; the product verifier checks the delivered result.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, hash: { type: 'string' },
      ...(entries.some(entry => entry.skill.workflow?.explanationBeforeAuthoring) ? { explanation: explanationDeclarationSchema } : {}) }, required: ['name','version','hash'], additionalProperties: false },
    semanticVersion: textSha256(canonicalJson(entries.map(e => e.index))),
    parse(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['hash,name,version','explanation,hash,name,version'].includes(Object.keys(input).sort().join(','))) throw new Error('invalid skill activation')
      const value = input as Record<string, unknown>, entry = entryFor(value)
      if (value['explanation'] !== undefined) {
        if (!entry.skill.workflow?.explanationBeforeAuthoring) throw new Error('skill has no explanation workflow')
        parseExplanationDeclaration(value['explanation'])
      }
      return value
    },
    async authorize(context, input) { await allowed(context, entryFor(input).index.actions) },
    async execute(context, input) {
      await this.authorize(context, input)
      const { index, skill } = entryFor(input), { work, requestVersion, database } = context
      if (!Number.isSafeInteger(requestVersion) || requestVersion! < 1 || !work.principalId) throw new Error('skill activation requires a current authenticated request')
      const current = await database.query(`SELECT 1 FROM lingxios.agent_work_items WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
        AND fence=$4 AND status='leased' AND lease_expires_at>NOW() AND cancel_requested_at IS NULL
        AND jsonb_array_length(steer_inputs)+1=$5 FOR UPDATE`, [work.id,work.tenantId,work.principalId,work.fence,requestVersion])
      if (current.rows.length !== 1) throw new Error('skill activation request changed or was cancelled')
      const active = await readSkillActivations(database, work, requestVersion!)
      const prior = active.find(a => a.skill.name === index.name)
      const id = textSha256(canonicalJson([work.tenantId,work.id,requestVersion,index.name,index.version,index.hash,index.delivery!.checker]))
      const previousStage = await readExplanationStage(database,work,requestVersion!,skills)
      if (input['explanation'] !== undefined) await requireExplanationCapability(context)
      const declared = input['explanation'] === undefined ? undefined
        : createExplanationStage(work,await context.requestSnapshot(),id,skill.workflow!.explanationBeforeAuthoring.authoringActions,input['explanation'],{name:index.name,version:index.version,hash:index.hash})
      if (previousStage && previousStage.requestVersion === requestVersion) {
        if (previousStage.activationId === id ? context.action.action === 'skills.activate'
          && (!declared || declared.id !== previousStage.id) : !!declared) throw new Error('activated explanation stage is immutable')
      } else if (previousStage && previousStage.skill.name === index.name && !declared) throw new Error('changed request requires a current explanation declaration')
      if (prior && declared && !previousStage) throw new Error('activation cannot acquire a different explanation plan')
      if (prior && prior.id !== id) throw new Error('activated skill contract changed')
      if (!prior && active.length >= 32) throw new Error('too many activated skills')
      await database.query(`INSERT INTO lingxios.agent_skill_activations(id,work_id,tenant_id,principal_id,request_version,skill_name,skill_version,skill_hash,checker)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(work_id,request_version,skill_name) DO NOTHING`,
      [id,work.id,work.tenantId,work.principalId,requestVersion,index.name,index.version,index.hash,index.delivery!.checker])
      return { ok: true, value: { activation: { ...(await readSkillActivations(database, work, requestVersion!)).find(a => a.id === id)!,
        ...(declared ? { explanationStage: declared } : {}) } } }
    },
    async verify(context, input, value) {
      await this.authorize(context, input)
      const expected = entryFor(input).index
      const activation = (await readSkillActivations(context.database, context.work, context.requestVersion!)).find(a => a.skill.name === expected.name)
      const stage = await readExplanationStage(context.database,context.work,context.requestVersion!,skills)
      const recorded = stage?.activationId === activation?.id ? { ...stage,status:'pending' as const } : undefined
      if (recorded) { delete recorded.provided; delete recorded.stale }
      const passed = activation && canonicalJson(value) === canonicalJson({ activation:{...activation,...(recorded?{explanationStage:recorded}:{})} }) && activation.skill.hash === expected.hash
      return { status: passed ? 'passed' : 'inconclusive', evidence: { scope: 'authoring_activation_only', deliveryProven: false } }
    },
  }
}
export function inspectSkillDeliveries(active: readonly SkillActivation[], input: readonly SkillDeliveryDecision[], unavailableIds: readonly string[] = []): VerificationRecord[] {
  if (!Array.isArray(input) || input.length > 32 || Buffer.byteLength(JSON.stringify(input)) > 64_000) throw new Error('invalid skill delivery decisions')
  const ids = new Set<string>()
  for (const decision of input) {
    if (!decision || typeof decision !== 'object' || Object.keys(decision).sort().join(',') !== 'activationId,evidence,outcome'
      || !active.some(a => a.id === decision.activationId) || ids.has(decision.activationId)
      || !['delivered','unsupported','failed','pending'].includes(decision.outcome)
      || !decision.evidence || typeof decision.evidence !== 'object' || Array.isArray(decision.evidence)) throw new Error('invalid skill delivery decision')
    ids.add(decision.activationId)
  }
  return active.map(activation => {
    const decision = input.find(d => d.activationId === activation.id)
    const outcome = decision?.outcome ?? 'pending'
    return { checker: marker + activation.id, status: outcome === 'pending' || outcome === 'delivered' && unavailableIds.includes(activation.id) ? 'inconclusive' : 'passed',
      evidence: { activationId: activation.id, skill: activation.skill, productChecker: activation.checker, outcome, available: !unavailableIds.includes(activation.id), ...(decision ? { observation: structuredClone(decision.evidence) } : {}) } }
  })
}
/** Called only inside the final message transaction, following fresh trusted verification. */
export async function commitSkillDeliveries(database: SqlQueryable, work: Omit<WorkItem, 'leaseToken'>, candidate: Candidate, checks: readonly VerificationRecord[]) {
  const active = await readSkillActivations(database, work, candidate.requestVersion)
  const deliveries = checks.filter(c => c.checker.startsWith(marker))
  if (deliveries.length !== active.length || deliveries.some(c => c.status !== 'passed')) throw new Error('skill delivery remains unverified')
  for (const activation of active) {
    const check = deliveries.find(c => c.checker === marker + activation.id), outcome = check?.evidence['outcome']
    if (!['delivered','unsupported','failed'].includes(String(outcome))) throw new Error('skill delivery remains unverified')
    const result = await database.query(`UPDATE lingxios.agent_skill_activations a SET resolution=$5,resolved_candidate_hash=$6,resolved_at=NOW()
      FROM lingxios.agent_work_items w WHERE a.id=$1 AND a.work_id=$2 AND a.tenant_id=$3 AND a.request_version=$4
        AND w.id=a.work_id AND w.tenant_id=a.tenant_id AND w.principal_id=a.principal_id AND w.principal_id=$7
        AND w.fence=$8 AND w.status='leased' AND w.lease_expires_at>NOW() AND w.cancel_requested_at IS NULL
        AND jsonb_array_length(w.steer_inputs)+1=$4 RETURNING a.id`,
    [activation.id,work.id,work.tenantId,candidate.requestVersion,outcome,candidateHash(candidate),work.principalId,work.fence])
    if (result.rows.length !== 1) throw new Error('skill delivery request changed before commit')
  }
}
