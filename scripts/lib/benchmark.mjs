/**
 * benchmark.mjs — the numbers an author may publish next to a pipeline.
 *
 * Two sources, both author-controlled and therefore shown on the site with a
 * "declared by the author" label. The bot only checks shape and bounds; it
 * never trusts a percentage (the site recomputes every delta from the two
 * raw values) and it never lets author text reach the site unbounded.
 *
 *   benchmark.toml   an A/B result the author ran (cost per trial with and
 *                    without the pipeline, optional quality metric, per task)
 *   README.md        the share card `rtk pipeline share publish` writes, whose
 *                    "Measured impact" table is the author's own rtk usage
 */

import { parse as parseToml } from 'smol-toml'

export const BENCH_MAX_BYTES = 32 * 1024
export const BENCH_LIMITS = { tasks: 50, dates: 12 }
const STR = { suite: 60, agent: 60, model: 60, baseline: 80, metric: 40, task: 80, notes: 400, path: 100, per: 20 }
const PATH_RE = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KNOWN = new Set(['suite', 'agent', 'model', 'baseline', 'trials_per_arm', 'dates', 'details', 'raw', 'notes', 'cost', 'quality', 'task'])

// Control characters, zero-width and bidi marks, BOM: collapsed to a space.
const HIDDEN_RANGES = [[0x0000, 0x001f], [0x007f, 0x007f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
const HIDDEN_RE = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)).join('')}]`, 'gu')
const clean = (s) => s.replace(HIDDEN_RE, ' ').replace(/\s+/g, ' ').trim()

function str(v, max, where, errors, { required = false } = {}) {
  if (v === undefined || v === null) { if (required) errors.push(`${where}: missing`); return null }
  if (typeof v !== 'string') { errors.push(`${where}: must be a string`); return null }
  const s = clean(v)
  if (!s) { if (required) errors.push(`${where}: empty`); return null }
  if (s.length > max) { errors.push(`${where}: over ${max} characters`); return null }
  return s
}
function num(v, where, errors, { required = false, min = -1e9, max = 1e9 } = {}) {
  if (v === undefined || v === null) { if (required) errors.push(`${where}: missing`); return null }
  if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${where}: must be a finite number`); return null }
  if (v < min || v > max) { errors.push(`${where}: out of range (${min}..${max})`); return null }
  return v
}
function int(v, where, errors, opts) {
  const n = num(v, where, errors, opts)
  if (n !== null && !Number.isInteger(n)) { errors.push(`${where}: must be a whole number`); return null }
  return n
}
function relPath(v, where, errors) {
  const s = str(v, STR.path, where, errors)
  if (s === null) return null
  if (!PATH_RE.test(s)) { errors.push(`${where}: must be a plain repo-relative path (letters, digits, . _ / -)`); return null }
  return s
}
function isoDate(v, where, errors) {
  if (v instanceof Date) { if (isNaN(v.getTime())) { errors.push(`${where}: invalid date`); return null } return v.toISOString().slice(0, 10) }
  const s = str(v, 10, where, errors)
  if (s === null) return null
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) { errors.push(`${where}: must be YYYY-MM-DD`); return null }
  return s
}

