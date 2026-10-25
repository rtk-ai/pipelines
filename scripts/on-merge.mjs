#!/usr/bin/env node
// After a push to main touching approved/** or revoked.toml:
//  - for each new entry: create a Discussion, record approved_at/approved_by/
//    discussion_url in state/approvals.json (on the `state` branch worktree),
//    post to Discord
//  - for new revocations: comment on the pipeline's Discussion, post to Discord
//  - open candidate PRs that duplicate what is now listed get the `duplicate` label
//  - repository_dispatch `pipelines-updated` to rtk-ai/rtk-ldp
//  ONLY_DEDUPE=1 runs just the duplicate pass (by hand, any time).
//
// env: GH_TOKEN, REPO, BEFORE, AFTER (push range), ACTOR, PUSHED_AT,
//      STATE_DIR, DISCORD_WEBHOOK_URL, LDP_DISPATCH_TOKEN, LDP_REPO (default rtk-ai/rtk-ldp), DRY_RUN

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { graphql, rest, postDiscord, fetchRaw } from './lib/github.mjs'
import { parseApprovedPath, installLine } from './lib/ids.mjs'
import { loadRevoked, listApproved } from './lib/policy.mjs'
import { approvedFingerprints, findDuplicate, contentFingerprint, pairOpenDuplicates, DUPLICATE_LABEL, duplicateNote } from './lib/dedupe.mjs'
import { parseEntry } from './lib/entry.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.REPO || 'rtk-ai/pipelines'
const LDP = process.env.LDP_REPO || 'rtk-ai/rtk-ldp'
const STATE_DIR = process.env.STATE_DIR || join(ROOT, '.state')
const APPROVALS = join(STATE_DIR, 'state', 'approvals.json')
const DRY = process.env.DRY_RUN === '1'
const SITE = 'https://www.rtk-ai.app/pipelines'

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() }

function readJson(p, fb) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb } catch { return fb } }

async function createDiscussion(entry) {
  const [owner, name] = REPO.split('/')
  const q = await graphql(`query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id discussionCategories(first:25){ nodes{ id name } } } }`, { o: owner, n: name })
  const cat = q.repository.discussionCategories.nodes.find((c) => c.name === 'Pipelines') ?? q.repository.discussionCategories.nodes[0]
  if (!cat) throw new Error('no discussion category; enable Discussions and create a "Pipelines" category')
  const page = `${SITE}/${entry.owner}/${entry.repo}/`
  const body = [
    `**${entry.name}** by @${entry.owner} — reviewed at \`${entry.sha.slice(0, 7)}\` (tier: ${entry.tier}).`,
    '', `Page: ${page}`, '', 'Install the reviewed commit:', '```', installLine(entry.owner, entry.repo, entry.sha), '```',
    '', 'Try it silently first with `--shadow`, then `rtk pipeline eval <name>` after a few sessions.',
    '', '**Share your measurements here** — numbers from `rtk pipeline eval` or `rtk gain --by-rule`, with your agent and model. RTK does not endorse author-reported figures.',
  ].join('\n')
  if (DRY) { console.log(`[dry-run] would create discussion "${entry.owner}/${entry.repo}"`); return 'https://github.com/rtk-ai/pipelines/discussions/0' }
  const m = await graphql(`mutation($r:ID!,$c:ID!,$t:String!,$b:String!){ createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){ discussion{ url id } } }`, { r: q.repository.id, c: cat.id, t: `${entry.owner}/${entry.repo}`, b: body })
  return m.createDiscussion.discussion.url
}

async function commentDiscussion(url, body) {
  const m = String(url).match(/\/discussions\/(\d+)$/)
  if (!m || DRY) return
  const [owner, name] = REPO.split('/')
  const q = await graphql(`query($o:String!,$n:String!,$num:Int!){ repository(owner:$o,name:$n){ discussion(number:$num){ id } } }`, { o: owner, n: name, num: Number(m[1]) })
  await graphql(`mutation($d:ID!,$b:String!){ addDiscussionComment(input:{discussionId:$d,body:$b}){ comment{ id } } }`, { d: q.repository.discussion.id, b: body })
}

