#!/usr/bin/env node
// Required status check on every PR that touches approved/** or revoked.toml.
//
// It runs from the BASE branch's code (workflow: pull_request_target) and reads
// the PR's files straight out of git, so a PR can neither change the validator
// that judges it nor get anything of its own executed. Checks:
//  - snapshots are immutable: only additions under approved/, never edits/deletes
//  - each added pipeline.toml (and benchmark.toml) is byte-identical to the upstream blob at <sha>
//  - precheck re-runs on the snapshot with the current rtk.pin; refused = fail
//  - report.benchmark matches benchmark.toml; entry.toml and report.json match their path and schema
//  - revoked.toml parses and every entry is well-formed
//
// env: RTK_BIN, BASE_REF (default origin/main), HEAD_REF (default HEAD)

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { fetchRaw } from './lib/github.mjs'
import { parseApprovedPath, rawUrl, benchmarkRawUrl } from './lib/ids.mjs'
import { loadReserved, parseRevoked, validateRevoked } from './lib/policy.mjs'
import { parseEntry, validateEntry, validateReport } from './lib/entry.mjs'
import { parseBenchmarkToml, BENCH_MAX_BYTES } from './lib/benchmark.mjs'
import { precheck, loadRtkFacts } from './precheck.mjs'
import { sha256 } from './lib/analyze.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_REF || 'origin/main'
const HEAD = process.env.HEAD_REF || 'HEAD'
const MAX_FILE = 1024 * 1024

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, ...opts })
}
function changed() {
  const out = git(['diff', '--name-status', `${BASE}...${HEAD}`], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((l) => { const [status, ...rest] = l.split('\t'); return { status: status[0], path: rest[rest.length - 1] } })
}
/** The PR's version of a file, as bytes, without checking anything out. */
function existsAt(path) {
  try { git(['cat-file', '-e', `${HEAD}:${path}`], { stdio: 'ignore' }); return true } catch { return false }
}
function readAt(path) {
  const buf = git(['show', `${HEAD}:${path}`])
  if (buf.length > MAX_FILE) throw new Error(`${path} is ${buf.length} bytes (> ${MAX_FILE})`)
  return buf
}
function gistRaw(entry) {
  return `https://gist.githubusercontent.com/${entry.owner}/${entry.gist_id}/raw/${entry.sha}/${encodeURIComponent(entry.gist_file ?? 'pipeline.toml')}`
}

async function main() {
  const errors = []
  const files = changed()
  const touched = new Set()
  let revokedTouched = false
  for (const f of files) {
    if (f.path.startsWith('approved/')) {
      if (f.status !== 'A') { errors.push(`${f.path}: snapshots are immutable (${f.status}); pull a pipeline through revoked.toml instead`); continue }
      const p = parseApprovedPath(f.path)
      if (!p) { errors.push(`${f.path}: not a valid approved/<owner>/<repo>/<sha>/{pipeline.toml,entry.toml,report.json,benchmark.toml} path`); continue }
      touched.add(`${p.owner}/${p.repo}/${p.sha}`)
    } else if (f.path === 'revoked.toml') {
      revokedTouched = true
      try { errors.push(...validateRevoked(parseRevoked(readAt('revoked.toml').toString('utf8')))) } catch (e) { errors.push(`revoked.toml: ${e.message}`) }
    }
  }
  if (touched.size === 0 && !revokedTouched) { console.log('validate-pr: nothing to validate'); return }

  let facts = null
  for (const t of touched) {
    const [owner, repo, sha] = t.split('/')
    const dir = `approved/${owner}/${repo}/${sha}`
    const where = dir
    const missing = ['pipeline.toml', 'entry.toml', 'report.json'].filter((n) => !existsAt(`${dir}/${n}`))
    for (const n of missing) errors.push(`${where}: ${n} missing`)
    if (missing.length) continue

    let buffer, entry, report
    try {
      buffer = readAt(`${dir}/pipeline.toml`)
      entry = parseEntry(readAt(`${dir}/entry.toml`).toString('utf8'))
      report = JSON.parse(readAt(`${dir}/report.json`).toString('utf8'))
    } catch (e) { errors.push(`${where}: unreadable snapshot: ${e.message}`); continue }

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

    // optional author benchmark: valid, equal to report.benchmark, byte-identical upstream
    if (existsAt(`${dir}/benchmark.toml`)) {
      let bb
      try { bb = readAt(`${dir}/benchmark.toml`) } catch (e) { errors.push(`${where}: benchmark.toml unreadable: ${e.message}`); bb = null }
      if (bb) {
        const parsed = parseBenchmarkToml(bb.toString('utf8'))
        if (!parsed.benchmark) errors.push(`${where}: benchmark.toml invalid: ${parsed.errors.join('; ')}`)
        else if (JSON.stringify(parsed.benchmark) !== JSON.stringify(report.benchmark ?? null)) errors.push(`${where}: report.benchmark does not match benchmark.toml (regenerate report.json)`)
        if (entry.source === 'github') {
          try {
            const up = await fetchRaw(benchmarkRawUrl(owner, repo, sha), BENCH_MAX_BYTES)
            if (!up?.buffer) errors.push(`${where}: upstream benchmark.toml not readable`)
            else if (!up.buffer.equals(bb)) errors.push(`${where}: benchmark.toml differs from upstream`)
          } catch (e) { errors.push(`${where}: upstream benchmark.toml fetch failed: ${e.message}`) }
        }
      }
    } else if (report.benchmark) errors.push(`${where}: report.benchmark is set but benchmark.toml is not in the snapshot`)

    // re-run the pre-check with the pinned rtk (the TOML is data; rtk runs in a throwaway HOME)
    if (!process.env.RTK_BIN) { errors.push(`${where}: RTK_BIN not set, cannot re-run precheck`); continue }
    facts ??= loadRtkFacts({ bin: process.env.RTK_BIN })
    const fresh = precheck(buffer.toString('utf8'), facts, { key, owner, repo, repoFacts: null, rtkBin: process.env.RTK_BIN, reserved: loadReserved(ROOT) })
    if (fresh.tier === 'refused') errors.push(`${where}: precheck now refuses: ${fresh.refusals.map((r) => r.code + (r.detail ? `(${r.detail})` : '')).join(', ')}`)
    else if (fresh.tier !== report.tier) errors.push(`${where}: tier drifted ${report.tier} -> ${fresh.tier} (regenerate report.json)`)
    else console.log(`${where}: ok (${fresh.tier}/${fresh.label}, rtk ${facts.version})`)
  }

  if (errors.length) { for (const e of errors) console.error(`✖ ${e}`); process.exit(1) }
  console.log(`validate-pr: ${touched.size} snapshot(s) valid${revokedTouched ? ', revoked.toml valid' : ''}`)
}

main().catch((e) => { console.error(`validate-pr: ${e.stack ?? e}`); process.exit(1) })
