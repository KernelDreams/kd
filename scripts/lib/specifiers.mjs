// Спецификаторы импорта в тексте: разбор и замена по контексту импорта.

/**
 * Строки в позиции импорта: `from '…'`, `import '…'`, `import('…')`, `require('…')`, `vi.mock('…')`,
 * `vi.importActual('…')`, `import.meta.resolve('…')`, `new URL('…'`, `@import '…'`, `@import url('…')`,
 * `declare module '…'`. Группы: 1 — префикс, 2 — кавычка, 3 — спецификатор.
 */
const IMPORT_RE =
  /((?:\bfrom|\bimport|\brequire|\bvi\.mock|\bvi\.doMock|\bvi\.importActual(?:<[^>]*>)?|\bimport\.meta\.resolve|\bnew URL|\bdeclare module|@import|\brequire\.resolve)\s*\(?\s*(?:url\()?\s*)(['"`])([^'"`\n]+)\2/g

/** Заменить спецификаторы в позиции импорта: fn(spec) → новый спецификатор или null (не трогать). */
export function rewriteImports(text, fn) {
  return text.replace(IMPORT_RE, (all, pre, q, spec) => {
    const next = fn(spec)
    return next == null || next === spec ? all : `${pre}${q}${next}${q}`
  })
}

/** Строгий разбор: только операторы import / export … from, import(), require(), vi.mock() с литералом. */
const STRICT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*[,)]|\brequire\s*\(\s*(['"])([^'"\n]+)\5\s*\)|\bvi\.(?:mock|doMock|importActual)(?:<[^>]*>)?\(\s*(['"])([^'"\n]+)\7/gm

/**
 * Код без содержимого строк: тело шаблонной строки и строк в кавычках заменяется пробелами,
 * кроме литерала сразу после `from` / `import` / `import(` / `require(` / `vi.mock(` — это и есть
 * спецификатор. Так текст `import x from 'y'` внутри строки (шаблон артефакта, фикстура теста)
 * не считается импортом. Комментарии `//` и `/* *\/` тоже вычищаются. Переводы строк сохраняются.
 */
export function codeOnly(text) {
  let out = ''
  let i = 0
  const n = text.length
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const SPEC_BEFORE = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\bvi\.(?:mock|doMock|importActual)(?:<[^>]*>)?\s*\()\s*$/
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') { const j = text.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(text.slice(i, e)); i = e; continue }
    if (c === '/' && d === '*') { const j = text.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(text.slice(i, e)); i = e; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      const e = Math.min(j + 1, n)
      const keep = SPEC_BEFORE.test(out.slice(-40))
      out += keep ? text.slice(i, e) : c + blank(text.slice(i + 1, e - 1)) + (text[e - 1] === c ? c : '')
      i = e
      continue
    }
    if (c === '`') {
      // шаблонная строка целиком (с вложенными ${…} — по счётчику скобок) — не код для стража
      let j = i + 1
      let depth = 0
      while (j < n) {
        const t = text[j]
        if (t === '\\') { j += 2; continue }
        if (depth === 0 && t === '`') break
        if (t === '$' && text[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0 && t === '{') depth++
        else if (depth > 0 && t === '}') depth--
        j++
      }
      const e = Math.min(j + 1, n)
      out += '`' + blank(text.slice(i + 1, e - 1)) + (text[e - 1] === '`' ? '`' : '')
      i = e
      continue
    }
    out += c
    i++
  }
  return out
}

/** Список спецификаторов в операторах импорта (строгий разбор, для стража): только код, не строки. */
export function listImports(text) {
  const out = []
  for (const m of codeOnly(text).matchAll(STRICT_RE)) out.push(m[2] ?? m[4] ?? m[6] ?? m[8])
  return out
}
