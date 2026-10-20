import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('confirms committed deletion without old context and recovers only current authorized receipts', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(),'memory-deletion-confirmation-'))
  const root = fileURLToPath(new URL('../../',import.meta.url))
  try {
    const report = join(directory,'counts.json')
    await promisify(execFile)(process.execPath,[join(root,'docs/evidence/issue-216-confirmation-completeness/deletion-probe.mjs'),root,report],{timeout:55_000})
    const result = JSON.parse(await readFile(report,'utf8'))
    assert.equal(result.cases.length,6)
    assert.equal(result.passed,true)
  } finally { await rm(directory,{recursive:true,force:true}) }
})
