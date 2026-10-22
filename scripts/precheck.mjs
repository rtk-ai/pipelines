#!/usr/bin/env node
// Pre-check one candidate pipeline.toml with the stock rtk binary plus the
// structural analyzer, and write report.json.
//
//   node scripts/precheck.mjs <pipeline.toml> --key owner/repo@sha [--owner o] [--repo r]
//        [--rtk path] [--out report.json] [--repo-json facts.json] [--no-rtk --fixtures dir]
//
// Exit 0 whenever a report was written (the verdict is inside it); 2 on
// internal errors. `--no-rtk` uses the snapshots under --fixtures (tests).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { analyze, sha256, deriveName, BUILTIN_CHAINS } from './lib/analyze.mjs'
import { rtkAdd, rtkMethods, rtkBuiltins, rtkVersion, rtkRefusalReason, parseMethodsList } from './lib/rtk.mjs'
import { loadReserved } from './lib/policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { args[k] = next; i++ } else args[k] = true
    } else args._.push(a)
  }
  return args
}

/** rtk facts from the binary, or from fixture snapshots when --no-rtk. */
export function loadRtkFacts({ bin, fixtures }) {
  if (fixtures) {
    const ml = parseMethodsList(readFileSync(join(fixtures, 'methods-list.txt'), 'utf8'))
    const builtins = {}
    for (const f of readdirSync(join(fixtures, 'builtins'))) {
      if (!f.endsWith('.toml')) continue
      builtins[`rtk:${f.replace(/\.toml$/, '')}`] = parseToml(readFileSync(join(fixtures, 'builtins', f), 'utf8'))
    }
    return { version: 'v1.0.1-fixture', ...ml, builtins }
  }
  return { version: rtkVersion(bin), ...rtkMethods(bin), builtins: rtkBuiltins(bin) }
}

/**
 * The whole verdict for one candidate. `facts` from loadRtkFacts, `meta`:
 * { key, owner, repo, repoFacts, rtkBin (null = skip rtk) }.
 */
export function precheck(toml, facts, meta) {
  const reserved = meta.reserved ?? loadReserved(ROOT)
  const structural = analyze({
    toml, owner: meta.owner, repo: meta.repo,
    methods: facts.methods, chains: new Set([...BUILTIN_CHAINS, ...facts.chains]), reservedMethods: facts.reserved,
    builtins: facts.builtins, reserved,
  })
  const name = structural.name ?? deriveName(null, meta.repo) ?? 'candidate'

  let add = { code: null, stdout: '', stderr: '', skipped: true }
  if (meta.rtkBin) add = rtkAdd(meta.rtkBin, toml, name)

  const refusals = [...structural.refusals]
  if (add.code !== null && add.code !== 0) refusals.push({ code: 'rtk_refused', detail: rtkRefusalReason(add) })

  const tier = refusals.length ? 'refused' : structural.tier
  const label = refusals.length ? 'refused' : structural.label
  return {
    rtk: facts.version,
    key: meta.key,
    checked_at: new Date().toISOString(),
    ...structural,
    name,
    tier,
    label,
    refusals,
    toml_sha256: sha256(toml),
    add_exit_code: add.code,
    add_stdout: add.stdout,
    add_stderr: add.stderr,
    repo: meta.repoFacts ?? null,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = args._[0]
  if (!file) { console.error('usage: precheck.mjs <pipeline.toml> --key owner/repo@sha [--rtk bin] [--out report.json]'); process.exit(2) }
  const toml = readFileSync(file, 'utf8')
  const key = args.key ?? 'local/candidate@0000000000000000000000000000000000000000'
  const [ownerRepo] = key.split('@')
  const [owner, repo] = ownerRepo.split('/')
  const bin = args['no-rtk'] ? null : (args.rtk ?? process.env.RTK_BIN ?? null)
  if (!bin && !args['no-rtk']) { console.error('precheck: no rtk binary (--rtk or RTK_BIN); use --no-rtk --fixtures <dir> for a structural-only run'); process.exit(2) }
  const facts = loadRtkFacts({ bin, fixtures: args['no-rtk'] ? (args.fixtures ?? join(ROOT, 'test/fixtures')) : null })
  const repoFacts = args['repo-json'] ? JSON.parse(readFileSync(args['repo-json'], 'utf8')) : null
  const report = precheck(toml, facts, { key, owner: args.owner ?? owner, repo: args.repo ?? repo, repoFacts, rtkBin: bin })
  const out = args.out ?? 'report.json'
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  const why = report.refusals.map((r) => r.code + (r.detail ? `(${r.detail})` : '')).join(', ')
  console.log(`${report.key}: tier=${report.tier} label=${report.label} rtk_exit=${report.add_exit_code}${why ? ` refusals=${why}` : ''} -> ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`precheck: ${e.stack ?? e}`); process.exit(2) })
}