async function dispatchSite() {
  const tok = process.env.LDP_DISPATCH_TOKEN
  if (!tok) { console.warn('LDP_DISPATCH_TOKEN missing: site not redeployed'); return }
  if (DRY) { console.log(`[dry-run] would dispatch pipelines-updated to ${LDP}`); return }
  const res = await fetch(`https://api.github.com/repos/${LDP}/dispatches`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rtk-pipelines-bot', 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'pipelines-updated', client_payload: { repo: REPO, after: process.env.AFTER ?? null } }) })
  if (!res.ok) throw new Error(`dispatch -> ${res.status}`)
}

/**
 * Duplicate pass over the open candidates: against what is listed first, then
 * against each other (the later PR is the duplicate of the earlier one). Runs
 * after every crawl and every listing merge; ONLY_DEDUPE=1 runs it by hand.
 */
async function labelDuplicateCandidates() {
  const fpMap = approvedFingerprints(listApproved(ROOT))
  let prs = []
  try { prs = await rest('GET', `/repos/${REPO}/pulls?state=open&per_page=100`) } catch (e) { console.error(`pull list: ${e.message}`); return }
  const items = []
  for (const pr of prs ?? []) {
    const names = (pr.labels ?? []).map((l) => l.name)
    if (!names.includes('candidate')) continue
    let files = []
    try { files = await rest('GET', `/repos/${REPO}/pulls/${pr.number}/files?per_page=100`) } catch { continue }
    const f = (files ?? []).find((x) => x.status === 'added' && /^approved\/[^/]+\/[^/]+\/[0-9a-f]{40}\/pipeline\.toml$/.test(x.filename))
    if (!f?.raw_url) continue
    let blob = null
    try { blob = await fetchRaw(f.raw_url) } catch { continue }
    if (!blob?.text) continue
    const [, owner, repo] = f.filename.split('/')
    items.push({ number: pr.number, owner, repo, toml: blob.text, fp: contentFingerprint(blob.text), labelled: names.includes(DUPLICATE_LABEL) })
  }
  const verdicts = new Map()
  for (const it of items) {
    const dup = findDuplicate(fpMap, it.toml, it.owner, it.repo)
    if (dup) verdicts.set(it.number, `${duplicateNote(dup)}, which is listed`)
  }
  for (const p of pairOpenDuplicates(items.filter((it) => !verdicts.has(it.number)))) {
    verdicts.set(p.number, `identical pipeline.toml (ignoring comments, formatting and the name) to the earlier open review #${p.of.number} (\`${p.of.owner}/${p.of.repo}\`)`)
  }
  for (const it of items) {
    const why = verdicts.get(it.number)
    if (!why) { console.log(`#${it.number}: no duplicate`); continue }
    if (it.labelled) { console.log(`#${it.number}: already labelled`); continue }
    if (DRY) { console.log(`[dry-run] would label #${it.number}: ${why}`); continue }
    try {
      await rest('POST', `/repos/${REPO}/issues/${it.number}/labels`, { labels: [DUPLICATE_LABEL] })
      await rest('POST', `/repos/${REPO}/issues/${it.number}/comments`, { body: `Duplicate: ${why}.` })
      console.log(`labelled #${it.number}: ${why}`)
    } catch (e) { console.error(`label #${it.number}: ${e.message}`) }
  }
}

async function main() {
  if (process.env.ONLY_DEDUPE === '1') { await labelDuplicateCandidates(); return }
  const before = process.env.BEFORE, after = process.env.AFTER || 'HEAD'
  const range = before && !/^0+$/.test(before) ? `${before}..${after}` : `${after}~1..${after}`
  const files = git(['diff', '--name-status', range]).split('\n').filter(Boolean).map((l) => { const [s, ...r] = l.split('\t'); return { status: s[0], path: r[r.length - 1] } })
  const approvals = readJson(APPROVALS, {})
  const actor = process.env.ACTOR || 'unknown'
  const at = process.env.PUSHED_AT || new Date().toISOString()
  let changed = false

  for (const f of files) {
    if (f.status !== 'A') continue
    const p = parseApprovedPath(f.path)
    if (!p || p.file !== 'entry.toml') continue
    const entry = parseEntry(readFileSync(join(ROOT, f.path), 'utf8'))
    const key = `${entry.owner}/${entry.repo}@${entry.sha}`
    if (approvals[key]?.discussion_url) continue
    const prNum = (git(['log', '-1', '--format=%s', '--', f.path]).match(/\(#(\d+)\)/) ?? [])[1] ?? entry.pr ?? null
    let discussion_url = approvals[`${entry.owner}/${entry.repo}`]?.discussion_url ?? null
    try { if (!discussion_url) discussion_url = await createDiscussion(entry) } catch (e) { console.error(`discussion for ${key}: ${e.message}`) }
    approvals[key] = { approved_at: at, approved_by: actor, discussion_url, pr: prNum ? Number(prNum) : null }
    approvals[`${entry.owner}/${entry.repo}`] = { discussion_url }
    changed = true
    const page = `${SITE}/${entry.owner}/${entry.repo}/`
    await postDiscord(process.env.DISCORD_WEBHOOK_URL, [`**New reviewed RTK pipeline: ${entry.name}** by ${entry.owner} (tier: ${entry.tier})`, page, '```', installLine(entry.owner, entry.repo, entry.sha), '```'].join('\n'))
    console.log(`approved ${key} by ${actor}; discussion ${discussion_url}`)
  }

  if (files.some((f) => f.path === 'revoked.toml')) {
    const now = loadRevoked(ROOT)
    let prev = []
    try { prev = (await import('smol-toml')).parse(git(['show', `${before}:revoked.toml`])).revoked ?? [] } catch { prev = [] }
    const prevKeys = new Set(prev.map((r) => `${r.owner}/${r.repo}@${r.sha ?? '*'}`))
    for (const r of now) {
      const k = `${r.owner}/${r.repo}@${r.sha}`
      if (prevKeys.has(k)) continue
      const msg = `**Revoked**: ${r.owner}/${r.repo} (${r.sha === '*' ? 'all reviewed commits' : r.sha.slice(0, 7)}) — ${r.reason}. It is no longer listed on ${SITE}/. If you installed it, run \`rtk pipeline promote <name> --discard\` or remove it from \`~/.config/rtk/pipelines/\`.`
      const url = approvals[`${r.owner}/${r.repo}`]?.discussion_url
      if (url) { try { await commentDiscussion(url, msg) } catch (e) { console.error(`discussion comment: ${e.message}`) } }
      await postDiscord(process.env.DISCORD_WEBHOOK_URL, msg)
      console.log(`revoked ${k}`)
    }
  }

  if (changed) {
    mkdirSync(dirname(APPROVALS), { recursive: true })
    writeFileSync(APPROVALS, JSON.stringify(approvals, null, 2) + '\n')
  }
  if (files.some((f) => f.status === 'A' && f.path.startsWith('approved/'))) await labelDuplicateCandidates()
  await dispatchSite()
}

main().catch((e) => { console.error(`on-merge: ${e.stack ?? e}`); process.exit(1) })
