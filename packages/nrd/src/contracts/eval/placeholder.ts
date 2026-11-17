// ${...} placeholder grammar (§7).
// Brace-balanced scanner, NO regex. Recognises, does NOT resolve.
//
// Дом грамматики выражений ( §0.2): `${}` принадлежит eval, не кодеку.
// nr-md лексит интерполяцию как span (где она и докуда), а ЧТО значит текст
// между скобками — этот модуль, вместе с типами Placeholder/PlaceholderExpr/
// PlaceholderArg/PathSegment. Сигил захардкожен локально здесь (§0.5): лексер
// scanPlaceholders отделён от walk/resolve, параметризация — аддитивно.

// ---------- Типы выражений (§7) ----------

export type PathSegment =
  | { kind: 'name'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'placeholder'; value: Placeholder }

export type PlaceholderArg =
  | { kind: 'path'; segments: PathSegment[] }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'placeholder'; value: Placeholder }

export type PlaceholderExpr =
  | { kind: 'path'; segments: PathSegment[] }
  | {
      kind: 'call'
      name: string
      args: PlaceholderArg[]
      /**
       * Path-сегменты после вызова: `fn(...).a.b` (§7.1, resolve-fix §1.7).
       * Поле аддитивное — прежняя форма `fn(...)` его просто не несёт.
       */
      path?: PathSegment[]
    }

export interface Placeholder {
  /** Raw text between `${` and `}` (after balanced match). */
  raw: string
  /** Parsed structure of the expression. */
  expr: PlaceholderExpr
  /** Start offset in the containing raw value (inclusive of `${`). */
  start: number
  /** End offset in the containing raw value (exclusive of `}`+1). */
  end: number
}

// ---------- Character predicates ----------

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */
}
function isAlphaNumDash(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 /* _ */ ||
    c === 45 /* - */
  )
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/**
 * Делимитер строкового литерала (§7.1). Одинарная кавычка равноправна двойной —
 * симметрия с json5-атрибутами, где `'file'` легально (resolve-fix §1.4).
 */
function isQuote(c: string | undefined): boolean {
  return c === '"' || c === "'"
}

/**
 * Пропустить строковый литерал, открытый кавычкой `s[i]`. Возвращает индекс
 * ПОСЛЕ закрывающей кавычки (или конец строки, если литерал не закрыт).
 */
function skipString(s: string, i: number): number {
  const q = s[i]
  i++
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (s[i] === q) return i + 1
    i++
  }
  return i
}

// ---------- Brace matcher ----------

/**
 * Given that the `${` opens at position `openDollar`, return the offset of the
 * matching `}` in `s` (or -1 if unbalanced).
 *
 * Scanner is brace-balanced and aware of:
 * - escape sequences `\X` (consume both chars)
 * - nested `${...}` (increment depth; a bare `{` is NOT counted — §7.1 has no
 *   bare braces outside string literals)
 * - quoted strings, double or single (skip over content; honour `\"` / `\'`)
 */
