// entry.toml and report.json: writers and schema checks.

import { stringify as stringifyToml, parse as parseToml } from 'smol-toml'
import { OWNER_RE, REPO_RE, SHA_RE } from './ids.mjs'

const TIERS = ['safe', 'structural', 'text']

export function entryToml(e) {
  const out = {
    owner: e.owner, repo: e.repo, sha: e.sha, name: e.name, tier: e.tier,
    source: e.source ?? 'github', rtk: e.rtk, pr: e.pr ?? 0, submitted_at: e.submitted_at,
  }
  if (e.gist_id) out.gist_id = e.gist_id
  if (e.gist_file) out.gist_file = e.gist_file
  return stringifyToml(out) + '\n'
}

export function parseEntry(text) {
  return parseToml(text)
}

export function validateEntry(e, where) {
  const errors = []
  const need = (k, ok) => { if (!ok) errors.push(`${where}: ${k} invalid`) }
  need('owner', OWNER_RE.test(e.owner ?? ''))
  need('repo', REPO_RE.test(e.repo ?? ''))
  need('sha', SHA_RE.test(e.sha ?? ''))
  need('name', /^[A-Za-z0-9_-]+$/.test(e.name ?? ''))
  need('tier', TIERS.includes(e.tier))
  need('source', ['github', 'gist'].includes(e.source))
  need('rtk', /^v\d+\.\d+\.\d+/.test(e.rtk ?? ''))
  if (e.source === 'gist') need('gist_id', /^[0-9a-f]{20,40}$/.test(e.gist_id ?? ''))
  return errors
}

export function validateReport(r, where, expect = {}) {
  const errors = []
  const need = (k, ok) => { if (!ok) errors.push(`${where}: report.${k} invalid`) }
  need('rtk', typeof r.rtk === 'string')
  need('key', typeof r.key === 'string')
  need('tier', ['safe', 'structural', 'text', 'refused'].includes(r.tier))
  need('label', ['pre-checked', 'needs-reading', 'refused'].includes(r.label))
  need('refusals', Array.isArray(r.refusals))
  need('text_blocks', Array.isArray(r.text_blocks))
  need('egress', Array.isArray(r.egress))
  need('rules', Array.isArray(r.rules))
  need('control_rules', r.control_rules && typeof r.control_rules === 'object')
  if (expect.requireRtk !== false) need('add_exit_code', Number.isInteger(r.add_exit_code))
  need('toml_sha256', /^[0-9a-f]{64}$/.test(r.toml_sha256 ?? ''))
  if (expect.key) need('key(match)', r.key === expect.key)
  if (expect.tomlSha) need('toml_sha256(match)', r.toml_sha256 === expect.tomlSha)
  return errors
}
