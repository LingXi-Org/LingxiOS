/** Public v3 answer operations are declarations, never authority. */
export interface PublicTextOperation { kind: 'append' | 'replace'; supersedes: string[] }
export interface PublicTextSource { segmentId: string; partId: string; bodyHash: string; start: number; end: number }
export interface PublicTextSources { version: 3; messageId: string; segments: PublicTextSource[]; bodyHash: string }
export const answerMessageId = (runId: string, requestVersion: number): string => `answer:${runId}:v${requestVersion}`
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1000
export const isBodyHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function snapshotPublicTextOperation(value: unknown): PublicTextOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid answer operation')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 2 || !['append','replace'].includes(String(item['kind'])) || !Array.isArray(item['supersedes'])
    || item['supersedes'].length > 128 || !item['supersedes'].every(id) || new Set(item['supersedes']).size !== item['supersedes'].length
    || (item['kind'] === 'append' ? item['supersedes'].length !== 0 : item['supersedes'].length === 0)) throw new Error('invalid answer operation')
  return {kind:item['kind'] as PublicTextOperation['kind'],supersedes:[...item['supersedes']] as string[]}
}
export function snapshotPublicTextSources(value: unknown, bodyLength?: number): PublicTextSources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid answer sources')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key=>!['version','messageId','segments','bodyHash'].includes(key)) || record['version'] !== 3
    || !id(record['messageId']) || !isBodyHash(record['bodyHash']) || !Array.isArray(record['segments'])
    || !record['segments'].length || record['segments'].length > 128) throw new Error('invalid answer sources')
  const seen = new Set<string>(), revisions=new Set<string>(); let end = 0
  const segments = record['segments'].map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid answer source')
    const source=value as Record<string,unknown>
    if (Object.keys(source).length!==5 || !id(source['segmentId']) || seen.has(source['segmentId']) || !id(source['partId']) || revisions.has(source['partId']) || !isBodyHash(source['bodyHash'])
      || source['start']!==end || !Number.isSafeInteger(source['end']) || Number(source['end'])<end || Number(source['end'])>200_000) throw new Error('invalid answer source range')
    seen.add(source['segmentId']);revisions.add(source['partId']); end=Number(source['end'])
    return {segmentId:source['segmentId'],partId:source['partId'],bodyHash:source['bodyHash'],start:Number(source['start']),end}
  })
  if (bodyLength!==undefined && end!==bodyLength) throw new Error('answer sources do not cover the body')
  return {version:3,messageId:record['messageId'],segments,bodyHash:record['bodyHash']}
}
/** Exact concatenation, then one outer trim. Hashes are supplied by the trusted producer. */
export function assemblePublicTextSources(messageId:string, segments:readonly {segmentId:string;partId:string;bodyHash:string;text:string}[],bodyHash:string) {
  const raw=segments.map(segment=>segment.text).join(''), body=raw.trim(), left=raw.length-raw.trimStart().length
  let offset=0
  const sources:PublicTextSources={version:3,messageId,bodyHash,segments:segments.map(segment=>{
    const start=Math.max(0,Math.min(body.length,offset-left));offset+=segment.text.length
    return {segmentId:segment.segmentId,partId:segment.partId,bodyHash:segment.bodyHash,start,end:Math.max(start,Math.min(body.length,offset-left))}
  })}
  snapshotPublicTextSources(sources,body.length)
  return {body,sources}
}