/** Shape-check a parsed benchmark.toml. Returns { benchmark|null, errors, warnings }. */
export function normalizeBenchmark(doc) {
  const errors = [], warnings = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { benchmark: null, errors: ['not a TOML table'], warnings }
  if (doc.schema_version !== 1) errors.push('schema_version must be 1')
  const b = doc.benchmark
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { benchmark: null, errors: [...errors, '[benchmark] table missing'], warnings }
  for (const k of Object.keys(b)) if (!KNOWN.has(k)) warnings.push(`[benchmark].${k} is not a known key and is ignored`)

  const out = {
    suite: str(b.suite, STR.suite, '[benchmark].suite', errors, { required: true }),
    agent: str(b.agent, STR.agent, '[benchmark].agent', errors),
    model: str(b.model, STR.model, '[benchmark].model', errors),
    baseline: str(b.baseline, STR.baseline, '[benchmark].baseline', errors) ?? 'without this pipeline',
    trials_per_arm: int(b.trials_per_arm, '[benchmark].trials_per_arm', errors, { min: 1, max: 1_000_000 }),
    dates: [],
    details: relPath(b.details, '[benchmark].details', errors),
    raw: relPath(b.raw, '[benchmark].raw', errors),
    notes: str(b.notes, STR.notes, '[benchmark].notes', errors),
    cost: null,
    quality: null,
    tasks: [],
  }

  const dates = Array.isArray(b.dates) ? b.dates : b.dates === undefined ? [] : [b.dates]
  if (dates.length > BENCH_LIMITS.dates) errors.push(`[benchmark].dates: more than ${BENCH_LIMITS.dates} entries`)
  else out.dates = dates.map((d, i) => isoDate(d, `[benchmark].dates[${i}]`, errors)).filter(Boolean).sort()

  if (!b.cost || typeof b.cost !== 'object' || Array.isArray(b.cost)) errors.push('[benchmark.cost] missing: baseline and pipeline mean cost are required')
  else {
    const baseline = num(b.cost.baseline, '[benchmark.cost].baseline', errors, { required: true, min: 0, max: 1e7 })
    const pipeline = num(b.cost.pipeline, '[benchmark.cost].pipeline', errors, { required: true, min: 0, max: 1e7 })
    const unit = str(b.cost.unit, 10, '[benchmark.cost].unit', errors) ?? 'usd'
    if (unit !== 'usd') errors.push('[benchmark.cost].unit: only "usd" is supported')
    const per = str(b.cost.per, STR.per, '[benchmark.cost].per', errors) ?? 'trial'
    if (!/^[a-z][a-z -]{0,19}$/.test(per)) errors.push('[benchmark.cost].per: lowercase word such as "trial", "task" or "session"')
    if (baseline === 0) errors.push('[benchmark.cost].baseline: must be greater than 0')
    if (baseline !== null && pipeline !== null && baseline > 0) out.cost = { baseline, pipeline, unit: 'usd', per }
  }

  if (b.quality !== undefined) {
    const q = b.quality
    if (!q || typeof q !== 'object' || Array.isArray(q)) errors.push('[benchmark.quality] must be a table')
    else {
      const metric = str(q.metric, STR.metric, '[benchmark.quality].metric', errors, { required: true })
      const baseline = num(q.baseline, '[benchmark.quality].baseline', errors, { required: true })
      const pipeline = num(q.pipeline, '[benchmark.quality].pipeline', errors, { required: true })
      const higher = q.higher_is_better === undefined ? true : q.higher_is_better
      if (typeof higher !== 'boolean') errors.push('[benchmark.quality].higher_is_better: must be true or false')
      if (metric !== null && baseline !== null && pipeline !== null && typeof higher === 'boolean') out.quality = { metric, baseline, pipeline, higher_is_better: higher }
    }
  }

  const tasks = Array.isArray(b.task) ? b.task : b.task === undefined ? [] : null
  if (tasks === null) errors.push('[[benchmark.task]] must be an array of tables')
  else if (tasks.length > BENCH_LIMITS.tasks) errors.push(`[[benchmark.task]]: more than ${BENCH_LIMITS.tasks} tasks`)
  else {
    const names = new Set()
    tasks.forEach((t, i) => {
      const w = `[[benchmark.task]][${i}]`
      if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`${w}: must be a table`); return }
      const name = str(t.name, STR.task, `${w}.name`, errors, { required: true })
      const baseline = num(t.baseline, `${w}.baseline`, errors, { required: true, min: 0, max: 1e7 })
      const pipeline = num(t.pipeline, `${w}.pipeline`, errors, { required: true, min: 0, max: 1e7 })
      const qb = num(t.quality_baseline, `${w}.quality_baseline`, errors)
      const qp = num(t.quality_pipeline, `${w}.quality_pipeline`, errors)
      if (name !== null && names.has(name.toLowerCase())) errors.push(`${w}.name: duplicate task "${name}"`)
      if (name !== null) names.add(name.toLowerCase())
      if (name !== null && baseline !== null && pipeline !== null) out.tasks.push({ name, baseline, pipeline, quality_baseline: qb, quality_pipeline: qp })
    })
  }

  return { benchmark: errors.length ? null : out, errors, warnings }
}

/** Parse + normalize the text of a benchmark.toml. Never throws. */
export function parseBenchmarkToml(text) {
  if (typeof text !== 'string') return { benchmark: null, errors: ['benchmark.toml: no text'], warnings: [] }
  if (Buffer.byteLength(text, 'utf8') > BENCH_MAX_BYTES) return { benchmark: null, errors: [`benchmark.toml is over ${BENCH_MAX_BYTES} bytes`], warnings: [] }
  let doc
  try { doc = parseToml(text) } catch (e) { return { benchmark: null, errors: [`benchmark.toml does not parse: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`], warnings: [] } }
  return normalizeBenchmark(doc)
}

/** Fraction, negative = cheaper with the pipeline. */
export function costDelta(cost) {
  if (!cost || !(cost.baseline > 0)) return null
  return (cost.pipeline - cost.baseline) / cost.baseline
}

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)'
const BAR = '(?:`[█░▒▓ ]*`\\s*)?'
const ROW_RE = new RegExp(`^\\|\\s*(.+?)\\s*\\|\\s*${NUM}\\s+([A-Za-z]+)\\s*\\|\\s*${BAR}\\*\\*${NUM}\\s*(%|K|M)?\\*\\*\\s*(removed|kept out of context|cached)\\s*\\|\\s*$`)

