import { RunnableBranch } from '@langchain/core/runnables'
import { canonicalJson, textSha256 } from '../context/compiler.js'
import type { RequestSnapshot } from '../context/request.js'
import { requestSnapshot } from '../app/jobs.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import type { ToolDefinition } from '../tools/catalog.js'
import { skillIndex, type SkillDefinition, type SkillIndex } from './definition.js'
import { AnswerSegmentSet } from '../runtime/answer-segments.js'
import { NoEffectError } from '../tools/definition.js'
import { explanationReferenceCorrections } from '../tools/failure.js'

/** sourceRef is the existing trusted request context item's source identifier.
 * Ranges use UTF-16 offsets into that exact source; omitting both selects it whole. */
export type ExplanationQuoteSelection = string | { sourceRef: string; start?: number; end?: number }
export interface ExplanationDeclaration {
  explanationQuote: ExplanationQuoteSelection
  authoringQuote: ExplanationQuoteSelection
  factQuotes: ExplanationQuoteSelection[]
  languageQuote?: ExplanationQuoteSelection
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
const sourceRefSchema = { type: 'string', minLength: 1, maxLength: 2000 }
const quoteSchema = { anyOf: [
  { type: 'string', minLength: 1, maxLength: 2000 },
  { type: 'object', additionalProperties: false, properties: { sourceRef: sourceRefSchema }, required: ['sourceRef'] },
  { type: 'object', additionalProperties: false, properties: { sourceRef: sourceRefSchema,
    start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }, required: ['sourceRef','start','end'] },
] }
export const explanationDeclarationSchema = { type: 'object', additionalProperties: false,
  properties: { explanationQuote: quoteSchema, authoringQuote: quoteSchema,
    factQuotes: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: quoteSchema }, languageQuote: quoteSchema },
  required: ['explanationQuote', 'authoringQuote', 'factQuotes'] }

export function parseExplanationDeclaration(value: unknown): ExplanationDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExplanationReferenceError('explanation_reference_invalid')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['explanationQuote','authoringQuote','factQuotes','languageQuote'].includes(key))) throw new ExplanationReferenceError('explanation_reference_invalid')
  const quote = (value: unknown): value is ExplanationQuoteSelection => {
    if (typeof value === 'string') return validQuoteText(value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const selection = value as Record<string,unknown>, keys = Object.keys(selection).sort().join(',')
    return validQuoteText(selection['sourceRef']) && (keys === 'sourceRef' || keys === 'end,sourceRef,start'
      && Number.isSafeInteger(selection['start']) && Number(selection['start']) >= 0
      && Number.isSafeInteger(selection['end']) && Number(selection['end']) > Number(selection['start']))
  }
  if (!quote(input['explanationQuote']) || !quote(input['authoringQuote']) || !Array.isArray(input['factQuotes'])
    || !input['factQuotes'].length || input['factQuotes'].length > 8 || !input['factQuotes'].every(quote)
    || new Set(input['factQuotes'].map(canonicalJson)).size !== input['factQuotes'].length
    || input['languageQuote'] !== undefined && !quote(input['languageQuote'])
    || Buffer.byteLength(JSON.stringify(input)) > 16_000) throw new ExplanationReferenceError('explanation_reference_invalid')
  return structuredClone(input) as unknown as ExplanationDeclaration
}

const validQuoteText = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 2000 && Buffer.from(value,'utf8').toString('utf8') === value
type ReferenceFailure = keyof typeof explanationReferenceCorrections
export class ExplanationReferenceError extends NoEffectError {
  constructor(code: ReferenceFailure) {
    super(explanationReferenceCorrections[code], code)
  }
}

export function explanationRequestHash(request: RequestSnapshot): string {
  return textSha256(canonicalJson({ workId: request.workId, authorId: request.authorId,
    sourceRef: request.sourceRef, originalText: request.originalText, revisions: request.revisions }))
}

