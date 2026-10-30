import { RunnableBranch } from '@langchain/core/runnables'
import { canonicalJson, textSha256 } from '../context/compiler.js'
import type { RequestSnapshot } from '../context/request.js'
import { requestSnapshot } from '../app/jobs.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import type { ToolDefinition } from '../tools/catalog.js'
import { skillIndex, type SkillDefinition, type SkillIndex } from './definition.js'
import { AnswerSegmentSet } from '../runtime/answer-segments.js'

export interface ExplanationDeclaration {
  explanationQuote: string
  authoringQuote: string
  factQuotes: string[]
  languageQuote?: string
}
export interface RequestQuote { sourceRef: string; start: number; end: number; text: string }
/** References prove provenance, not the model's interpretation or semantic correctness. */
export interface ExplanationStage {
  version: 1
  id: string
  activationId: string
  skill: Pick<SkillIndex, 'name' | 'version' | 'hash'>
  runId: string
  requestVersion: number
  sourceRef: string
  requestHash: string
  quotes: { explanation: RequestQuote; authoring: RequestQuote; facts: RequestQuote[]; language?: RequestQuote }
  authoringActions: string[]
  status: 'pending' | 'provided'
  stale?: boolean
  provided?: { partId: string; bodyHash: string }
}
const quoteSchema = { type: 'string', minLength: 1, maxLength: 2000 }
export const explanationDeclarationSchema = { type: 'object', additionalProperties: false,
  properties: { explanationQuote: quoteSchema, authoringQuote: quoteSchema,
    factQuotes: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: quoteSchema }, languageQuote: quoteSchema },
  required: ['explanationQuote', 'authoringQuote', 'factQuotes'] }

export function parseExplanationDeclaration(value: unknown): ExplanationDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid explanation declaration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['explanationQuote','authoringQuote','factQuotes','languageQuote'].includes(key))) throw new Error('unknown explanation declaration field')
  const quote = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000 && Buffer.from(value,'utf8').toString('utf8') === value
  if (!quote(input['explanationQuote']) || !quote(input['authoringQuote']) || !Array.isArray(input['factQuotes'])
    || !input['factQuotes'].length || input['factQuotes'].length > 8 || !input['factQuotes'].every(quote)
    || new Set(input['factQuotes']).size !== input['factQuotes'].length
    || input['languageQuote'] !== undefined && !quote(input['languageQuote'])
    || Buffer.byteLength(JSON.stringify(input)) > 16_000) throw new Error('invalid explanation references')
  return structuredClone(input) as unknown as ExplanationDeclaration
}

export function explanationRequestHash(request: RequestSnapshot): string {
  return textSha256(canonicalJson({ workId: request.workId, authorId: request.authorId,
    sourceRef: request.sourceRef, originalText: request.originalText, revisions: request.revisions }))
}

export function createExplanationStage(work: Pick<WorkItem,'id'|'tenantId'|'principalId'>, request: RequestSnapshot,
  activationId: string, authoringActions: readonly string[], value: unknown, skill: Pick<SkillIndex,'name'|'version'|'hash'>): ExplanationStage {
  const declaration = parseExplanationDeclaration(value)
  if (request.workId !== work.id || request.tenantId !== work.tenantId || request.authorId !== work.principalId
    || request.instructionAuthor || request.parentWorkId) throw new Error('explanation stage requires a direct human request')
  const sources = [{ sourceRef: request.sourceRef, text: request.originalText }, ...request.revisions
    .filter(revision => revision.author?.kind === 'human' && revision.author.id === work.principalId)
    .map(revision => ({ sourceRef: revision.id, text: revision.text }))]
  const locate = (text: string): RequestQuote => {
    const matches: RequestQuote[] = []
    for (const source of sources) {
      const start = source.text.indexOf(text)
      if (start < 0) continue
      if (source.text.indexOf(text, start + 1) >= 0) throw new Error('explanation quote must identify one request range')
      matches.push({ sourceRef: source.sourceRef, start, end: start + text.length, text })
    }
    if (matches.length !== 1) throw new Error('explanation quote is not a unique current human request range')
    return matches[0]!
  }
  const bound = { version: 1 as const, activationId, skill:{name:skill.name,version:skill.version,hash:skill.hash}, runId: work.id, requestVersion: request.revisions.length + 1,
    sourceRef: request.sourceRef, requestHash: explanationRequestHash(request),
    quotes: { explanation: locate(declaration.explanationQuote), authoring: locate(declaration.authoringQuote),
      facts: declaration.factQuotes.map(locate), ...(declaration.languageQuote ? { language: locate(declaration.languageQuote) } : {}) },
    authoringActions: [...authoringActions] }
  return { ...bound, id: textSha256(canonicalJson(bound)), status: 'pending' }
}

