import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentFingerprint, approvedFingerprints, findDuplicate, pairOpenDuplicates } from '../scripts/lib/dedupe.mjs'
import { listApproved } from '../scripts/lib/policy.mjs'

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sample-repo')

test('fingerprint ignores comments, whitespace, key order and the pipeline name', () => {
  const a = 'schema_version = 1\n[pipeline]\nname = "x"\nextends = "rtk:proxy"\n'
  const b = '# a comment\n\nschema_version   =   1\n[pipeline]\nextends="rtk:proxy"   # trailing\nname="totally-different"\n'
  const c = 'schema_version = 1\n[pipeline]\nextends = "rtk:posthook"\n'
  assert.equal(contentFingerprint(a), contentFingerprint(b))
  assert.notEqual(contentFingerprint(a), contentFingerprint(c))
  assert.equal(contentFingerprint('not = = toml'), null)
})

test('the two identical rtk:proxy snapshots in the sample allowlist find each other; a repo never duplicates itself', () => {
  const fp = approvedFingerprints(listApproved(SAMPLE))
  const proxy = 'schema_version = 1\n\n[pipeline]\nextends = "rtk:proxy"\n'
  const dup = findDuplicate(fp, proxy, 'someone-new', 'rtk-pipeline-rtk-proxy')
  assert.ok(dup && /rtk-pipeline-rtk-proxy$/.test(dup.repo))
  const fromAikrice = findDuplicate(fp, proxy, 'aiKrice', 'rtk-pipeline-rtk-proxy')
  assert.ok(fromAikrice && fromAikrice.owner !== 'aiKrice', 'the other identical listing is reported, not itself')
  const only = new Map([[contentFingerprint(proxy), [{ owner: 'aiKrice', repo: 'rtk-pipeline-rtk-proxy', sha: 'f'.repeat(40) }]]])
  assert.equal(findDuplicate(only, proxy, 'AIKRICE', 'rtk-pipeline-rtk-proxy'), null, 'an update of the same repo is not a duplicate')
  assert.equal(findDuplicate(fp, 'schema_version = 1\n[pipeline]\nextends = "rtk:terse"\n', 'x', 'y'), null)
})

test('among open candidates the later identical one is the duplicate of the earlier, never of its own repo', () => {
  const pairs = pairOpenDuplicates([
    { number: 12, owner: 'b', repo: 'r', fp: 'X' },
    { number: 11, owner: 'a', repo: 'r', fp: 'X' },
    { number: 15, owner: 'c', repo: 'q', fp: 'Y' },
    { number: 20, owner: 'a', repo: 'r', fp: 'X' },
    { number: 21, owner: 'd', repo: 'z', fp: null },
  ])
  // #12 duplicates the earlier #11; #20 is the same repo as #11, so it is an update; #21 does not parse
  assert.deepEqual(pairs, [{ number: 12, of: { number: 11, owner: 'a', repo: 'r' } }])
})
