import assert from 'node:assert/strict'
import test from 'node:test'
import { assertMaintenancePackage, assertMaintenanceRun } from './check-maintenance-source.mjs'

const baseline = { version: '3.8.16', name: '@lyyzka/lingxios', exports: { '.': 'index.js', './eval': 'eval.js' }, files: ['db', 'dist'], dependencies: { a: '1' } }
test('maintenance permits only compatible patch metadata and an exact new tag', () => {
  assert.equal(assertMaintenancePackage({ ...baseline, version: '3.8.17' }, baseline, 'refs/tags/v3.8.17'), 'release/3.8')
  for (const version of ['3.8.15', '3.8.017', '3.8.17-rc.0', '3.9.0', '4.0.0-slim.0']) assert.throws(() => assertMaintenancePackage({ ...baseline, version }, baseline))
  assert.throws(() => assertMaintenancePackage(baseline, baseline, 'refs/tags/v3.8.16'))
  assert.throws(() => assertMaintenancePackage({ ...baseline, version: '3.8.17' }, baseline, 'refs/tags/v3.8.18'))
  for (const change of [{ exports: { '.': 'index.js' } }, { files: ['dist'] }, { dependencies: { a: '2' } }]) assert.throws(() => assertMaintenancePackage({ ...baseline, version: '3.8.17', ...change }, baseline))
})
test('formal qualification requires exact successful maintenance push with full gates', () => {
  const run = { head_sha: 'candidate', head_branch: 'release/3.8', event: 'push', name: 'release-gates', conclusion: 'success' }
  assert.doesNotThrow(() => assertMaintenanceRun(run, 'candidate'))
  for (const change of [{ head_sha: 'older' }, { head_branch: 'main' }, { event: 'pull_request' }, { name: 'package' }, { conclusion: 'failure' }, { conclusion: null }]) assert.throws(() => assertMaintenanceRun({ ...run, ...change }, 'candidate'))
})
