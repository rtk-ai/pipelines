// Structural analysis of a candidate pipeline.toml. Pure: no I/O, no rtk.
// The verdict here is combined with rtk's own `pipeline add` result in
// precheck.mjs. Every fact below was checked against rtk v1.0.1
// (engine/src/pipeline/schema.rs, resolve.rs, validate.rs, position.rs).

import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'

export const BUILTIN_PIPELINES = [
  'rtk:default', 'rtk:posthook', 'rtk:proxy',
  'rtk:delegate-reads', 'rtk:verbatim-diffs', 'rtk:terse',
]
export const BUILTIN_CHAINS = ['term', 'json', 'web', 'matches']
export const CANONICAL_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
}
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])
export const HOOK_EVENTS = ['before_tool', 'after_tool']
export const HOOK_SUBJECTS = ['read', 'write', 'edit', 'shell', 'search', 'web', 'subagent', 'mcp', 'any']
export const PROXY_PARTS = ['tool_result', 'tool_use', 'assistant', 'user', 'system', 'tools', 'model', 'cache', 'any']
export const TEXT_KEYS = ['text', 'message', 'instructions', 'prompt', 'labels', 'rubric']
export const CONTROL_ACTIONS = ['rewrite', 'deny', 'passthrough', 'route']
export const CAPS = { perBlock: 1500, total: 4000 }
export const MAX_BYTES = 64 * 1024

