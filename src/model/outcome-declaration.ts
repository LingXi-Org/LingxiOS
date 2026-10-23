/** Same-generation declaration, never independent verification or authority. */
export type PublicTextProtocol = 'purpose-json-v1' | 'purpose-json-v2'
export interface OutcomeDeclaration {
  status: 'satisfied' | 'partial' | 'blocked'
  gaps: string[]
}

export function snapshotOutcomeDeclaration(value: unknown): OutcomeDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('outcome declaration is required')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'status') || !Object.hasOwn(record, 'gaps')
    || typeof record['status'] !== 'string' || !['satisfied', 'partial', 'blocked'].includes(record['status']) || !Array.isArray(record['gaps'])) throw new Error('invalid outcome declaration')
  const gaps = record['gaps'] as unknown[]
  if (gaps.length > 16 || Array.from(gaps).some(gap => typeof gap !== 'string' || !gap.trim() || gap.length > 1000
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(gap))
    || gaps.reduce<number>((size, gap) => size + (typeof gap === 'string' ? gap.length : 0), 0) > 8192
    || (record['status'] === 'satisfied' ? gaps.length !== 0 : gaps.length === 0)) throw new Error('invalid outcome declaration gaps')
  return { status: record['status'] as OutcomeDeclaration['status'], gaps: [...gaps] as string[] }
}

/** Exact bounded wire grammar prevents duplicate keys being swallowed by JSON.parse. */
export function parseOutcomeTail(tail: string): OutcomeDeclaration | null {
  if (tail.length > 32768) throw new Error('outcome declaration too large')
  let offset = 0
  const token = (expected: string) => {
    while (/[\t\r\n ]/.test(tail[offset] ?? '\0')) offset++
    if (!tail.startsWith(expected, offset)) throw new Error('invalid outcome framing')
    offset += expected.length
  }
  const string = () => {
    while (/[\t\r\n ]/.test(tail[offset] ?? '\0')) offset++
    const match = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
    match.lastIndex = offset
    const result = match.exec(tail)
    if (!result) throw new Error('invalid outcome string')
    offset = match.lastIndex
    return JSON.parse(result[0]) as string
  }
  let value: OutcomeDeclaration | null
  if (/^\s*null/.test(tail)) { token('null'); value = null }
  else {
    token('{'); token('"status"'); token(':'); const status = string()
    token(','); token('"gaps"'); token(':'); token('[')
    const gaps: string[] = []
    while (/[\t\r\n ]/.test(tail[offset] ?? '\0')) offset++
    if (tail[offset] !== ']') for (;;) {
      if (gaps.length >= 16) throw new Error('too many outcome gaps')
      gaps.push(string())
      while (/[\t\r\n ]/.test(tail[offset] ?? '\0')) offset++
      if (tail[offset] !== ',') break
      token(',')
    }
    token(']'); token('}'); value = snapshotOutcomeDeclaration({ status, gaps })
  }
  token('}')
  if (!/^[\t\r\n ]*$/.test(tail.slice(offset))) throw new Error('trailing outcome content')
  return value
}
