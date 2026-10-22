#!/usr/bin/env node
// Re-run the pre-check over every approved snapshot with the current rtk.pin.
// Opens (or updates) one issue per entry that now fails; never auto-revokes.
// env: RTK_BIN, GH_TOKEN, REPO, DRY_RUN

import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rest } from './lib/github.mjs'
import { listApproved, loadReserved } from './lib/policy.mjs'
import { parseEntry } from './lib/entry.mjs'
import { precheck, loadRtkFacts } from './precheck.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.REPO || 'rtk-ai/pipelines'
const DRY = process.env.DRY_RUN === '1'

async function main() {
  if (!process.env.RTK_BIN) throw new Error('RTK_BIN is required')
  const facts = loadRtkFacts({ bin: process.env.RTK_BIN })
  const reserved = loadReserved(ROOT)
  let failures = 0
  for (const a of listApproved(ROOT)) {
    const entry = parseEntry(readFileSync(join(a.dir, 'entry.toml'), 'utf8'))
    const key = entry.source === 'gist' ? `gist/${entry.gist_id}@${a.sha}` : `${a.owner}/${a.repo}@${a.sha}`
    const r = precheck(readFileSync(join(a.dir, 'pipeline.toml'), 'utf8'), facts, { key, owner: a.owner, repo: a.repo, repoFacts: null, rtkBin: process.env.RTK_BIN, reserved })
    if (r.tier !== 'refused') { console.log(`ok ${key} (${r.tier})`); continue }
    failures++
    const title = `recheck: ${a.owner}/${a.repo} @ ${a.sha.slice(0, 7)} fails on rtk ${facts.version}`
    const body = [`The approved snapshot \`approved/${a.owner}/${a.repo}/${a.sha}/\` no longer passes the pre-check with rtk ${facts.version}:`, '', ...r.refusals.map((x) => `- \`${x.code}\`${x.detail ? `: ${String(x.detail).replace(/`/g, "'")}` : ''}`), '', `rtk exit code: ${r.add_exit_code}`, '', 'Decide: revoke (add to `revoked.toml`), wait for an author update, or keep.'].join('\n')
    console.log(`FAIL ${key}: ${r.refusals.map((x) => x.code).join(',')}`)
    if (DRY) continue
    const existing = await rest('GET', `/repos/${REPO}/issues?labels=recheck&state=open&per_page=100`)
    if (existing.some((i) => i.title === title)) continue
    await rest('POST', `/repos/${REPO}/issues`, { title, body, labels: ['recheck'] })
  }
  console.log(`recheck done: ${failures} failing`)
}

main().catch((e) => { console.error(`recheck: ${e.stack ?? e}`); process.exit(1) })
