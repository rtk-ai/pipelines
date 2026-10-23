// Identifier validation. Every owner/repo/sha that reaches a path, a branch
// name, a URL or a shell argument goes through these first.

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/
export const SHA_RE = /^[0-9a-f]{40}$/
export const GIST_ID_RE = /^[0-9a-f]{20,40}$/

export function assertOwner(s) { if (!OWNER_RE.test(s ?? '')) throw new Error(`bad owner: ${JSON.stringify(s)}`); return s }
export function assertRepo(s) { if (!REPO_RE.test(s ?? '') || s === '.' || s === '..') throw new Error(`bad repo: ${JSON.stringify(s)}`); return s }
export function assertSha(s) { if (!SHA_RE.test(s ?? '')) throw new Error(`bad sha: ${JSON.stringify(s)}`); return s }

export function key(owner, repo, sha) { return `${assertOwner(owner)}/${assertRepo(repo)}@${assertSha(sha)}` }
export function short(sha) { return assertSha(sha).slice(0, 7) }
export function approvedDir(owner, repo, sha) { return `approved/${assertOwner(owner)}/${assertRepo(repo)}/${assertSha(sha)}` }
export function reviewBranch(kind, owner, repo, sha) { return `${kind}/${assertOwner(owner)}-${assertRepo(repo)}-${short(sha)}` }
export function installLine(owner, repo, sha) { return `rtk pipeline add github:${assertOwner(owner)}/${assertRepo(repo)}@${assertSha(sha)}` }
export function rawUrl(owner, repo, sha) { return `https://raw.githubusercontent.com/${assertOwner(owner)}/${assertRepo(repo)}/${assertSha(sha)}/pipeline.toml` }
export function benchmarkRawUrl(owner, repo, sha) { return `https://raw.githubusercontent.com/${assertOwner(owner)}/${assertRepo(repo)}/${assertSha(sha)}/benchmark.toml` }
export function readmeRawUrl(owner, repo, sha) { return `https://raw.githubusercontent.com/${assertOwner(owner)}/${assertRepo(repo)}/${assertSha(sha)}/README.md` }

export function parseApprovedPath(p) {
  const m = String(p).match(/^approved\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(pipeline\.toml|entry\.toml|report\.json|benchmark\.toml)$/)
  if (!m) return null
  try { return { owner: assertOwner(m[1]), repo: assertRepo(m[2]), sha: m[3], file: m[4] } } catch { return null }
}
