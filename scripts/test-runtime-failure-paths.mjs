import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { projectRuntimeFailure } from '../dist/src/runtime/failure-diagnostics.js'

const root = new URL('../dist/src/', import.meta.url)
const project = stack => projectRuntimeFailure({ name: 'Error', stack }, { runId: 'diagnostic-path', fence: 1 },
  { phase: 'session_restore', bindingState: 'not_started', requestVersion: 1 })

for (const location of [fileURLToPath(new URL('runtime/runtime.js', root)), new URL('runtime/runtime.js', root).href]) {
  test(`retains an allowlisted native frame from ${location.startsWith('file:') ? 'a file URL' : 'an absolute path'}`, () => {
    assert.deepEqual(project(`Error\n    at native (${location}:88:19)`).frames,
      [{ module: 'runtime/runtime.js', line: 88, column: 19 }])
  })
}

test('rejects external paths and query-bearing native URLs without exposing their content', () => {
  const diagnostic = project(`Error: PRIVATE_SENTINEL
    at external (/private/PRIVATE_SENTINEL/src/runtime/runtime.js:1:2)
    at external (C:\\private\\PRIVATE_SENTINEL\\src\\runtime\\runtime.js:1:2)
    at query (${new URL('runtime/runtime.js?token=PRIVATE_SENTINEL', root).href}:1:2)`)
  assert.deepEqual(diagnostic.frames, [])
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_SENTINEL|private|token/)
})
