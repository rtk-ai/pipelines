import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fenceFor, fenced, cell } from '../scripts/lib/fence.mjs'
import { renderBody } from '../scripts/report.mjs'
import { readFileSync } from 'node:fs'

test('fence is always longer than the longest backtick run', () => {
  assert.equal(fenceFor('plain'), '```')
  assert.equal(fenceFor('a ``` b'), '````')
  assert.equal(fenceFor('x `````` y'), '```````')
  const body = fenced('```\nescape attempt\n```', 'text')
  assert.ok(body.startsWith('````text\n'))
  assert.ok(body.endsWith('\n````'))
})

test('table cells neutralise pipes and newlines', () => {
  assert.equal(cell('a|b\nc'), '`a\\|b c`')
  assert.equal(cell(null), '—')
})

test('report body keeps author text inside fences and rejects bad identifiers', () => {
  const report = {
    key: 'tester/rtk-pipeline-x@0123456789abcdef0123456789abcdef01234567', rtk: 'v1.0.1', tier: 'text', label: 'needs-reading', size_bytes: 10,
    text_blocks: [{ kind: 'directive.text', owner: 'd', chars: 30, text: '</script><script>alert(1)</script> ```' }], text_chars: 30,
    egress: [], overrides: [], control_rules: {}, extends: [], rule_summary: [], refusals: [], add_exit_code: 0, add_stdout: 'ok', add_stderr: '',
    repo: { description: '<img src=x onerror=alert(1)> | pipe', stars: 1, forks: 0 },
  }
  const md = renderBody(report)
  assert.ok(md.includes('````text\n</script><script>alert(1)</script> ```\n````'))
  assert.ok(md.includes('https://github.com/tester/rtk-pipeline-x/blob/0123456789abcdef0123456789abcdef01234567/pipeline.toml'))
  const bad = renderBody({ ...report, key: 'evil/../x@notasha' })
  assert.ok(bad.includes('(invalid identifiers)'))
  assert.ok(!bad.includes('github.com/evil'))
})
