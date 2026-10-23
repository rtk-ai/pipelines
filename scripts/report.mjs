#!/usr/bin/env node
// Renders the review PR body (markdown) from a report.json. Everything the
// author controls sits inside fences sized to the content (lib/fence.mjs);
// identifiers were validated before they reached the report.
//
//   node scripts/report.mjs report.json [--diff-old approved.toml --diff-new candidate.toml] [--upstream-url URL]

import { readFileSync } from 'node:fs'
import { fenced, cell } from './lib/fence.mjs'
import { OWNER_RE, REPO_RE, SHA_RE } from './lib/ids.mjs'
import { renderNumbersSection } from './lib/benchmark.mjs'

function lineDiff(oldText, newText) {
  // Minimal LCS line diff; good enough for human review of small TOML files.
  const a = oldText.split('\n'), b = newText.split('\n')
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); i++ }
    else { out.push('+' + b[j]); j++ }
  }
  while (i < n) out.push('-' + a[i++])
  while (j < m) out.push('+' + b[j++])
  return out.join('\n')
}

function age(iso) {
  if (!iso) return 'unknown'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 30) return `${days} days`
  if (days < 365) return `${Math.floor(days / 30)} months`
  return `${(days / 365).toFixed(1)} years`
}

export function renderBody(report, opts = {}) {
  const [ownerRepo, sha] = String(report.key).split('@')
  const [owner, repo] = ownerRepo.split('/')
  const safeIds = OWNER_RE.test(owner) && REPO_RE.test(repo) && SHA_RE.test(sha)
  const sha7 = safeIds ? sha.slice(0, 7) : '???????'
  const repoFacts = report.repo ?? {}
  const L = []

  L.push(`## ${opts.update ? 'Update' : 'Review'}: ${safeIds ? `\`${owner}/${repo}\` @ \`${sha7}\`` : '(invalid identifiers)'}`)
  L.push('')
  L.push(`**tier:** \`${report.tier}\` · **label:** \`${report.label}\` · **size:** ${report.size_bytes} bytes · **rtk:** ${report.rtk} · **text:** ${report.text_blocks.length} block(s), ${report.text_chars ?? 0} chars`)
  L.push(`**owner account age:** ${age(repoFacts.owner_created_at)} · **stars:** ${repoFacts.stars ?? '?'} · **forks:** ${repoFacts.forks ?? '?'}${repoFacts.parent ? ` · **fork of:** \`${String(repoFacts.parent).replace(/[^A-Za-z0-9_./-]/g, '')}\`` : ''}`)
  if (report.refusals?.length) {
    L.push('')
    L.push('> **Refused by the bot** — this PR should not exist; close it.')
    for (const r of report.refusals) L.push(`> - \`${r.code}\`${r.detail ? `: ${cell(r.detail)}` : ''}`)
  }
  if (safeIds) {
    L.push('')
    L.push(`Upstream file: https://github.com/${owner}/${repo}/blob/${sha}/pipeline.toml · README: https://github.com/${owner}/${repo}/blob/${sha}/README.md (not inlined, open it on GitHub)`)
  }
  if (repoFacts.description) {
    L.push('')
    L.push('Repo description (author text):')
    L.push(fenced(String(repoFacts.description).slice(0, 300), 'text'))
  }

  L.push(...renderNumbersSection(report, cell))

  L.push('')
  L.push("### rtk's own disclosure (`rtk pipeline add --shadow`, verbatim)")
  L.push('')
  L.push(`exit code: \`${report.add_exit_code}\``)
  L.push(fenced((report.add_stdout || '(no output)') + (report.add_stderr ? `\n--- stderr ---\n${report.add_stderr}` : ''), 'text'))

  if (report.text_blocks.length) {
    L.push('')
    L.push('### Text this pipeline puts in front of a model or your agent — read every line')
    for (const b of report.text_blocks) {
      L.push('')
      L.push(`**${b.kind}** on \`${String(b.owner).replace(/[^A-Za-z0-9_.:\[\]-]/g, '?')}\` — ${b.chars} chars`)
      L.push(fenced(b.text, 'text'))
    }
  }

  L.push('')
  L.push('### Egress')
  if (report.egress.length === 0) L.push('No upstreams: nothing leaves the machine.')
  else {
    L.push('')
    L.push('| upstream | provider | model | host | local | api_key_env | canonical | flags |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const e of report.egress) {
      const flags = [e.custom && '**custom base_url**', e.noncanonical_env && '**non-canonical env**', e.api_key_command && '**api_key_command**', e.unknown_keys?.length && `unknown keys: ${e.unknown_keys.join(',')}`].filter(Boolean).join(', ')
      L.push(`| ${cell(e.name)} | ${cell(e.provider)} | ${cell(e.model)} | ${cell(e.base_url ?? '(provider default)')} | ${e.local ? 'yes' : 'no'} | ${cell(e.api_key_env ?? (e.canonical_env ? `${e.canonical_env} (default)` : null))} | ${cell(e.canonical_env)} | ${flags || '—'} |`)
    }
  }

  L.push('')
  L.push('### Overrides of built-in rules')
  if (!report.overrides?.length) L.push('None.')
  else for (const o of report.overrides) L.push(`- ${cell(o.target)} (${o.target_kind ?? 'unknown target'}${o.target_builtin ? ` in ${o.target_builtin}` : ''}${o.target_action ? `, action=${o.target_action}` : ''}) sets ${o.keys.map(cell).join(', ')}${o.touches_control ? ' — **touches a control rule**' : ''}`)

  L.push('')
  L.push('### Control rules')
  const c = report.control_rules ?? {}
  L.push(`deny ${c.deny ?? 0} · route ${c.route ?? 0} · rewrite ${c.rewrite ?? 0} · passthrough ${c.passthrough ?? 0} · extends: ${report.extends?.length ? report.extends.map(cell).join(', ') : 'none'}`)
  if (report.rule_summary?.length) {
    L.push('')
    for (const r of report.rule_summary) L.push(`- **${r.position}** — ${cell(r.does)}${r.when ? ` when ${cell(r.when)}` : ''}`)
  }
  const extras = []
  if (report.plugins_missing?.length) extras.push(`plugins missing: ${report.plugins_missing.map(cell).join(', ')}`)
  if (report.reserved_methods?.length) extras.push(`reserved method names: ${report.reserved_methods.map(cell).join(', ')}`)
  if (report.unknown_positions?.length) extras.push(`unknown positions: ${report.unknown_positions.map(cell).join(', ')}`)
  if (report.hidden_unicode?.length) extras.push(`hidden unicode: ${report.hidden_unicode.map((h) => `${h.codepoint}@L${h.line}`).join(' ')}`)
  for (const w of report.warnings ?? []) extras.push(`warning: ${cell(w)}`)
  for (const w of report.author_numbers_notes ?? []) extras.push(`author numbers: ${cell(w)}`)
  if (extras.length) { L.push(''); L.push('### Bot notes'); for (const x of extras) L.push(`- ${x}`) }

  if (opts.diff) {
    L.push('')
    L.push(`### Changes vs the approved snapshot (${opts.diff.oldSha7} → ${sha7})`)
    L.push(fenced(lineDiff(opts.diff.oldText, opts.diff.newText), 'diff'))
  }

  L.push('')
  L.push('---')
  L.push('Merging this PR lists the pipeline on https://www.rtk-ai.app/pipelines/ pinned to this commit. Tick the checklist in the PR template before approving.')
  return L.join('\n')
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const report = JSON.parse(readFileSync(file, 'utf8'))
  let diff
  if (opt('--diff-old') && opt('--diff-new')) diff = { oldText: readFileSync(opt('--diff-old'), 'utf8'), newText: readFileSync(opt('--diff-new'), 'utf8'), oldSha7: opt('--old-sha7') ?? 'old' }
  process.stdout.write(renderBody(report, { diff, update: Boolean(diff) }) + '\n')
}