export function createExplanationStage(work: Pick<WorkItem,'id'|'tenantId'|'principalId'>, request: RequestSnapshot,
  activationId: string, authoringActions: readonly string[], value: unknown, skill: Pick<SkillIndex,'name'|'version'|'hash'>): ExplanationStage {
  const declaration = parseExplanationDeclaration(value)
  if (request.workId !== work.id || request.tenantId !== work.tenantId || request.authorId !== work.principalId
    || request.instructionAuthor || request.parentWorkId) throw new NoEffectError('explanation stage requires a direct human request', 'forbidden')
  const sources = [{ sourceRef: request.sourceRef, text: request.originalText }, ...request.revisions
    .filter(revision => revision.author?.kind === 'human' && revision.author.id === work.principalId)
    .map(revision => ({ sourceRef: revision.id, text: revision.text }))]
  const locate = (selection: ExplanationQuoteSelection): RequestQuote => {
    if (typeof selection !== 'string') {
      const matched = sources.filter(source => source.sourceRef === selection.sourceRef)
      if (!matched.length) throw new ExplanationReferenceError('explanation_reference_not_found')
      if (matched.length !== 1) throw new ExplanationReferenceError('explanation_reference_ambiguous')
      const source = matched[0]!, start = selection.start ?? 0, end = selection.end ?? source.text.length
      const text = source.text.slice(start,end)
      if (end > source.text.length || !validQuoteText(text)) throw new ExplanationReferenceError('explanation_reference_invalid')
      return { sourceRef: source.sourceRef, start, end, text }
    }
    const text = selection
    const matches: RequestQuote[] = []
    for (const source of sources) {
      const start = source.text.indexOf(text)
      if (start < 0) continue
      if (source.text.indexOf(text, start + 1) >= 0) throw new ExplanationReferenceError('explanation_reference_ambiguous')
      matches.push({ sourceRef: source.sourceRef, start, end: start + text.length, text })
    }
    if (!matches.length) throw new ExplanationReferenceError('explanation_reference_not_found')
    if (matches.length !== 1) throw new ExplanationReferenceError('explanation_reference_ambiguous')
    return matches[0]!
  }
  const facts = declaration.factQuotes.map(locate)
  if (new Set(facts.map(canonicalJson)).size !== facts.length) throw new ExplanationReferenceError('explanation_reference_invalid')
  const bound = { version: 1 as const, activationId, skill:{name:skill.name,version:skill.version,hash:skill.hash}, runId: work.id, requestVersion: request.revisions.length + 1,
    sourceRef: request.sourceRef, requestHash: explanationRequestHash(request),
    quotes: { explanation: locate(declaration.explanationQuote), authoring: locate(declaration.authoringQuote),
      facts, ...(declaration.languageQuote ? { language: locate(declaration.languageQuote) } : {}) },
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
    explanationQuote:quoteSelection(stage.quotes.explanation), authoringQuote:quoteSelection(stage.quotes.authoring),
    factQuotes:stage.quotes.facts.map(quoteSelection), ...(stage.quotes.language ? { languageQuote:quoteSelection(stage.quotes.language) } : {}) },{name:skill.name,version:skill.version,hash:skillIndex(skill).hash})
  if (canonicalJson(expected) !== canonicalJson(stage)) throw new Error('invalid persisted explanation stage')
  const sealed = (await database.query(`SELECT kind,input,output FROM lingxios.agent_steps WHERE work_id=$1
    AND request_version=$2 AND kind IN ('runtime.answer_segment','runtime.answer_candidate_failure') AND completed_at IS NOT NULL ORDER BY step_seq LIMIT 2049`,[work.id,version])).rows
  if (sealed.length>2048) throw new Error('explanation source history exceeds recovery bound')
  const records = new AnswerSegmentSet(work.id,version,work.fence,sealed.map((row,index) => ({
    id:String(index),kind:String(row['kind']),requestVersion:version,input:row['input'] as Record<string,unknown>,
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

const quoteSelection = ({ sourceRef, start, end }: RequestQuote): ExplanationQuoteSelection => ({ sourceRef, start, end })

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
