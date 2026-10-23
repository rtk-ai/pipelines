#!/usr/bin/env node
// Crawl: every public repo with topic `rtk-pipeline` (forks included) plus gist
// submissions from issues labelled `submit-gist`; pre-check each new
// <owner>/<repo>@<sha>; auto-reject hard fails into state/seen.json; open one
// review PR per acceptable candidate. A maintainer merging that PR is the
// only way a pipeline gets listed.
//
// env: GH_TOKEN (bot), RTK_BIN (pinned rtk), REPO (default rtk-ai/pipelines),
//      STATE_DIR (worktree of the `state` branch, default .state),
//      DRY_RUN=1 (no git, no PRs, no issue comments), MAX_PRS (default 10)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { graphql, rest, fetchRaw } from './lib/github.mjs'
import { assertOwner, assertRepo, assertSha, approvedDir, reviewBranch, short, rawUrl, benchmarkRawUrl, readmeRawUrl, GIST_ID_RE } from './lib/ids.mjs'
import { parseBenchmarkToml, parseShareCard, BENCH_MAX_BYTES } from './lib/benchmark.mjs'
import { loadBlocklist, loadReserved, loadRevoked, listApproved, readSeen, isRevoked } from './lib/policy.mjs'
import { entryToml } from './lib/entry.mjs'
import { precheck, loadRtkFacts } from './precheck.mjs'
import { renderBody } from './report.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.REPO || 'rtk-ai/pipelines'
const STATE_DIR = process.env.STATE_DIR || join(ROOT, '.state')
const SEEN_PATH = join(STATE_DIR, 'state', 'seen.json')
const DRY = process.env.DRY_RUN === '1'
const MAX_PRS = Number(process.env.MAX_PRS || 10)
const SITE = 'https://www.rtk-ai.app/pipelines/'

const SEARCH = `query($q:String!,$after:String){ search(query:$q,type:REPOSITORY,first:100,after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{ ... on Repository{ nameWithOwner isArchived isFork isPrivate description stargazerCount forkCount pushedAt createdAt
    parent{nameWithOwner} owner{login ... on User{createdAt} ... on Organization{createdAt}}
    defaultBranchRef{name target{oid}} object(expression:"HEAD:pipeline.toml"){ ... on Blob{byteSize isBinary} } } } } }`

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}
function gh(args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_REPO: REPO } }).trim()
}

async function searchTopic() {
  const nodes = []
  let after = null
  do {
    const data = await graphql(SEARCH, { q: 'topic:rtk-pipeline fork:true archived:false', after })
    nodes.push(...data.search.nodes.filter(Boolean))
    after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
  } while (after)
  return nodes
}

async function gistSubmissions() {
  let issues
  try {
    issues = await rest("GET", `/repos/${REPO}/issues?labels=submit-gist&state=open&per_page=100`)
  } catch (e) {
    if (DRY) { console.warn(`gist submissions skipped: ${e.message}`); return [] }
    throw e
  }
  const out = []
  for (const issue of issues) {
    if (issue.pull_request) continue
    const m = String(issue.body ?? '').match(/https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{20,40})/)
    if (!m) { out.push({ issue, error: 'no gist URL found in the issue body' }); continue }
    try {
      const gist = await rest('GET', `/gists/${m[2]}`)
      const files = Object.values(gist.files ?? {})
      const file = files.find((f) => f.filename === 'pipeline.toml') ?? (files.filter((f) => f.filename.endsWith('.toml')).length === 1 ? files.find((f) => f.filename.endsWith('.toml')) : null)
      if (!file) { out.push({ issue, error: 'the gist has no pipeline.toml (or a single .toml file)' }); continue }
      const owner = gist.owner?.login
      if (!owner || owner.toLowerCase() !== String(issue.user?.login ?? '').toLowerCase()) { out.push({ issue, error: 'the gist is not owned by the issue author' }); continue }
      const rev = gist.history?.[0]?.version
      out.push({ issue, gist, owner, gistId: gist.id, rev, file, rawUrl: `https://gist.githubusercontent.com/${owner}/${gist.id}/raw/${rev}/${encodeURIComponent(file.filename)}` })
    } catch (e) {
      out.push({ issue, error: `could not read the gist: ${e.message}` })
    }
  }
  return out
}