export function findMatchingBrace(s: string, fromAfterOpen: number): number {
  let depth = 1
  let i = fromAfterOpen
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (isQuote(c)) {
      i = skipString(s, i)
      continue
    }
    if (c === '$' && i + 1 < s.length && s[i + 1] === '{') {
      depth++
      i += 2
      continue
    }
    if (c === '}') {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

/**
 * Scan a value or body string for `${...}` placeholders and recognise their
 * structure. Returns placeholders in source order.
 *
 * - `\${` is a literal `${` and is NOT a placeholder.
 * - Unbalanced `${` is silently treated as literal text.
 */
export function scanPlaceholders(s: string): Placeholder[] {
  const out: Placeholder[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '$' && s[i + 2] === '{') {
      // literal ${
      i += 3
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    // NB: НЕТ skip кавычек. resolve сканирует ВЕСЬ текст — ${} внутри "..." в
    // произвольном тексте (JSON, проза) резолвится (ревью 07.07 №2, инцидент
    // $json). Кавычки — грамматика ТОЛЬКО в скаляр-литерале (coerce) и в
    // строковом аргументе (parseArgs), не в общем скане.
    if (c === '$' && s[i + 1] === '{') {
      const start = i
      const end = findMatchingBrace(s, i + 2)
      if (end === -1) {
        // Unbalanced — treat as literal text, skip the `$`.
        i++
        continue
      }
      const raw = s.slice(i + 2, end)
      const expr = parseExpr(raw)
      out.push({ raw, expr, start, end: end + 1 })
      i = end + 1
      continue
    }
    i++
  }
  return out
}

// ---------- EXPR parser ----------

/**
 * Parse the contents of `${...}` into a structured expression.
 *
 * Forms (§7.1):
 * - path:  `a`, `a.b`, `a.b.0`, `a.${b}`
 * - call:  `fn(arg, arg, ...)` (call name followed immediately by `(`)
 * - call + path: `fn(...).a.b` — адресация внутрь дерева, которое вернул вызов
 *   (resolve-fix §1.7; без неё §1.6 половинчат: дерево есть, входа в него нет)
 * - nested: `${...}` inside path segment or call argument
 */
export function parseExpr(input: string): PlaceholderExpr {
  const s = stripWhitespace(input)
  if (s.length === 0) {
    throw new Error(`Empty placeholder expression`)
  }
  // Try call: identifier '(' ... ')' covering the whole expression (or its head).
  const callPrefix = readBareIdent(s, 0)
  if (callPrefix && s[callPrefix.next] === '(') {
    const close = findMatchingParen(s, callPrefix.next + 1)
    if (close === -1) {
      // Скобка не закрылась потому, что литерал съел остаток: назвать причину.
      // Прежде такой токен доезжал до парсера путей и жаловался на путь (§1.4).
      const q = unclosedQuote(s, callPrefix.next + 1)
      if (q) {
        throw new Error(`Unclosed string literal (${q}) in call arguments: ${s}`)
      }
    }
    if (close === s.length - 1) {
      const args = parseArgs(s.slice(callPrefix.next + 1, close))
      return { kind: 'call', name: callPrefix.name, args }
    }
    if (close !== -1 && s[close + 1] === '.') {
      const args = parseArgs(s.slice(callPrefix.next + 1, close))
      return {
        kind: 'call',
        name: callPrefix.name,
        args,
        path: parsePathSegments(s.slice(close + 2)),
      }
    }
  }
  return { kind: 'path', segments: parsePathSegments(s) }
}

function stripWhitespace(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && (s[start] === ' ' || s[start] === '\t' || s[start] === '\n' || s[start] === '\r')) start++
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t' || s[end - 1] === '\n' || s[end - 1] === '\r')) end--
  return s.slice(start, end)
}

/** Read a bare identifier `[A-Za-z_][A-Za-z0-9_-]*`. No dot, no escape. */
function readBareIdent(s: string, i: number): { name: string; next: number } | null {
  if (i >= s.length) return null
  if (!isAlpha(s.charCodeAt(i))) return null
  let j = i + 1
  while (j < s.length && isAlphaNumDash(s.charCodeAt(j))) j++
  return { name: s.slice(i, j), next: j }
}

/** Read a path segment name with `\.` escape for literal dot (§7.1). */
function readSegmentName(s: string, i: number): { name: string; next: number } | null {
  if (i >= s.length) return null
  if (!isAlpha(s.charCodeAt(i))) return null
  let out = s[i]
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\' && s[j + 1] === '.') {
      out += '.'
      j += 2
      continue
    }
    if (isAlphaNumDash(s.charCodeAt(j))) {
      out += s[j]
      j++
      continue
    }
    break
  }
  return { name: out, next: j }
}

function readIndex(s: string, i: number): { value: number; next: number } | null {
  if (i >= s.length || !isDigit(s.charCodeAt(i))) return null
  let j = i
  while (j < s.length && isDigit(s.charCodeAt(j))) j++
  return { value: Number(s.slice(i, j)), next: j }
}

/**
 * Кавычка незакрытого строкового литерала в `s` начиная с `from` (или undefined,
 * если все литералы закрыты). Нужна только для диагностики (§1.4).
 */
function unclosedQuote(s: string, from: number): string | undefined {
  let i = from
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (isQuote(s[i])) {
      const q = s[i]
      let j = i + 1
      let closed = false
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          j += 2
          continue
        }
        if (s[j] === q) {
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) return q
      i = j
      continue
    }
    i++
  }
  return undefined
}

/**
 * Brace matcher for `(`/`)` with awareness of strings, escapes and `${...}`.
 * Returns the index of the matching `)`.
 */
function findMatchingParen(s: string, fromAfterOpen: number): number {
  let depth = 1
  let i = fromAfterOpen
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) { i += 2; continue }
    if (isQuote(c)) {
      i = skipString(s, i)
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      const close = findMatchingBrace(s, i + 2)
      if (close === -1) return -1
      i = close + 1
      continue
    }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

function parsePathSegments(s: string): PathSegment[] {
  const segments: PathSegment[] = []
  let i = 0
  while (i < s.length) {
    // Nested placeholder as segment.
    if (s[i] === '$' && s[i + 1] === '{') {
      const close = findMatchingBrace(s, i + 2)
      if (close === -1) {
        throw new Error(`Unbalanced \${} in path: ${s}`)
      }
      const inner = s.slice(i + 2, close)
      const innerRaw = inner
      segments.push({
        kind: 'placeholder',
        value: { raw: innerRaw, expr: parseExpr(inner), start: i, end: close + 1 },
      })
      i = close + 1
    } else {
      const num = readIndex(s, i)
      if (num) {
        segments.push({ kind: 'index', value: num.value })
        i = num.next
      } else {
        const nm = readSegmentName(s, i)
        if (!nm) {
          throw new Error(`Invalid path segment at offset ${i} of "${s}"`)
        }
        segments.push({ kind: 'name', value: nm.name })
        i = nm.next
      }
    }
    if (i < s.length) {
      if (s[i] !== '.') {
        throw new Error(`Expected '.' between path segments at offset ${i} of "${s}"`)
      }
      i++
    }
  }
  if (segments.length === 0) {
    throw new Error(`Empty path expression`)
  }
  return segments
}