/** Only native, successful activation receipts are stage authority. No model step or public prose is. */
export async function readExplanationStage(database: SqlQueryable, work: Pick<WorkItem,'id'|'tenantId'|'principalId'|'fence'>,
  version: number, skills: readonly SkillDefinition[]): Promise<ExplanationStage | undefined> {
  if (!skills.some(skill => skill.workflow?.explanationBeforeAuthoring)) return undefined
  const rows = (await database.query(`SELECT a.skill_name,a.skill_version,a.skill_hash,a.id,
      r.result->'value'->'activation'->'explanationStage' AS stage
    FROM lingxios.agent_action_intents i JOIN lingxios.agent_action_ledger r USING(idempotency_key)
    JOIN lingxios.agent_skill_activations a ON a.id=r.result->'value'->'activation'->>'id'
    WHERE a.work_id=$1 AND a.tenant_id=$2 AND a.principal_id=$3 AND a.request_version=$4
      AND i.intent->>'workId'=a.work_id AND i.intent->>'tenantId'=a.tenant_id
      AND i.intent->>'principalId'=a.principal_id AND (i.intent->>'requestVersion')::int=a.request_version
      AND i.intent->'action'->>'action'='skills.activate' AND r.result->>'ok'='true'
      AND r.result->'value'->'activation'->'explanationStage' IS NOT NULL
    ORDER BY a.request_version DESC LIMIT 33`, [work.id,work.tenantId,work.principalId ?? null,version])).rows
  if (!rows.length) return undefined
  const latest = rows[0]!, stage = latest['stage'] as ExplanationStage
  if (rows.length > 32 || rows.some(row => (row['stage'] as ExplanationStage).requestVersion === stage.requestVersion
    && (row['stage'] as ExplanationStage).id !== stage.id)) throw new Error('conflicting explanation stages')
  const skill = skills.find(item => item.name === latest['skill_name'])
  // Registry hashes are checked by the activation and pinned harness. Changed or removed support fails closed.
  if (!skill?.workflow?.explanationBeforeAuthoring || skill.version !== latest['skill_version'] || skillIndex(skill).hash !== latest['skill_hash']
    || stage.activationId !== latest['id'] || stage.runId !== work.id || stage.version !== 1 || stage.status !== 'pending'
    || canonicalJson(stage.authoringActions) !== canonicalJson(skill.workflow.explanationBeforeAuthoring.authoringActions)) throw new Error('explanation stage contract changed')
  const request = await requestSnapshot(database,work.id,version)
  if (stage.requestVersion !== version || stage.requestHash !== explanationRequestHash(request)) throw new Error('explanation request binding changed')
  const expected = createExplanationStage(work,request,stage.activationId,stage.authoringActions,{
    explanationQuote:stage.quotes.explanation.text, authoringQuote:stage.quotes.authoring.text,
    factQuotes:stage.quotes.facts.map(quote => quote.text), ...(stage.quotes.language ? { languageQuote:stage.quotes.language.text } : {}) },{name:skill.name,version:skill.version,hash:skillIndex(skill).hash})
  if (canonicalJson(expected) !== canonicalJson(stage)) throw new Error('invalid persisted explanation stage')
  const sealed = (await database.query(`SELECT input,output FROM lingxios.agent_steps WHERE work_id=$1
    AND request_version=$2 AND kind='runtime.answer_segment' AND completed_at IS NOT NULL ORDER BY step_seq LIMIT 2049`,[work.id,version])).rows
  if (sealed.length>2048) throw new Error('explanation source history exceeds recovery bound')
  const records = new AnswerSegmentSet(work.id,version,work.fence,sealed.map((row,index) => ({
    id:String(index),kind:'runtime.answer_segment',requestVersion:version,input:row['input'] as Record<string,unknown>,
    output:row['output'] as string,artifacts:[] }))).records
  for (const record of records) {
    if (record.recovery?.version !== 2 || record.recovery.explanationStageId !== stage.id) continue
    // Both a new explanation and a corrected replacement can satisfy the current
    // pending stage. AnswerSegmentSet retains only active, validated sources.
    if (record.recovery.phase !== 'intermediate' || !record.text.trim()) throw new Error('invalid explanation stage source')
    return { ...stage, status:'provided', provided:{partId:record.identity.partId,bodyHash:record.bodyHash} }
  }
  return stage
}

type Schedule = { tools: readonly ToolDefinition[]; stage?: ExplanationStage }
/** Reuse the upstream branch combinator only for routing; the existing runtime owns the loop. */
const schedule = RunnableBranch.from<Schedule, ToolDefinition[]>([
  [input => input.stage?.status === 'pending', input => input.tools.filter(tool => !input.stage!.authoringActions.includes(tool.action))],
  input => [...input.tools],
])
export function explanationStageTools(tools: readonly ToolDefinition[], stage?: ExplanationStage): Promise<ToolDefinition[]> {
  return schedule.invoke({ tools, ...(stage ? { stage } : {}) })
}
export function explanationStageInstructions(stage: ExplanationStage): string {
  if (stage.stale) return 'The request changed. Select the workflow using the current human request before authoring.'
  if(stage.status==='provided')return 'Current workflow phase: the explanation is durably recorded. Continue the requested authoring now using an actually exposed authoring tool; another explanation or a promise to save does not perform the action. If the output contract requires public_answer first, include it and the needed business call in the SAME generation. Preserve existing successful receipts: if authoring is already done, verify and deliver that saved result instead of saving again. Finish only with the verified result or an honest remaining gap.'
  return 'Current workflow phase: explain the selected request facts. Authoring tools are temporarily unavailable until this explanation is recorded. Publish a substantive intermediate public_answer with outcome:null, using the required append or replacement operation for the current answer. Do not call an unavailable authoring tool or repeat a previously recorded explanation. The next generation can author after the explanation is durably recorded.'
}
