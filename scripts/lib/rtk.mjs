// Runs the pinned, unmodified rtk binary against a candidate in a throwaway
// HOME. `rtk pipeline add <file> --shadow` is the pre-check primitive: it
// validates, refuses api_key_command, and prints the full disclosure. Nothing
// here parses the candidate itself; see analyze.mjs for that.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { BUILTIN_PIPELINES } from './analyze.mjs'

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI, '')
}

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (res.error) throw new Error(`${bin} ${args[0]}: ${res.error.message}`)
  return { code: res.status ?? 1, stdout: stripAnsi(res.stdout), stderr: stripAnsi(res.stderr), signal: res.signal }
}

export function rtkVersion(bin) {
  const r = run(bin, ['--version'])
  const m = r.stdout.match(/rtk\s+v?(\S+)/)
  return m ? `v${m[1]}` : r.stdout.trim()
}

/** Parses the text output of `rtk methods list` (no --format json in v1.0.1). */
export function parseMethodsList(text) {
  const methods = new Set()
  const chains = new Set()
  const reserved = new Set()
  let section = 'methods'
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (/^chains\b/.test(line)) { section = 'chains'; continue }
    if (/^directives:/.test(line)) { section = 'directives'; continue }
    const rm = line.match(/^reserved names:\s*(.*)$/)
    if (rm) { rm[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => reserved.add(s)); section = 'done'; continue }
    if (!line.trim()) continue
    if (section === 'methods') {
      const m = line.match(/^([a-z0-9][a-z0-9_-]*)\s+(transform|classify|route|redact|[a-z]+)\s+/)
      if (m && m[1] !== 'method') methods.add(m[1])
    } else if (section === 'chains') {
      const m = line.match(/^\s*([a-z0-9][a-z0-9_-]*)\s*=\s*\[/)
      if (m) chains.add(m[1])
    }
  }
  return { methods, chains, reserved }
}

export function rtkMethods(bin) {
  const r = run(bin, ['methods', 'list'])
  if (r.code !== 0) throw new Error(`rtk methods list failed: ${r.stderr}`)
  return parseMethodsList(r.stdout)
}

/** `rtk pipeline show rtk:<name>` for every builtin, parsed. */
export function rtkBuiltins(bin) {
  const out = {}
  for (const name of BUILTIN_PIPELINES) {
    const r = run(bin, ['pipeline', 'show', name])
    if (r.code !== 0) continue
    try { out[name] = parseToml(r.stdout) } catch { /* a builtin that does not parse is not our problem here */ }
  }
  return out
}

/**
 * Sandboxed `rtk pipeline add <candidate> --shadow --name <name>`.
 * Returns { code, stdout, stderr }. Exit 0 = rtk would install it.
 */
export function rtkAdd(bin, tomlText, name) {
  const root = mkdtempSync(join(tmpdir(), 'rtk-precheck-'))
  try {
    const file = join(root, 'candidate.toml')
    writeFileSync(file, tomlText, 'utf8')
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      RTK_CONFIG_DIR: join(root, 'config', 'rtk'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      NO_COLOR: '1',
      TERM: 'dumb',
      RTK_NO_TELEMETRY: '1',
      RTK_TELEMETRY: 'off',
    }
    const args = ['pipeline', 'add', file, '--shadow']
    if (name) args.push('--name', name)
    const r = run(bin, args, { env, timeout: 60_000 })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timed_out: r.signal === 'SIGTERM' }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Short reason from rtk's own stderr/stdout, for seen.json and issue comments. */
export function rtkRefusalReason(add) {
  const text = `${add.stderr}\n${add.stdout}`
  if (/Refused: api_key_command/.test(text)) return 'rtk: refused api_key_command'
  if (/needs plugins you do not have/.test(text)) return 'rtk: missing plugins'
  if (/not installed — fix the errors above/.test(text)) {
    const codes = [...text.matchAll(/\b(E\d{3})\b/g)].map((m) => m[1])
    return `rtk: validation errors ${[...new Set(codes)].join(' ')}`.trim()
  }
  if (/no `\[pipeline\] name`/.test(text)) return 'rtk: no pipeline name'
  if (add.timed_out) return 'rtk: timed out'
  const first = text.split('\n').map((s) => s.trim()).find(Boolean)
  return `rtk: exit ${add.code}${first ? ` — ${first.slice(0, 160)}` : ''}`
}
