// Author-controlled text only ever appears inside a fenced block whose fence
// is longer than any backtick run in the content, so it cannot close early.

export function fenceFor(text) {
  let longest = 0
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function fenced(text, lang = '') {
  const f = fenceFor(text)
  const body = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '')
  return `${f}${lang}\n${body}\n${f}`
}

/** One cell of a markdown table: pipes and newlines neutralised, inline code. */
export function cell(value) {
  if (value === null || value === undefined || value === '') return '—'
  const s = String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
  const f = fenceFor(s)
  return f.length > 3 ? `${f} ${s} ${f}` : `\`${s}\``
}