const UPSTREAM_KEYS = new Set([
  'provider', 'model', 'base_url', 'api_key_env', 'api_key_command',
  'api_key', 'timeout_secs',
])
const SECRET_SHAPES = [
  ['openai key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['github token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ['github fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name)
}

/** Name rtk installs under: `[pipeline] name`, else the repo slug minus `rtk-pipeline-`. */
export function deriveName(declared, repo) {
  if (validName(declared)) return declared
  const slug = String(repo ?? '').toLowerCase().replace(/^rtk-pipeline-?/, '')
  return validName(slug) && slug.length > 0 ? slug : null
}

/** Code points that render as nothing: Unicode format chars (Cf) and C0 controls other than \t \n \r. */
export function hiddenUnicode(text) {
  const out = []
  const re = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu
  let m
  let line = 1
  let lastIndex = 0
  while ((m = re.exec(text)) !== null) {
    for (let i = lastIndex; i < m.index; i++) if (text.charCodeAt(i) === 10) line++
    lastIndex = m.index
    const cp = m[0].codePointAt(0)
    out.push({ line, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') })
    if (out.length >= 20) break
  }
  return out
}

export function secretShapes(text) {
  const out = []
  for (const [label, re] of SECRET_SHAPES) if (re.test(text)) out.push(label)
  return out
}

function asArray(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function isTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

/** TOML value rendered the way rtk's share card does (`{k}={v}` with toml Display). */
export function renderValue(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(renderValue).join(', ') + ']'
  if (isTable(v)) return '{ ' + Object.entries(v).map(([k, x]) => `${k} = ${renderValue(x)}`).join(', ') + ' }'
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export function friendlyPosition(position) {
  return position
    .replace('hook.before_tool.', 'before ')
    .replace('hook.after_tool.', 'after ')
    .replace('proxy.request.', 'proxy ')
    .replace(/_/g, ' ')
}

/** Same wording as rtk's share card ("What it does"), derived, never author text. */
export function describeRule(rule) {
  let does
  switch (rule.action) {
    case 'route': does = `delegate -> ${rule.task ?? 'bulk-read'}`; break
    case 'deny': does = 'block'; break
    case 'passthrough': does = 'passthrough'; break
    case 'rewrite': does = 'rewrite -> rtk'; break
    case undefined: case null: does = `compress [${(rule.use ?? []).join(', ')}]`; break
    default: does = `action ${rule.action}`
  }
  const when = Object.entries(rule.when ?? {}).map(([k, v]) => `${k}=${renderValue(v)}`).join(', ')
  return { position: friendlyPosition(rule.position), does, when }
}

function hostOf(url) {
  try {
    const u = new URL(url)
    return { host: u.hostname, scheme: u.protocol.replace(':', '') }
  } catch {
    return { host: null, scheme: null }
  }
}

export function isLoopback(host) {
  if (!host) return false
  const h = host.toLowerCase()
  return LOOPBACK_HOSTS.has(h) || h.startsWith('127.') || h.endsWith('.localhost')
}

function collectRules(doc, notes) {
  const rules = []
  for (const site of ['hook', 'proxy']) {
    const events = doc[site]
    if (!isTable(events)) continue
    for (const [event, subjects] of Object.entries(events)) {
      if (!isTable(subjects)) continue
      for (const [subject, list] of Object.entries(subjects)) {
        const position = `${site}.${event}.${subject}`
        const legal = site === 'hook'
          ? HOOK_EVENTS.includes(event) && HOOK_SUBJECTS.includes(subject)
          : event === 'request' && PROXY_PARTS.includes(subject)
        if (!legal) notes.unknown_positions.push(position)
        asArray(list).forEach((r, i) => {
          if (!isTable(r)) return
          rules.push({
            position,
            index: i,
            name: typeof r.name === 'string' ? r.name : null,
            action: typeof r.action === 'string' ? r.action : null,
            task: typeof r.task === 'string' ? r.task : null,
            upstream: typeof r.upstream === 'string' ? r.upstream : null,
            use: asArray(r.use).filter((x) => typeof x === 'string'),
            when: isTable(r.when) ? r.when : {},
            any: asArray(r.any).filter(isTable),
            mode: typeof r.mode === 'string' ? r.mode : null,
            message: typeof r.message === 'string' ? r.message : null,
            enabled: r.enabled !== false,
            shadow: r.shadow === true,
            continue: r.continue === true,
          })
        })
      }
    }
  }
  return rules
}

/**
 * @param {object} input
 * @param {string} input.toml            file text
 * @param {string} [input.owner]         GitHub login (reserved-name exemption for rtk-ai)
 * @param {string} [input.repo]          repo slug (name fallback)
 * @param {Set<string>} [input.methods]  registered method names (from `rtk methods list`)
 * @param {Set<string>} [input.chains]   registered chain names (defaults to BUILTIN_CHAINS)
 * @param {Set<string>} [input.reservedMethods] names rtk reserves but has not implemented
 * @param {Record<string, object>} [input.builtins] parsed builtin pipelines by name (for override targets)
 * @param {{names?: string[], patterns?: string[]}} [input.reserved] reserved pipeline names
 * @param {{perBlock:number,total:number}} [input.caps]
 */
export function analyze(input) {
  const {
    toml, owner = null, repo = null,
    methods = new Set(), chains = new Set(BUILTIN_CHAINS), reservedMethods = new Set(),
    builtins = {}, reserved = { names: [], patterns: [] }, caps = CAPS,
  } = input

  const refusals = []
  const notes = { unknown_positions: [], warnings: [] }
  const refuse = (code, detail) => refusals.push(detail === undefined ? { code } : { code, detail })

  const size_bytes = Buffer.byteLength(toml, 'utf8')
  if (size_bytes > MAX_BYTES) refuse('too_large', `${size_bytes} bytes > ${MAX_BYTES}`)

  const hidden_unicode = hiddenUnicode(toml)
  if (hidden_unicode.length) refuse('hidden_unicode', hidden_unicode.map((h) => `${h.codepoint}@L${h.line}`).join(' '))

  const secrets = secretShapes(toml)
  if (secrets.length) refuse('secret_shape', secrets.join(', '))

  let doc
  try {
    doc = parseToml(toml)
  } catch (e) {
    refuse('parse_error', String(e?.message ?? e).split('\n')[0].slice(0, 200))
    return finish({ name: deriveName(null, repo), extends: [], rules: [], directives: [], egress: [], text_blocks: [], overrides: [], tasks: [], classifiers: [], control_rules: zeroControl(), plugins_missing: [], reserved_methods: [], size_bytes, hidden_unicode, refusals, notes, caps })
  }

  const pipeline = isTable(doc.pipeline) ? doc.pipeline : {}
  const declared = typeof pipeline.name === 'string' ? pipeline.name : null
  if (declared !== null && !validName(declared)) refuse('invalid_name', declared.slice(0, 80))
  const name = deriveName(declared, repo)
  if (!name) refuse('no_name', 'no valid `[pipeline] name` and no usable repo slug')

  const extends_ = asArray(pipeline.extends).filter((x) => typeof x === 'string')
  for (const e of extends_) if (!BUILTIN_PIPELINES.includes(e)) notes.warnings.push(`extends unknown builtin \`${e}\` (rtk E002)`)

  // reserved names: exact + patterns, unless the publisher is rtk-ai itself
  const lowered = (name ?? '').toLowerCase()
  const slugLowered = String(repo ?? '').toLowerCase().replace(/^rtk-pipeline-?/, '')
  if (owner !== 'rtk-ai') {
    const hits = new Set()
    for (const n of reserved.names ?? []) if (n === lowered || n === slugLowered) hits.add(n)
    for (const p of reserved.patterns ?? []) {
      const re = new RegExp(p, 'i')
      if (re.test(lowered) || (slugLowered && re.test(slugLowered))) hits.add(`/${p}/`)
    }
    if (hits.size) refuse('reserved_name', [...hits].join(', '))
  }

  const rules = collectRules(doc, notes)
  const directives = asArray(doc.directive).filter(isTable).map((d, i) => ({
    index: i,
    name: typeof d.name === 'string' ? d.name : null,
    use: typeof d.use === 'string' ? d.use : null,
    text: typeof d.text === 'string' ? d.text : null,
    file: typeof d.file === 'string' ? d.file : null,
    channel: typeof d.channel === 'string' ? d.channel : null,
    enabled: d.enabled !== false,
  }))
  const fileDirectives = directives.filter((d) => d.file !== null)
  if (fileDirectives.length) refuse('file_directive', fileDirectives.map((d) => d.file).join(', '))

  // methods and plugins
  const methodDefs = isTable(doc.method) ? doc.method : {}
  const customChains = new Set()
  const referenced = new Set()
  for (const [mname, def] of Object.entries(methodDefs)) {
    if (!isTable(def)) continue
    if (Array.isArray(def.chain)) {
      customChains.add(mname)
      for (const m of def.chain) if (typeof m === 'string') referenced.add(m)
    } else {
      notes.warnings.push(`[method.${mname}] sets options on a method (rtk E016 unless it is a plugin)`)
    }
  }
  for (const r of rules) for (const m of r.use) referenced.add(m)
  const plugins_missing = []
  const reserved_methods = []
  for (const m of referenced) {
    if (methods.has(m) || chains.has(m) || customChains.has(m)) continue
    if (reservedMethods.has(m)) reserved_methods.push(m)
    else plugins_missing.push(m)
  }
  if (plugins_missing.length) refuse('plugins_missing', plugins_missing.join(', '))

  // upstreams / egress
  const upstreams = isTable(doc.upstream) ? doc.upstream : {}
  const egress = []
  for (const [uname, u] of Object.entries(upstreams)) {
    if (!isTable(u)) continue
    const provider = typeof u.provider === 'string' ? u.provider : null
    const base_url = typeof u.base_url === 'string' ? u.base_url : null
    const { host, scheme } = base_url ? hostOf(base_url) : { host: null, scheme: null }
    const local = base_url ? isLoopback(host) : false
    const api_key_env = typeof u.api_key_env === 'string' ? u.api_key_env : null
    const canonical_env = provider ? (CANONICAL_ENV[provider] ?? null) : null
    const unknown_keys = Object.keys(u).filter((k) => !UPSTREAM_KEYS.has(k))
    const e = {
      name: uname,
      provider,
      model: typeof u.model === 'string' ? u.model : null,
      base_url,
      host,
      scheme,
      local,
      api_key_env,
      canonical_env,
      custom: Boolean(base_url) && !local,
      noncanonical_env: api_key_env !== null && api_key_env !== canonical_env,
      api_key_command: typeof u.api_key_command === 'string',
      timeout_secs: typeof u.timeout_secs === 'number' ? u.timeout_secs : null,
      unknown_keys,
    }
    if (e.api_key_command) refuse('key_command', `upstream \`${uname}\``)
    if ('api_key' in u) refuse('secret_literal', `upstream \`${uname}\` carries an inline api_key`)
    if (base_url && scheme && scheme !== 'https' && !local) notes.warnings.push(`upstream \`${uname}\` uses ${scheme}:// to a non-local host`)
    if (api_key_env && /^(GITHUB_TOKEN|GH_TOKEN|AWS_|SSH_|NPM_TOKEN|CARGO_REGISTRY_TOKEN|DOCKER_|KUBE|GOOGLE_APPLICATION_CREDENTIALS|DATABASE_URL|HOME|PATH)/.test(api_key_env)) {
      notes.warnings.push(`upstream \`${uname}\` reads $${api_key_env}, which is not an LLM credential`)
    }
    egress.push(e)
  }

  // tasks / classifiers
  const tasks = Object.entries(isTable(doc.task) ? doc.task : {}).filter(([, t]) => isTable(t)).map(([tname, t]) => ({
    name: tname,
    kind: typeof t.kind === 'string' ? t.kind : null,
    upstream: typeof t.upstream === 'string' ? t.upstream : null,
    context: t.context === true,
    has_instructions: typeof t.instructions === 'string',
    has_prompt: typeof t.prompt === 'string',
  }))
  const classifiers = Object.entries(isTable(doc.classifier) ? doc.classifier : {}).filter(([, c]) => isTable(c)).map(([cname, c]) => ({
    name: cname,
    question: typeof c.question === 'string' ? c.question : null,
    upstream: typeof c.upstream === 'string' ? c.upstream : null,
    labels: isTable(c.labels) ? Object.keys(c.labels) : [],
    rubric_len: asArray(c.rubric).length,
  }))

  // text blocks: everything an author wrote that reaches a model or the agent
  const text_blocks = []
  const block = (kind, ownerName, text) => {
    if (typeof text !== 'string' || text.trim() === '') return
    text_blocks.push({ kind, owner: ownerName, chars: text.length, sha256: sha256(text), text })
  }
  directives.forEach((d) => block('directive.text', d.name ?? `directive[${d.index}]`, d.text))
  rules.forEach((r) => block('rule.message', r.name ?? `${r.position}[${r.index}]`, r.message))
  for (const [tname, t] of Object.entries(isTable(doc.task) ? doc.task : {})) {
    if (!isTable(t)) continue
    block('task.instructions', tname, t.instructions)
    block('task.prompt', tname, t.prompt)
  }
  for (const [cname, c] of Object.entries(isTable(doc.classifier) ? doc.classifier : {})) {
    if (!isTable(c)) continue
    block('classifier.instructions', cname, c.instructions)
    if (isTable(c.labels)) block('classifier.labels', cname, Object.entries(c.labels).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : renderValue(v)}`).join('\n'))
    if (Array.isArray(c.rubric)) block('classifier.rubric', cname, c.rubric.map((x) => (typeof x === 'string' ? x : renderValue(x))).join('\n'))
  }

  // overrides on built-in (or sibling) rules and directives
  const overrides = []
  const overrideDefs = isTable(doc.override) ? doc.override : {}
  for (const [target, patch] of Object.entries(overrideDefs)) {
    if (!isTable(patch)) continue
    const keys = Object.keys(patch)
    for (const k of keys) {
      if (!TEXT_KEYS.includes(k)) continue
      const v = patch[k]
      block(`override.${k}`, target, typeof v === 'string' ? v : renderValue(v))
    }
    const found = findInBuiltins(builtins, target)
    const hardControl = keys.some((k) => ['action', 'task', 'upstream', 'when', 'any', 'mode'].includes(k))
    const softControl = keys.some((k) => ['enabled', 'shadow', 'continue', 'use'].includes(k))
    const touches_control = hardControl || (softControl && Boolean(found?.rule?.action))
    overrides.push({
      target,
      keys,
      target_kind: found?.kind ?? null,
      target_builtin: found?.builtin ?? null,
      target_action: found?.rule?.action ?? null,
      touches_control,
    })
  }

  const control_rules = zeroControl()
  for (const r of rules) if (r.enabled && r.action && r.action in control_rules) control_rules[r.action]++

  // text caps
  const total = text_blocks.reduce((n, b) => n + b.chars, 0)
  const over = text_blocks.filter((b) => b.chars > caps.perBlock)
  if (over.length) refuse('text_over_cap', over.map((b) => `${b.kind} ${b.owner} (${b.chars} > ${caps.perBlock})`).join('; '))
  if (total > caps.total) refuse('text_total_over_cap', `${total} > ${caps.total}`)

  return finish({
    name, extends: extends_, rules, directives, egress, text_blocks, overrides, tasks, classifiers,
    control_rules, plugins_missing, reserved_methods, size_bytes, hidden_unicode, refusals, notes, caps,
  })
}

function zeroControl() {
  return { deny: 0, route: 0, rewrite: 0, passthrough: 0 }
}

function findInBuiltins(builtins, target) {
  for (const [builtin, doc] of Object.entries(builtins ?? {})) {
    if (!isTable(doc)) continue
    for (const site of ['hook', 'proxy']) {
      const events = doc[site]
      if (!isTable(events)) continue
      for (const subjects of Object.values(events)) {
        if (!isTable(subjects)) continue
        for (const list of Object.values(subjects)) {
          for (const r of asArray(list)) if (isTable(r) && r.name === target) return { kind: 'rule', builtin, rule: { action: typeof r.action === 'string' ? r.action : null } }
        }
      }
    }
    for (const d of asArray(doc.directive)) if (isTable(d) && (d.name === target || d.use === target)) return { kind: 'directive', builtin, rule: null }
  }
  return null
}

function finish(s) {
  const refused = s.refusals.length > 0
  const hasText = s.text_blocks.length > 0
  const structural = s.egress.length > 0 || s.tasks.length > 0 || s.classifiers.length > 0
    || s.control_rules.route > 0 || s.control_rules.deny > 0
    || s.overrides.some((o) => o.touches_control)
  const tier = refused ? 'refused' : hasText ? 'text' : structural ? 'structural' : 'safe'
  const flagged = s.egress.some((e) => e.custom || e.noncanonical_env || e.unknown_keys.length)
    || s.reserved_methods.length > 0 || s.notes.unknown_positions.length > 0 || s.notes.warnings.length > 0
    || s.overrides.some((o) => o.touches_control)
  const label = tier === 'refused' ? 'refused' : (tier === 'text' || flagged) ? 'needs-reading' : 'pre-checked'
  const summary = s.rules.filter((r) => r.enabled && !r.shadow).map(describeRule)
  return {
    name: s.name,
    tier,
    label,
    size_bytes: s.size_bytes,
    extends: s.extends,
    rules: s.rules.map((r) => ({ ...r, message: undefined, has_message: r.message !== null })),
    rule_summary: summary,
    directives: s.directives.map((d) => ({ ...d, text: undefined, has_text: d.text !== null })),
    egress: s.egress,
    env_vars: [...new Set(s.egress.map((e) => e.api_key_env ?? e.canonical_env).filter(Boolean))],
    tasks: s.tasks,
    classifiers: s.classifiers,
    text_blocks: s.text_blocks,
    text_chars: s.text_blocks.reduce((n, b) => n + b.chars, 0),
    overrides: s.overrides,
    control_rules: s.control_rules,
    plugins_missing: s.plugins_missing,
    reserved_methods: s.reserved_methods,
    hidden_unicode: s.hidden_unicode,
    unknown_positions: s.notes.unknown_positions,
    warnings: s.notes.warnings,
    refusals: s.refusals,
    caps: s.caps,
  }
}
