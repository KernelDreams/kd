/**
 * Строка `/runz …` → argv. Без шелла: только пробелы, кавычки и `\`, никаких
 * подстановок — `/runz` должен делать ровно то же, что тулза `runz`.
 *
 * - `'…'` — литерал;
 * - `"…"` — `\"` и `\\` внутри экранируются, прочие `\` остаются как есть;
 * - `\x` вне кавычек — литерал `x`.
 */

export function splitArgs(input: string): string[] | Error {
  const out: string[] = []
  let current = ''
  let inToken = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) {
      if (inToken) out.push(current)
      current = ''
      inToken = false
      i++
      continue
    }
    inToken = true
    if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return new Error('unterminated single quote')
      current += input.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (ch === '"') {
      i++
      let closed = false
      while (i < input.length) {
        const c = input[i]!
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
          current += input[i + 1]
          i += 2
          continue
        }
        current += c
        i++
      }
      if (!closed) return new Error('unterminated double quote')
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 2
      continue
    }
    current += ch
    i++
  }
  if (inToken) out.push(current)
  return out
}
