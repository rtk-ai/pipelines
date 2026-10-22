import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { precheck, loadRtkFacts } from '../scripts/precheck.mjs'
import { validateReport, validateEntry, entryToml, parseEntry } from '../scripts/lib/entry.mjs'
import { loadReserved } from '../scripts/lib/policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FX = join(HERE, 'fixtures')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const reserved = loadReserved(ROOT)

test('precheck without rtk produces a schema-valid report', () => {
  const facts = loadRtkFacts({ fixtures: FX })
  const toml = readFileSync(join(FX, 'candidates/laya-delegate.toml'), 'utf8')
  const r = precheck(toml, facts, { key: `tester/rtk-pipeline-laya-delegate@${SHA}`, owner: 'tester', repo: 'rtk-pipeline-laya-delegate', rtkBin: null, reserved })
  assert.equal(r.tier, 'text')
  assert.equal(r.add_exit_code, null)
  assert.deepEqual(validateReport(r, 'r', { key: r.key, requireRtk: false }), [])
})

test('entry.toml round-trips and validates', () => {
  const text = entryToml({ owner: 'tester', repo: 'rtk-pipeline-x', sha: SHA, name: 'x', tier: 'safe', rtk: 'v1.0.1', pr: 12, submitted_at: '2026-10-22T00:00:00Z' })
  const e = parseEntry(text)
  assert.deepEqual(validateEntry(e, 'e'), [])
  assert.ok(validateEntry({ ...e, sha: 'nope' }, 'e').length === 1)
  assert.ok(validateEntry({ ...e, tier: 'refused' }, 'e').length === 1)
})

const RTK = process.env.RTK_BIN || ['x86_64-unknown-linux-musl', 'aarch64-apple-darwin', ''].map((k) => join(ROOT, '.cache/rtk/v1.0.1', k, 'rtk')).find(existsSync)

test('with the pinned rtk binary: rtk refuses api_key_command and validation errors, accepts laya-delegate', { skip: !RTK && 'no pinned rtk binary (run scripts/rtk-pinned.sh)' }, () => {
  const facts = loadRtkFacts({ bin: RTK })
  const go = (f, repo) => precheck(readFileSync(join(FX, 'candidates', f), 'utf8'), facts, { key: `tester/${repo}@${SHA}`, owner: 'tester', repo, rtkBin: RTK, reserved })
  const bad = go('bad-key-command.toml', 'rtk-pipeline-bad')
  assert.equal(bad.add_exit_code, 1)
  assert.ok(bad.refusals.some((r) => r.code === 'rtk_refused' && /api_key_command/.test(r.detail)))
  const inv = go('invalid.toml', 'rtk-pipeline-invalid')
  assert.equal(inv.tier, 'refused')
  assert.ok(inv.refusals.some((r) => /E005/.test(r.detail)))
  const ok = go('laya-delegate.toml', 'rtk-pipeline-laya-delegate')
  assert.equal(ok.add_exit_code, 0)
  assert.ok(ok.add_stdout.includes('inline directive — full text'))
  assert.equal(ok.tier, 'text')
  assert.equal(facts.version, 'v1.0.1')
})