function parseArgs(s: string): PlaceholderArg[] {
  const args: PlaceholderArg[] = []
  if (stripWhitespace(s).length === 0) return args
  let i = 0
  while (i <= s.length) {
    // Skip leading whitespace.
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++
    const startTok = i
    let depth = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) { i += 2; continue }
      if (isQuote(c)) { i = skipString(s, i); continue }
      if (c === '$' && s[i + 1] === '{') {
        const close = findMatchingBrace(s, i + 2)
        if (close === -1) throw new Error(`Unbalanced \${} in call args: ${s}`)
        i = close + 1
        continue
      }
      if (c === '(') { depth++; i++; continue }
      if (c === ')') { depth--; i++; continue }
      if (c === ',' && depth === 0) break
      i++
    }
    let endTok = i
    while (endTok > startTok && (s[endTok - 1] === ' ' || s[endTok - 1] === '\t')) endTok--
    const tok = s.slice(startTok, endTok)
    args.push(parseSingleArg(tok))
    if (i >= s.length) break
    // Skip comma and continue.
    i++ // consume ','
  }
  return args
}

function parseSingleArg(tok: string): PlaceholderArg {
  if (tok.length === 0) {
    throw new Error(`Empty argument in call`)
  }
  // String literal — двойные и одинарные кавычки равноправны (§1.4).
  if (isQuote(tok[0])) {
    if (tok.length >= 2 && tok[tok.length - 1] === tok[0] && !isEscaped(tok, tok.length - 1)) {
      return { kind: 'literal', value: unescapeQuotedArg(tok.slice(1, -1)) }
    }
    // Токен открылся кавычкой и не закрылся: причина — литерал, а не путь.
    // Прежде такой токен уезжал в парсер путей и жаловался на «Invalid path
    // segment», уводя от настоящей ошибки (DEBT 08.08 №4).
    throw new Error(`Unclosed string literal in call argument: ${tok}`)
  }
  if (tok === 'true') return { kind: 'literal', value: true }
  if (tok === 'false') return { kind: 'literal', value: false }
  if (tok === 'null') return { kind: 'literal', value: null }
  // Number?
  if (isNumericToken(tok)) {
    const n = Number(tok)
    if (Number.isFinite(n)) return { kind: 'literal', value: n }
  }
  // Single `${...}` covering the whole token → placeholder arg.
  if (tok.startsWith('${') && tok.endsWith('}')) {
    const close = findMatchingBrace(tok, 2)
    if (close === tok.length - 1) {
      const inner = tok.slice(2, close)
      return {
        kind: 'placeholder',
        value: { raw: inner, expr: parseExpr(inner), start: 0, end: tok.length },
      }
    }
  }
  // Голый вызов `fn(...)` как аргумент — вложенная функция без ${} обёртки
  // (§C5: ${if_else(eq(mode,"a"), 1, 0)}). Обёрнутый ${fn()} тоже работает выше,
  // но избыточен (DECISIONS 07.07).
  const id = readBareIdent(tok, 0)
  if (id && tok[id.next] === '(' && tok[tok.length - 1] === ')') {
    const expr = parseExpr(tok)
    if (expr.kind === 'call') {
      return { kind: 'placeholder', value: { raw: tok, expr, start: 0, end: tok.length } }
    }
  }
  // Otherwise — path.
  return { kind: 'path', segments: parsePathSegments(tok) }
}

/** Экранирован ли символ на позиции `i` (нечётное число `\` перед ним). */
function isEscaped(s: string, i: number): boolean {
  let n = 0
  let j = i - 1
  while (j >= 0 && s[j] === '\\') {
    n++
    j--
  }
  return n % 2 === 1
}

function unescapeQuotedArg(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === '"') { out += '"'; i += 2; continue }
      if (n === "'") { out += "'"; i += 2; continue }
      if (n === '\\') { out += '\\'; i += 2; continue }
      if (n === 'n') { out += '\n'; i += 2; continue }
      if (n === 't') { out += '\t'; i += 2; continue }
      out += '\\' + n
      i += 2
      continue
    }
    out += s[i]
    i++
  }
  return out
}

function isNumericToken(s: string): boolean {
  if (s.length === 0) return false
  let i = 0
  if (s[0] === '-') i++ // leading '+' is NOT a number sign (§3)
  if (i === s.length) return false
  const digitStart = i
  let hasDigit = false
  let hasDot = false
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 48 && c <= 57) {
      hasDigit = true
    } else if (c === 46) {
      if (hasDot) return false
      hasDot = true
    } else {
      return false
    }
  }
  if (!hasDigit) return false
  // Integer with a leading zero and more than one digit -> not a number (§3):
  // "007" stays a string; bare "0" is a number. Floats (0.5) are unaffected.
  if (!hasDot && s.length - digitStart > 1 && s.charCodeAt(digitStart) === 48) return false
  return true
}