function openCandidatePRs() {
  try {
    const json = gh(['pr', 'list', '--state', 'open', '--label', 'candidate', '--limit', '200', '--json', 'number,headRefName'])
    return JSON.parse(json)
  } catch (e) {
    if (DRY) return []
    throw e
  }
}

function writeSnapshot(dir, { buffer, entry, report, benchmarkBuffer }) {
  const base = DRY ? join(ROOT, ".sandbox") : ROOT
  mkdirSync(join(base, dir), { recursive: true })
  writeFileSync(join(base, dir, "pipeline.toml"), buffer)
  if (benchmarkBuffer) writeFileSync(join(base, dir, "benchmark.toml"), benchmarkBuffer)
  writeFileSync(join(base, dir, "entry.toml"), entryToml(entry))
  writeFileSync(join(base, dir, "report.json"), JSON.stringify(report, null, 2) + "\n")
}

/**
 * Numbers the author publishes next to the pipeline: an optional benchmark.toml
 * (A/B cost + quality) and the rtk-generated share card in README.md. Both are
 * read at the same commit as pipeline.toml. Invalid = ignored with a note for
 * the maintainer; never a refusal, the pipeline itself is unaffected.
 */
async function fetchExtras({ owner, repo, sha }) {
  const out = { benchmark: null, benchmarkBuffer: null, selfReported: null, notes: [] }
  try {
    const b = await fetchRaw(benchmarkRawUrl(owner, repo, sha), BENCH_MAX_BYTES)
    if (b?.too_large) out.notes.push(`benchmark.toml is ${b.bytes} bytes (> ${BENCH_MAX_BYTES}); ignored`)
    else if (b) {
      const r = parseBenchmarkToml(b.text)
      out.notes.push(...r.errors.map((e) => `benchmark.toml ignored: ${e}`), ...r.warnings.map((w) => `benchmark.toml: ${w}`))
      if (r.benchmark) { out.benchmark = r.benchmark; out.benchmarkBuffer = b.buffer }
    }
  } catch (e) { out.notes.push(`benchmark.toml: fetch failed (${e.message})`) }
  try {
    const r = await fetchRaw(readmeRawUrl(owner, repo, sha), 128 * 1024)
    if (r?.text) out.selfReported = parseShareCard(r.text)
  } catch (e) { out.notes.push(`README.md: fetch failed (${e.message})`) }
  return out
}

function openPR({ branch, dir, title, body, labels }) {
  const bodyFile = join(ROOT, '.sandbox', `${branch.replace(/\//g, '__')}.md`)
  mkdirSync(dirname(bodyFile), { recursive: true })
  writeFileSync(bodyFile, body)
  if (DRY) { console.log(`[dry-run] would open PR "${title}" from ${branch} with labels ${labels.join(',')} (body: ${bodyFile})`); return null }
  git(['checkout', '-q', '-B', branch, 'origin/main'])
  git(['add', '--', dir])
  git(['-c', 'user.name=rtk-pipelines-bot', '-c', 'user.email=bot@rtk-ai.app', 'commit', '-q', '-m', title])
  git(['push', '-q', '-u', 'origin', `${branch}:${branch}`, '--force-with-lease'])
  const url = gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile, ...labels.flatMap((l) => ['--label', l])])
  git(['checkout', '-q', 'main'])
  return url
}

