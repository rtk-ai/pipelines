#!/usr/bin/env node
// After a push to main touching approved/** or revoked.toml:
//  - for each new entry: create a Discussion, record approved_at/approved_by/
//    discussion_url in state/approvals.json (on the `state` branch worktree),
//    post to Discord
//  - for new revocations: comment on the pipeline's Discussion, post to Discord
//  - repository_dispatch `pipelines-updated` to rtk-ai/rtk-ldp
//
// env: GH_TOKEN, REPO, BEFORE, AFTER (push range), ACTOR, PUSHED_AT,
//      STATE_DIR, DISCORD_WEBHOOK_URL, LDP_DISPATCH_TOKEN, LDP_REPO (default rtk-ai/rtk-ldp), DRY_RUN

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { graphql, rest, postDiscord } from './lib/github.mjs'
import { parseApprovedPath, installLine } from './lib/ids.mjs'
import { loadRevoked } from './lib/policy.mjs'
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

async function main() {
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
  await dispatchSite()
}

main().catch((e) => { console.error(`on-merge: ${e.stack ?? e}`); process.exit(1) })
