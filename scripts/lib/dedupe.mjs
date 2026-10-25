/**
 * dedupe.mjs — "is this pipeline already listed under another name?"
 *
 * Two pipeline.toml files are duplicates when they mean the same thing:
 * comments, formatting, key order and the `[pipeline] name` do not count.
 * A new commit of an already-listed repo is an update, never a duplicate.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { sha256 } from './analyze.mjs'

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v instanceof Date) return JSON.stringify(v.toISOString())
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** Fingerprint of what a pipeline.toml means; null when it does not parse. */
export function contentFingerprint(toml) {
  let doc
  try { doc = parseToml(toml) } catch { return null }
  if (doc && typeof doc === 'object' && doc.pipeline && typeof doc.pipeline === 'object') {
    doc = { ...doc, pipeline: { ...doc.pipeline } }
    delete doc.pipeline.name
  }
  return sha256(stable(doc))
}

/** fingerprint -> [{ owner, repo, sha }] for every approved snapshot (listApproved output). */
export function approvedFingerprints(approved) {
  const out = new Map()
  for (const a of approved) {
    let fp = null
    try { fp = contentFingerprint(readFileSync(join(a.dir, 'pipeline.toml'), 'utf8')) } catch { fp = null }
    if (!fp) continue
    if (!out.has(fp)) out.set(fp, [])
    out.get(fp).push({ owner: a.owner, repo: a.repo, sha: a.sha })
  }
  return out
}

/** The listed pipeline this candidate duplicates, or null. Same owner/repo is an update, not a duplicate. */
export function findDuplicate(fpMap, toml, owner, repo) {
  const fp = contentFingerprint(toml)
  if (!fp) return null
  const self = `${owner}/${repo}`.toLowerCase()
  return (fpMap.get(fp) ?? []).find((h) => `${h.owner}/${h.repo}`.toLowerCase() !== self) ?? null
}

export const DUPLICATE_LABEL = 'duplicate'

export function duplicateNote(d) {
  return `identical pipeline.toml (ignoring comments, formatting and the name) to the listed \`${d.owner}/${d.repo}\` @ \`${String(d.sha).slice(0, 7)}\``
}

/**
 * Among open candidates (oldest first: [{ number, owner, repo, fp }]), the later
 * ones whose fingerprint equals an earlier one from another repo.
 * Returns [{ number, of: { number, owner, repo } }].
 */
export function pairOpenDuplicates(items) {
  const seen = []
  const out = []
  for (const it of [...items].sort((a, b) => a.number - b.number)) {
    if (!it.fp) continue
    const self = `${it.owner}/${it.repo}`.toLowerCase()
    const earlier = seen.find((e) => e.fp === it.fp && `${e.owner}/${e.repo}`.toLowerCase() !== self)
    if (earlier) out.push({ number: it.number, of: { number: earlier.number, owner: earlier.owner, repo: earlier.repo } })
    else seen.push(it)
  }
  return out
}