async function main() {
  if (!process.env.RTK_BIN) throw new Error('RTK_BIN is required (scripts/rtk-pinned.sh prints it)')
  const facts = loadRtkFacts({ bin: process.env.RTK_BIN })
  const blocklist = loadBlocklist(ROOT)
  const reserved = loadReserved(ROOT)
  const revoked = loadRevoked(ROOT)
  const approved = listApproved(ROOT)
  const approvedByRepo = new Map()
  for (const a of approved) {
    const k = `${a.owner}/${a.repo}`.toLowerCase()
    if (!approvedByRepo.has(k)) approvedByRepo.set(k, [])
    approvedByRepo.get(k).push(a)
  }
  const seen = readSeen(SEEN_PATH)
  const openPRs = openCandidatePRs()
  const openBranches = new Set(openPRs.map((p) => p.headRefName))
  const now = new Date().toISOString()
  const summary = { scanned: 0, skipped: 0, rejected: 0, prs: 0, errors: 0 }
  let prBudget = MAX_PRS

  const mark = (key, result, extra = {}) => { seen[key] = { result, at: now, ...extra } }

  const candidates = []
  for (const node of await searchTopic()) {
    summary.scanned++
    const [owner, repo] = node.nameWithOwner.split('/')
    try { assertOwner(owner); assertRepo(repo) } catch { continue }
    const sha = node.defaultBranchRef?.target?.oid
    if (!sha || node.isPrivate || node.isArchived) { summary.skipped++; continue }
    const key = `${owner}/${repo}@${sha}`
    if (seen[key]) { summary.skipped++; continue }
    if (blocklist.has(owner.toLowerCase())) { mark(key, 'blocklisted'); continue }
    if (!node.object) { mark(key, 'no-pipeline'); continue }
    if (node.object.isBinary || node.object.byteSize > 64 * 1024) { mark(key, 'rejected', { reason: node.object.isBinary ? 'binary pipeline.toml' : `pipeline.toml is ${node.object.byteSize} bytes (> 64 KB)` }); summary.rejected++; continue }
    if (isRevoked(revoked, owner, repo, sha)) { mark(key, 'revoked'); continue }
    candidates.push({
      source: 'github', owner, repo, sha, key, url: rawUrl(owner, repo, sha),
      repoFacts: {
        stars: node.stargazerCount, forks: node.forkCount, parent: node.parent?.nameWithOwner ?? null, is_fork: node.isFork,
        pushedAt: node.pushedAt, createdAt: node.createdAt, owner_created_at: node.owner?.createdAt ?? null,
        description: typeof node.description === 'string' ? node.description.slice(0, 300) : null, default_branch: node.defaultBranchRef?.name ?? null,
      },
    })
  }

  for (const g of await gistSubmissions()) {
    summary.scanned++
    if (g.error) {
      if (!DRY) await rest('POST', `/repos/${REPO}/issues/${g.issue.number}/comments`, { body: `Thanks — this submission could not be processed: ${g.error}. Edit the issue (or open a new one) once fixed.` })
      summary.errors++
      continue
    }
    const owner = g.owner, repo = `gist-${g.gistId}`, sha = g.rev
    try { assertOwner(owner); assertRepo(repo); assertSha(sha); if (!GIST_ID_RE.test(g.gistId)) throw new Error('gist id') } catch { continue }
    const key = `gist/${g.gistId}@${sha}`
    if (seen[key]) { summary.skipped++; continue }
    if (blocklist.has(owner.toLowerCase())) { mark(key, 'blocklisted'); continue }
    candidates.push({ source: 'gist', owner, repo, sha, key, url: g.rawUrl, gistId: g.gistId, gistFile: g.file.filename, issue: g.issue, repoFacts: { stars: 0, forks: 0, parent: null, owner_created_at: null, description: String(g.issue.title ?? '').slice(0, 300) } })
  }

  for (const c of candidates) {
    const approvedHere = approvedByRepo.get(`${c.owner}/${c.repo}`.toLowerCase()) ?? []
    if (approvedHere.some((a) => a.sha === c.sha)) { mark(c.key, 'approved'); continue }
    const isUpdate = approvedHere.length > 0
    const branch = reviewBranch(isUpdate ? 'update' : 'review', c.owner, c.repo, c.sha)
    if (openBranches.has(branch)) { summary.skipped++; continue }

    let blob
    try { blob = await fetchRaw(c.url) } catch (e) { mark(c.key, 'fetch-failed', { reason: e.message }); summary.errors++; continue }
    if (!blob) { mark(c.key, 'no-pipeline'); continue }
    if (blob.too_large) { mark(c.key, 'rejected', { reason: `pipeline.toml is ${blob.bytes} bytes (> 64 KB)` }); summary.rejected++; continue }

    const report = precheck(blob.text, facts, { key: c.key, owner: c.owner, repo: c.repo, repoFacts: c.repoFacts, rtkBin: process.env.RTK_BIN, reserved })
    if (report.tier === 'refused') {
      const reason = report.refusals.map((r) => r.code + (r.detail ? `: ${r.detail}` : '')).join('; ').slice(0, 500)
      mark(c.key, 'rejected', { reason })
      summary.rejected++
      console.log(`rejected ${c.key}: ${reason}`)
      if (c.issue && !DRY) {
        await rest('POST', `/repos/${REPO}/issues/${c.issue.number}/comments`, { body: `Pre-check refused this pipeline, so no review was opened:\n\n\`\`\`\n${reason.replace(/`/g, "'")}\n\`\`\`\n\nFix the file, publish a new revision and open a new submission.` })
        await rest('PATCH', `/repos/${REPO}/issues/${c.issue.number}`, { state: 'closed', state_reason: 'not_planned' })
      }
      continue
    }

    if (prBudget-- <= 0) { console.log(`PR budget exhausted; ${c.key} waits for the next run`); continue }
    const extras = c.source === 'github' ? await fetchExtras(c) : { benchmark: null, benchmarkBuffer: null, selfReported: null, notes: [] }
    report.benchmark = extras.benchmark
    report.self_reported = extras.selfReported
    report.author_numbers_notes = extras.notes
    const dir = approvedDir(c.owner, c.repo, c.sha)
    const entry = { owner: c.owner, repo: c.repo, sha: c.sha, name: report.name, tier: report.tier, source: c.source, rtk: facts.version, pr: 0, submitted_at: now, gist_id: c.gistId, gist_file: c.gistFile }
    let diff
    if (isUpdate) {
      const latest = approvedHere.map((a) => ({ ...a, mtime: readFileSync(join(a.dir, 'entry.toml'), 'utf8').match(/submitted_at = "([^"]+)"/)?.[1] ?? '' })).sort((x, y) => y.mtime.localeCompare(x.mtime))[0]
      diff = { oldText: readFileSync(join(latest.dir, 'pipeline.toml'), 'utf8'), newText: blob.text, oldSha7: short(latest.sha) }
    }
    const title = isUpdate ? `update: ${c.owner}/${c.repo} ${diff.oldSha7} → ${short(c.sha)}` : `review: ${c.owner}/${c.repo} @ ${short(c.sha)}`
    const body = renderBody(report, { diff, update: isUpdate })
    const labels = ['candidate', report.label, ...(isUpdate ? ['update'] : []), ...(c.source === 'gist' ? ['gist'] : [])]
    writeSnapshot(dir, { buffer: blob.buffer, entry, report, benchmarkBuffer: extras.benchmarkBuffer })
    try {
      const url = openPR({ branch, dir, title, body, labels })
      mark(c.key, 'pr', { pr: url, label: report.label, tier: report.tier })
      summary.prs++
      console.log(`opened ${url ?? '(dry-run)'} for ${c.key} [${report.tier}/${report.label}]`)
      if (c.issue && url && !DRY) {
        await rest('POST', `/repos/${REPO}/issues/${c.issue.number}/comments`, { body: `Pre-check passed; review opened at ${url}. This issue is closed, the review PR is where it continues.` })
        await rest('PATCH', `/repos/${REPO}/issues/${c.issue.number}`, { state: 'closed', state_reason: 'completed' })
      }
    } catch (e) {
      summary.errors++
      console.error(`failed to open PR for ${c.key}: ${e.message}`)
      if (!DRY) { try { git(['checkout', '-q', '-f', 'main']) } catch { /* best effort */ } }
    }
  }

  mkdirSync(dirname(SEEN_PATH), { recursive: true })
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2) + '\n')
  console.log(`crawl done: ${JSON.stringify(summary)} → ${SEEN_PATH}`)
}

main().catch((e) => { console.error(`crawl: ${e.stack ?? e}`); process.exit(1) })
