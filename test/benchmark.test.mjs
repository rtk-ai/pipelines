import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBenchmarkToml, parseShareCard, costDelta, renderNumbersSection, BENCH_LIMITS } from '../scripts/lib/benchmark.mjs'
import { parseApprovedPath } from '../scripts/lib/ids.mjs'
import { validateReport } from '../scripts/lib/entry.mjs'
import { cell } from '../scripts/lib/fence.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'benchmark')
const SAMPLE = readFileSync(join(FX, 'laya-delegate.toml'), 'utf8')

test('a well-formed benchmark.toml normalizes with every field bounded', () => {
  const { benchmark: b, errors, warnings } = parseBenchmarkToml(SAMPLE)
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  assert.equal(b.suite, 'SkillsBench')
  assert.equal(b.model, 'claude-opus-5-5')
  assert.equal(b.baseline, 'stock Claude Code')
  assert.equal(b.trials_per_arm, 48)
  assert.deepEqual(b.dates, ['2026-10-18', '2026-10-19'])
  assert.deepEqual(b.cost, { baseline: 3.587, pipeline: 3.088, unit: 'usd', per: 'trial' })
  assert.deepEqual(b.quality, { metric: 'reward', baseline: 0.81, pipeline: 0.81, higher_is_better: true })
  assert.equal(b.tasks.length, 6)
  assert.equal(b.tasks[0].name, 'parallel-tfidf-search')
  assert.ok(Math.abs(costDelta(b.cost) - -0.139) < 0.001)
})

test('bad shapes are rejected, never thrown', () => {
  const bad = (t) => parseBenchmarkToml(t).errors
  assert.ok(bad('not toml at all = = =').some((e) => /does not parse/.test(e)))
  assert.ok(bad('schema_version = 2\n[benchmark]\nsuite = "x"\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n').some((e) => /schema_version/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n').some((e) => /suite: missing/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\nsuite = "x"\n[benchmark.cost]\nbaseline = 0\npipeline = 1\n').some((e) => /greater than 0/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\nsuite = "x"\n[benchmark.cost]\nbaseline = -1\npipeline = 1\n').some((e) => /out of range/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\nsuite = "x"\ndetails = "../../etc/passwd"\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n').some((e) => /repo-relative/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\nsuite = "x"\nnotes = "' + 'a'.repeat(500) + '"\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n').some((e) => /over 400/.test(e)))
  const many = Array.from({ length: BENCH_LIMITS.tasks + 1 }, (_, i) => `[[benchmark.task]]\nname = "t${i}"\nbaseline = 1\npipeline = 1\n`).join('')
  assert.ok(bad(`schema_version = 1\n[benchmark]\nsuite = "x"\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n${many}`).some((e) => /more than 50/.test(e)))
  assert.ok(bad('schema_version = 1\n[benchmark]\nsuite = "x"\n[benchmark.cost]\nbaseline = 1\npipeline = 1\n[[benchmark.task]]\nname = "a"\nbaseline = 1\npipeline = 1\n[[benchmark.task]]\nname = "A"\nbaseline = 1\npipeline = 1\n').some((e) => /duplicate/.test(e)))
  assert.equal(parseBenchmarkToml('x'.repeat(40 * 1024)).benchmark, null)
  assert.equal(parseBenchmarkToml(null).benchmark, null)
})

test('unknown keys only warn; a TOML date works for dates', () => {
  const r = parseBenchmarkToml('schema_version = 1\n[benchmark]\nsuite = "x"\nfoo = 1\ndates = 2026-10-18\n[benchmark.cost]\nbaseline = 2\npipeline = 1\n')
  assert.ok(r.benchmark)
  assert.deepEqual(r.benchmark.dates, ['2026-10-18'])
  assert.ok(r.warnings.some((w) => /foo/.test(w)))
})

test('the rtk share card yields only rtk-shaped rows', () => {
  const s = parseShareCard(readFileSync(join(FX, 'share-card.md'), 'utf8'))
  assert.equal(s.headline, '34% of command output removed')
  assert.equal(s.rtk_version, 'v1.0.0')
  assert.equal(s.measured_on, '2026-10-14')
  assert.equal(s.levers.length, 3)
  assert.deepEqual(s.levers[0], { kind: 'command_filtering', lever: 'command filtering (rtk git/npm/…)', activity: 1172, activity_unit: 'commands', removed_pct: 34 })
  assert.deepEqual(s.levers[1], { kind: 'delegated_reads', lever: 'delegated reads (bulk-read)', activity: 10, activity_unit: 'reads', tokens_kept_out: 102100 })
  assert.deepEqual(s.levers[2], { kind: 'cache_hits', lever: 'prompt-cache hit rate', activity: 3751, activity_unit: 'requests', cached_pct: 98 })
  assert.equal(parseShareCard('# my own readme\n| a | 1 commands | **34%** removed |'), null)
  assert.equal(parseShareCard('# rtk pipeline · x\n\n_No recorded activity yet_'), null)
})

test('snapshot paths accept benchmark.toml and the report schema accepts the new fields', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(parseApprovedPath(`approved/o/r/${sha}/benchmark.toml`)?.file, 'benchmark.toml')
  assert.equal(parseApprovedPath(`approved/o/r/${sha}/RESULTS.md`), null)
  const base = { rtk: 'v1', key: 'o/r@' + sha, tier: 'safe', label: 'pre-checked', refusals: [], text_blocks: [], egress: [], rules: [], control_rules: {}, add_exit_code: 0, toml_sha256: 'a'.repeat(64) }
  assert.deepEqual(validateReport({ ...base, benchmark: null, self_reported: { levers: [] } }, 'r'), [])
  assert.ok(validateReport({ ...base, benchmark: [1] }, 'r').length === 1)
})

test('the PR body section shows the recomputed delta and the author label', () => {
  const { benchmark } = parseBenchmarkToml(SAMPLE)
  const md = renderNumbersSection({ benchmark, self_reported: parseShareCard(readFileSync(join(FX, 'share-card.md'), 'utf8')) }, cell).join('\n')
  assert.ok(md.includes('declared, not verified by the bot'))
  assert.ok(md.includes('−13.9%'))
  assert.ok(md.includes('`SkillsBench`'))
  assert.ok(md.includes('34% removed'))
  assert.deepEqual(renderNumbersSection({ benchmark: null, self_reported: null }, cell), [])
})
