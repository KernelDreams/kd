/**
 * Мелкие зависимости vendoring-файлов OpenClaw (edit-diff, edit-replacements):
 * `normalizeToLF`/`detectLineEnding` (src/agents/line-endings.ts),
 * `levenshteinDistance` (src/shared/levenshtein-distance.ts),
 * `truncateUtf16Safe` (@openclaw/normalization-core/utf16-slice).
 * OpenClaw, Copyright (c) OpenClaw Foundation, MIT — см. NOTICE.
 */

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n')
  const lf = content.indexOf('\n')
  if (lf === -1 || crlf === -1) return '\n'
  return crlf < lf ? '\r\n' : '\n'
}

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0
  if (!left || !right) return left.length + right.length
  const row = new Uint32Array(right.length + 1)
  for (let i = 0; i <= right.length; i++) row[i] = i
  for (let l = 0; l < left.length; l++) {
    let diagonal = l
    row[0] = l + 1
    const code = left.charCodeAt(l)
    for (let r = 0; r < right.length; r++) {
      const cost = code === right.charCodeAt(r) ? 0 : 1
      const above = row[r + 1]!
      row[r + 1] = Math.min(row[r]! + 1, above + 1, diagonal + cost)
      diagonal = above
    }
  }
  return row[right.length]!
}

/** Срез до `max` UTF-16 единиц, не разрывая суррогатную пару. */
export function truncateUtf16Safe(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end)
}
