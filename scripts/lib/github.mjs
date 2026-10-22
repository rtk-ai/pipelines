// Thin GitHub client over fetch. Token from GH_TOKEN / GITHUB_TOKEN.

const API = 'https://api.github.com'

export function token() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
}

function headers(extra = {}) {
  const h = { 'User-Agent': 'rtk-pipelines-bot', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra }
  const t = token()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

export async function rest(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: headers(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.message ?? text.slice(0, 200)}`)
  return json
}

export async function graphql(query, variables = {}) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ query, variables }) })
  const json = await res.json()
  if (!res.ok || json.errors?.length) throw new Error(`graphql: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 500)}`)
  return json.data
}

/** Raw blob at a commit, capped. Returns { text, bytes } or null when missing. */
export async function fetchRaw(url, cap = 64 * 1024) {
  const res = await fetch(url, { headers: { 'User-Agent': 'rtk-pipelines-bot', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > cap) return { text: null, bytes: buf.length, too_large: true }
  return { text: buf.toString('utf8'), bytes: buf.length, buffer: buf }
}

export async function postDiscord(webhook, content) {
  if (!webhook) return false
  const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) })
  return res.ok
}
