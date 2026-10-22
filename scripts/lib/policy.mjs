// Repo-level policy files: reserved names, blocklist, revocations, approvals.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parseApprovedPath, SHA_RE } from './ids.mjs'

export function readToml(path, fallback = {}) {
  if (!existsSync(path)) return fallback
  return parseToml(readFileSync(path, 'utf8'))
}

export function loadReserved(root) {
  const t = readToml(join(root, 'reserved.toml'), {})
  return { names: Array.isArray(t.names) ? t.names.map(String) : [], patterns: Array.isArray(t.patterns) ? t.patterns.map(String) : [] }
}

export function loadBlocklist(root) {
  const t = readToml(join(root, 'blocklist.toml'), {})
  return new Set((Array.isArray(t.owner) ? t.owner : []).map((o) => String(o.login ?? '').toLowerCase()).filter(Boolean))
}

export function loadRevoked(root) {
  const t = readToml(join(root, 'revoked.toml'), {})
  return (Array.isArray(t.revoked) ? t.revoked : []).map((r) => ({
    owner: String(r.owner ?? ''), repo: String(r.repo ?? ''), sha: String(r.sha ?? '*'),
    reason: String(r.reason ?? ''), date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date ?? ''),
  }))
}

export function validateRevoked(list) {
  const errors = []
  list.forEach((r, i) => {
    if (!r.owner) errors.push(`revoked[${i}]: owner missing`)
    if (!r.repo) errors.push(`revoked[${i}]: repo missing`)
    if (r.sha !== '*' && !SHA_RE.test(r.sha)) errors.push(`revoked[${i}]: sha must be 40 hex or "*"`)
    if (!r.reason) errors.push(`revoked[${i}]: reason missing`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push(`revoked[${i}]: date must be YYYY-MM-DD`)
  })
  return errors
}

export function isRevoked(revoked, owner, repo, sha) {
  return revoked.some((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase() && (r.sha === '*' || r.sha === sha))
}

/** Every approved/<owner>/<repo>/<sha>/ directory that has the three files. */
export function listApproved(root) {
  const base = join(root, 'approved')
  const out = []
  if (!existsSync(base)) return out
  for (const owner of readdirSync(base)) {
    const od = join(base, owner)
    if (!statSync(od).isDirectory()) continue
    for (const repo of readdirSync(od)) {
      const rd = join(od, repo)
      if (!statSync(rd).isDirectory()) continue
      for (const sha of readdirSync(rd)) {
        const dir = join(rd, sha)
        if (!statSync(dir).isDirectory()) continue
        const parsed = parseApprovedPath(`approved/${owner}/${repo}/${sha}/entry.toml`)
        if (!parsed) continue
        if (!existsSync(join(dir, 'pipeline.toml')) || !existsSync(join(dir, 'entry.toml')) || !existsSync(join(dir, 'report.json'))) continue
        out.push({ owner, repo, sha, dir })
      }
    }
  }
  return out
}

export function readSeen(path) {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}
