import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MAINTENANCE_BASE = '067aa69a3bc456101ef73e0a8b37dfa2306c0277'
export const MAINTENANCE_BRANCH = 'release/3.8'
const root = fileURLToPath(new URL('../', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

export function assertMaintenancePackage(current, baseline, tag) {
  assert.equal(baseline.version, '3.8.16')
  const patch = /^3\.8\.(0|[1-9]\d*)$/.exec(current.version)
  assert.ok(patch && Number.isSafeInteger(Number(patch[1])) && Number(patch[1]) >= 16, 'requires a canonical 3.8 maintenance version')
  for (const key of ['name', 'type', 'engines', 'exports', 'files', 'dependencies', 'publishConfig']) {
    assert.deepEqual(current[key], baseline[key], `3.8 maintenance changed ${key}`)
  }
  if (tag !== undefined) {
    assert.equal(tag, `refs/tags/v${current.version}`, 'tag/package mismatch')
    assert.notEqual(current.version, '3.8.16', 'published baseline cannot be republished')
  }
  return MAINTENANCE_BRANCH
}

export function assertMaintenanceRun(run, sha) {
  assert.equal(run.head_sha, sha, 'qualification SHA mismatch')
  assert.equal(run.head_branch, MAINTENANCE_BRANCH, 'qualification branch mismatch')
  assert.equal(run.event, 'push', 'qualification must follow maintenance merge')
  assert.equal(run.name, 'release-gates', 'maintenance requires full release gates')
  assert.equal(run.conclusion, 'success', 'maintenance release gates did not pass')
}

export function checkMaintenanceSource(tag) {
  const current = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  const baseline = JSON.parse(git('show', `${MAINTENANCE_BASE}:package.json`))
  assertMaintenancePackage(current, baseline, tag)
  execFileSync('git', ['merge-base', '--is-ancestor', MAINTENANCE_BASE, 'HEAD'], { cwd: root })
  assert.equal(git('diff', '--name-only', MAINTENANCE_BASE, 'HEAD', '--', 'db'), '', 'maintenance changed native database resources')
  assert.equal(git('diff', '--name-only', '--', 'package.json', 'package-lock.json', 'src', 'db', '.github', 'scripts'), '', 'uncommitted release source')
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
  assert.equal(lock.version, current.version)
  assert.equal(lock.packages[''].version, current.version)
  return { branch: MAINTENANCE_BRANCH, sha: git('rev-parse', 'HEAD'), version: current.version, baseline: MAINTENANCE_BASE }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkMaintenanceSource()))