function toCount(numText, suffix) {
  const n = Number(numText.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return suffix === 'K' ? Math.round(n * 1_000) : suffix === 'M' ? Math.round(n * 1_000_000) : n
}

/**
 * The "Measured impact" table of a README written by `rtk pipeline share publish`.
 * Only the rtk-generated row shapes are accepted; anything else is ignored.
 * Returns null when the card has no numbers.
 */
export function parseShareCard(readme) {
  if (typeof readme !== 'string' || !/^# rtk pipeline · /m.test(readme)) return null
  const text = readme.replace(/\r\n/g, '\n')
  const headline = text.match(/^\*\*([^*\n]{1,120})\*\* — self-reported by the author's own rtk/m)?.[1] ?? null
  const measured = text.match(/^Measured by \[rtk\]\([^)]*\) (v\d+\.\d+\.\d+[-.\w]*) on (\d{4}-\d{2}-\d{2})\.?$/m)
  const section = text.split(/^## Measured impact\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const levers = []
  for (const line of section.split('\n')) {
    const m = line.match(ROW_RE)
    if (!m) continue
    const [, lever, actText, actUnit, valText, suffix, verb] = m
    const activity = toCount(actText, null)
    const value = toCount(valText, suffix === '%' ? null : suffix)
    if (activity === null || value === null) continue
    const kind = /^command filtering/i.test(lever) ? 'command_filtering' : /^delegated reads/i.test(lever) ? 'delegated_reads' : /^prompt-cache/i.test(lever) ? 'cache_hits' : 'other'
    const row = { kind, lever: clean(lever).replace(/`/g, '').slice(0, 60), activity: Math.round(activity), activity_unit: actUnit.toLowerCase().slice(0, 12) }
    if (suffix === '%' && verb === 'removed' && value >= 0 && value <= 100) row.removed_pct = value
    else if (suffix === '%' && verb === 'cached' && value >= 0 && value <= 100) row.cached_pct = value
    else if (verb === 'kept out of context') row.tokens_kept_out = Math.round(value)
    else continue
    levers.push(row)
    if (levers.length >= 12) break
  }
  if (!headline && levers.length === 0) return null
  return { headline: headline ? clean(headline) : null, rtk_version: measured?.[1] ?? null, measured_on: measured?.[2] ?? null, levers }
}

const pct = (f) => { const v = Math.abs(f * 100); const body = (v < 100 ? v.toFixed(1) : v.toFixed(0)).replace(/\.0$/, ''); return Number(body) === 0 ? '0%' : `${f > 0 ? '+' : '−'}${body}%` }
const usd = (n) => `$${n.toFixed(n < 10 ? 3 : 2)}`

/** Markdown for the PR body. The maintainer sees exactly what the site will show. */
export function renderNumbersSection(report, cell) {
  const L = []
  const b = report.benchmark
  const s = report.self_reported
  if (!b && !s) return L
  L.push('')
  L.push("### Numbers the author publishes — declared, not verified by the bot")
  if (b) {
    L.push('')
    const setup = [b.suite, b.agent, b.model, b.trials_per_arm ? `${b.trials_per_arm} trials per arm` : null, b.dates.length ? b.dates.join(', ') : null].filter(Boolean)
    L.push(`**Benchmark (\`benchmark.toml\`)** — ${setup.map(cell).join(' · ')}`)
    L.push('')
    L.push(`| arm | mean cost per ${cell(b.cost.per)} | ${b.quality ? cell(b.quality.metric) : 'quality'} |`)
    L.push('|---|---|---|')
    L.push(`| ${cell(b.baseline)} | ${usd(b.cost.baseline)} | ${b.quality ? b.quality.baseline : '—'} |`)
    L.push(`| with the pipeline | ${usd(b.cost.pipeline)} (${pct(costDelta(b.cost))}) | ${b.quality ? b.quality.pipeline : '—'} |`)
    if (b.tasks.length) {
      L.push('')
      L.push('| task | baseline | pipeline | change | quality |')
      L.push('|---|---|---|---|---|')
      for (const t of b.tasks) L.push(`| ${cell(t.name)} | ${usd(t.baseline)} | ${usd(t.pipeline)} | ${t.baseline > 0 ? pct((t.pipeline - t.baseline) / t.baseline) : '—'} | ${t.quality_baseline != null && t.quality_pipeline != null ? `${t.quality_baseline} → ${t.quality_pipeline}` : '—'} |`)
    }
    if (b.details || b.raw) { L.push(''); L.push(`Files in the author's repo at this commit: ${[b.details, b.raw].filter(Boolean).map(cell).join(', ')}`) }
    if (b.notes) { L.push(''); L.push("Author's note (text):"); L.push('```text'); L.push(b.notes.replace(/`/g, "'")); L.push('```') }
  }
  if (s) {
    L.push('')
    L.push(`**Self-reported usage (README share card)**${s.headline ? ` — ${cell(s.headline)}` : ''}${s.rtk_version ? ` · rtk ${cell(s.rtk_version)}` : ''}${s.measured_on ? ` on ${s.measured_on}` : ''}`)
    for (const l of s.levers) L.push(`- ${cell(l.lever)}: ${l.activity} ${l.activity_unit} → ${l.removed_pct != null ? `${l.removed_pct}% removed` : l.cached_pct != null ? `${l.cached_pct}% cached` : `${l.tokens_kept_out} tokens kept out of context`}`)
  }
  return L
}
