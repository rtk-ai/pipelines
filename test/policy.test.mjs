import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listApproved, loadRevoked, validateRevoked, isRevoked, loadReserved, loadBlocklist, isSettled } from '../scripts/lib/policy.mjs'
import { parseApprovedPath, reviewBranch, installLine, approvedDir } from '../scripts/lib/ids.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = join(HERE, 'fixtures/sample-repo')
const SHA = '53ec1322eb94c1013df491bdcaa453ad27e624f6'

test('sample repo lists three complete snapshots and one revocation', () => {
  const list = listApproved(SAMPLE)
  assert.equal(list.length, 3)
  const revoked = loadRevoked(SAMPLE)
  assert.deepEqual(validateRevoked(revoked), [])
  assert.ok(isRevoked(revoked, 'blackId90', 'rtk-pipeline-rtk-proxy', '9c178ad50b17e00dcf5146367b96b70482ca033d'))
  assert.ok(!isRevoked(revoked, 'aiKrice', 'rtk-pipeline-rtk-proxy', 'f9d0258b7fd666f824b270773771f85fb5912464'))
  assert.ok(validateRevoked([{ owner: 'x', repo: 'y', sha: 'short', reason: '', date: 'today' }]).length === 3)
})

test('repo policy files load', () => {
  const reserved = loadReserved(join(HERE, '..'))
  assert.ok(reserved.names.includes('official') && reserved.patterns.length > 0)
  assert.equal(loadBlocklist(join(HERE, '..')).size, 0)
})

test('identifiers are validated before they reach paths, branches or commands', () => {
  assert.deepEqual(parseApprovedPath(`approved/aeppling/rtk-pipeline-laya-delegate/${SHA}/entry.toml`), { owner: 'aeppling', repo: 'rtk-pipeline-laya-delegate', sha: SHA, file: 'entry.toml' })
  assert.equal(parseApprovedPath(`approved/../x/${SHA}/entry.toml`), null)
  assert.equal(parseApprovedPath(`approved/a/b/${SHA}/evil.sh`), null)
  assert.equal(reviewBranch('review', 'a', 'rtk-pipeline-b', SHA), 'review/a-rtk-pipeline-b-53ec132')
  assert.equal(installLine('a', 'b', SHA), `rtk pipeline add github:a/b@${SHA}`)
  assert.equal(approvedDir('a', 'b', SHA), `approved/a/b/${SHA}`)
  assert.throws(() => installLine('a b', 'c', SHA))
  assert.throws(() => installLine('a', 'c;touch pwned', SHA))
  assert.throws(() => installLine('a', 'c', 'HEAD'))
})

test('a commit the pinned rtk refused is checked again once the pin moves, every other result stays settled', () => {
  const byRtk = { result: 'rejected', reason: 'rtk_refused: rtk: validation errors E001 E002' }
  assert.equal(isSettled(undefined, 'v1.3.0'), false)
  assert.equal(isSettled({ ...byRtk, rtk: 'v1.0.1' }, 'v1.0.1'), true)
  assert.equal(isSettled({ ...byRtk, rtk: 'v1.0.1' }, 'v1.3.0'), false)
  assert.equal(isSettled(byRtk, 'v1.0.1'), false)
  assert.equal(isSettled({ result: 'rejected', reason: 'hidden_unicode: U+200B@L3; rtk_refused: rtk: validation errors E002' }, 'v1.3.0'), false)
  assert.equal(isSettled({ result: 'rejected', reason: 'secret_shape: sk-ant-…' }, 'v1.3.0'), true)
  assert.equal(isSettled({ result: 'rejected', reason: 'pipeline.toml is 70000 bytes (> 64 KB)' }, 'v1.3.0'), true)
  assert.equal(isSettled({ result: 'pr', pr: 'https://github.com/rtk-ai/pipelines/pull/9' }, 'v1.3.0'), true)
  assert.equal(isSettled({ result: 'approved' }, 'v1.3.0'), true)
})
