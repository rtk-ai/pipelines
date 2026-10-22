#!/usr/bin/env node
// Required status check on every PR that touches approved/** or revoked.toml.
//  - snapshots are immutable: only additions under approved/, never edits/deletes
//  - each added pipeline.toml is byte-identical to the upstream blob at <sha>
//  - precheck re-runs on the snapshot with the current rtk.pin; refused = fail
//  - entry.toml and report.json match their path and schema
//  - revoked.toml parses and every entry is well-formed
//
// env: RTK_BIN, BASE_REF (default origin/main)

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { fetchRaw } from './lib/github.mjs'
import { parseApprovedPath, rawUrl } from './lib/ids.mjs'
import { loadReserved, loadRevoked, validateRevoked } from './lib/policy.mjs'
import { parseEntry, validateEntry, validateReport } from './lib/entry.mjs'
import { precheck, loadRtkFacts } from './precheck.mjs'
import { sha256 } from './lib/analyze.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_REF || 'origin/main'

function changed() {
  const out = execFileSync('git', ['diff', '--name-status', `${BASE}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((l) => { const [status, ...rest] = l.split('\t'); return { status: status[0], path: rest[rest.length - 1] } })
}

function gistRaw(entry) {
  return `https://gist.githubusercontent.com/${entry.owner}/${entry.gist_id}/raw/${entry.sha}/${encodeURIComponent(entry.gist_file ?? 'pipeline.toml')}`
}

async function main() {
  const errors = []
  const files = changed()
  const touched = new Set()
  for (const f of files) {
    if (f.path.startsWith('approved/')) {
      if (f.status !== 'A') { errors.push(`${f.path}: snapshots are immutable (${f.status}); pull a pipeline through revoked.toml instead`); continue }
      const p = parseApprovedPath(f.path)
      if (!p) { errors.push(`${f.path}: not a valid approved/<owner>/<repo>/<sha>/{pipeline.toml,entry.toml,report.json} path`); continue }
      touched.add(`${p.owner}/${p.repo}/${p.sha}`)
    } else if (f.path === 'revoked.toml') {
      const errs = validateRevoked(loadRevoked(ROOT))
      errors.push(...errs)
    }
  }
  if (touched.size === 0 && !files.some((f) => f.path === 'revoked.toml')) { console.log('validate-pr: nothing to validate'); return }

  let facts = null
  for (const t of touched) {
    const [owner, repo, sha] = t.split('/')
    const dir = join(ROOT, 'approved', owner, repo, sha)
    const where = `approved/${t}`
    for (const n of ['pipeline.toml', 'entry.toml', 'report.json']) if (!existsSync(join(dir, n))) errors.push(`${where}: ${n} missing`)
    if (!existsSync(join(dir, 'pipeline.toml')) || !existsSync(join(dir, 'entry.toml')) || !existsSync(join(dir, 'report.json'))) continue

    const buffer = readFileSync(join(dir, 'pipeline.toml'))
    const entry = parseEntry(readFileSync(join(dir, 'entry.toml'), 'utf8'))
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    errors.push(...validateEntry(entry, where))
    if (entry.owner !== owner || entry.repo !== repo || entry.sha !== sha) errors.push(`${where}: entry.toml does not match its path`)
    const key = entry.source === 'gist' ? `gist/${entry.gist_id}@${sha}` : `${owner}/${repo}@${sha}`
    errors.push(...validateReport(report, where, { key, tomlSha: sha256(buffer.toString('utf8')) }))
    if (report.tier === 'refused') errors.push(`${where}: report tier is refused`)
    if (entry.tier !== report.tier) errors.push(`${where}: entry tier ${entry.tier} != report tier ${report.tier}`)

    // byte-identical to upstream at that commit
    try {
      const url = entry.source === 'gist' ? gistRaw(entry) : rawUrl(owner, repo, sha)
      const up = await fetchRaw(url)
      if (!up || !up.buffer) errors.push(`${where}: upstream blob not readable at ${url}`)
      else if (!up.buffer.equals(buffer)) errors.push(`${where}: snapshot differs from upstream ${url}`)
    } catch (e) { errors.push(`${where}: upstream fetch failed: ${e.message}`) }

    // re-run the pre-check with the pinned rtk
    if (!process.env.RTK_BIN) { errors.push(`${where}: RTK_BIN not set, cannot re-run precheck`); continue }
    facts ??= loadRtkFacts({ bin: process.env.RTK_BIN })
    const fresh = precheck(buffer.toString('utf8'), facts, { key, owner, repo, repoFacts: null, rtkBin: process.env.RTK_BIN, reserved: loadReserved(ROOT) })
    if (fresh.tier === 'refused') errors.push(`${where}: precheck now refuses: ${fresh.refusals.map((r) => r.code + (r.detail ? `(${r.detail})` : '')).join(', ')}`)
    else if (fresh.tier !== report.tier) errors.push(`${where}: tier drifted ${report.tier} -> ${fresh.tier} (regenerate report.json)`)
    else console.log(`${where}: ok (${fresh.tier}/${fresh.label}, rtk ${facts.version})`)
  }

  if (errors.length) { for (const e of errors) console.error(`✖ ${e}`); process.exit(1) }
  console.log(`validate-pr: ${touched.size} snapshot(s) valid`)
}

main().catch((e) => { console.error(`validate-pr: ${e.stack ?? e}`); process.exit(1) })
