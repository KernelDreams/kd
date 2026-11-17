/**
 * Вызов тула: командная строка → сырой вызов (§5), одна нормализация для всех путей (§9.6:
 * нативный вызов, mdz / JSON через `--params`, командная строка), исправленная команда (§3).
 * Без ввода-вывода: вид слова (`kindOf`) приходит снаружи.
 */

import { appliesTo, defaultAction, type ToolDecl, type ToolField } from './decl.js'
import { KdError, nearest } from './errors.js'

export type KdValue = string | number | boolean | string[]

/** Вызов тула — один объект на все пути. */
export interface ToolCall {
  tool: string
  action?: string
  params: Record<string, KdValue>
}

/** Сырой вызов: значения как пришли (строки командной строки, JSON, mdz). */
export interface RawCall {
  tool: string
  action?: string | null
  params: Record<string, unknown>
}

export interface SplitOptions {
  /** Виды слова (`url`, `file`, `task`, `host`…) — по правилам ссылок и файловой системе. */
  kindOf?: (word: string) => string[]
}

/** Флаги и слова командной строки после имени тула. */
export interface Tokens {
  flags: Array<[string, string | true | false]>
  /** Слова до `--`. */
  words: string[]
  /** Слова после `--` — всегда текст. */
  literal: string[]
}

/** Разбить argv тула: `--k=v`, `--k v` (если поле ждёт значение), `--no-k`, `-x`, `--`. */
export function tokenize(argv: readonly string[], decl?: ToolDecl): Tokens {
  const out: Tokens = { flags: [], words: [], literal: [] }
  const byName = new Map(decl?.fields.map((f) => [f.name, f]) ?? [])
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--') {
      out.literal.push(...argv.slice(i + 1))
      break
    }
    if (t.startsWith('--') && t.length > 2) {
      const body = t.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        out.flags.push([body.slice(0, eq), body.slice(eq + 1)])
        continue
      }
      const f = byName.get(body)
      if (!f && body.startsWith('no-') && (byName.size === 0 || byName.has(body.slice(3)))) {
        out.flags.push([body.slice(3), false])
        continue
      }
      const next = argv[i + 1]
      if (f && !decl?.legacy && f.schema.type !== 'boolean' && next !== undefined && next !== '--' && !next.startsWith('--')) {
        out.flags.push([body, next])
        i++
        continue
      }
      out.flags.push([body, true])
      continue
    }
    if (/^-[A-Za-z]$/.test(t)) {
      out.flags.push([t.slice(1), true])
      continue
    }
    out.words.push(t)
  }
  return out
}

/** Флаги → параметры: повтор флага — список. */
function flagParams(flags: Tokens['flags']): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of flags) {
    if (!(k in params)) params[k] = v
    else {
      const prev = params[k]
      params[k] = [...(Array.isArray(prev) ? prev : [prev]), v]
    }
  }
  return params
}

const kindOfField = (f: ToolField): string | undefined => f.schema['x-ui'].kind

/**
 * Слова командной строки → сырой вызов (§5): действие — только первым или последним словом
 * (у тула с `$rest` — только первым); остальные слова — по `$kind`, затем по `$pos`; свободный
 * текст — только полю `$rest`. Лишнее слово — код 2 с подсказкой.
 */
export function splitWords(decl: ToolDecl, tokens: Tokens, opts: SplitOptions = {}): RawCall {
  const params = flagParams(tokens.flags)
  if (decl.legacy) {
    // Тул без объявления — по-старому: слова в `$_`.
    const all = [...tokens.words, ...tokens.literal]
    if (all.length) params._ = all.length === 1 ? all[0]! : all
    return { tool: decl.name, params }
  }
  const actionNames = decl.actions.map((a) => a.name)
  const words = [...tokens.words]
  // У тула с полем `$rest` последнее слово — уже текст: действие только первым.
  const hasRest = decl.fields.some((f) => f.schema['x-ui'].rest)
  let action: string | undefined
  if (words.length && actionNames.includes(words[0]!)) action = words.shift()
  else if (words.length && !hasRest && actionNames.includes(words[words.length - 1]!)) action = words.pop()
  if (typeof params[decl.actionArg] === 'string' && actionNames.includes(params[decl.actionArg] as string)) {
    if (action && action !== params[decl.actionArg]) throw new KdError(2, `${decl.name}: два действия — «${action}» словом и --${decl.actionArg}=${String(params[decl.actionArg])}`)
    action = params[decl.actionArg] as string
    delete params[decl.actionArg]
  }
  const act = action ?? defaultAction(decl)
  const applicable = decl.fields.filter((f) => appliesTo(f, act))
  const rest = applicable.find((f) => f.schema['x-ui'].rest)
  const filled = new Set(Object.keys(params))
  const put = (f: ToolField, w: string): void => {
    if (f.schema.type === 'array') params[f.name] = [...((params[f.name] as string[] | undefined) ?? []), w]
    else params[f.name] = w
    filled.add(f.name)
  }
  const free = (f: ToolField): boolean => !f.schema['x-ui'].rest && (f.schema.type === 'array' || !filled.has(f.name))
  const byPos = applicable.filter((f) => f.schema['x-ui'].pos !== undefined).sort((a, b) => a.schema['x-ui'].pos! - b.schema['x-ui'].pos!)
  let left: string[] = []
  if (rest) {
    // Свободный текст: позиционные поля берут ведущие слова по порядку, остальное — тексту.
    let i = 0
    for (const f of byPos) {
      if (i >= words.length) break
      if (free(f)) put(f, words[i++]!)
    }
    const text = [...words.slice(i), ...tokens.literal]
    if (text.length) {
      if (rest.schema.type === 'array') params[rest.name] = [...((params[rest.name] as string[] | undefined) ?? []), ...text]
      else params[rest.name] = [...(typeof params[rest.name] === 'string' ? [params[rest.name] as string] : []), ...text].join(' ')
    }
  } else {
    const all = [...words, ...tokens.literal]
    // По виду: слово, вид которого назвало поле.
    for (const w of all) {
      const kinds = opts.kindOf?.(w) ?? []
      const f = kinds.length ? applicable.find((x) => free(x) && kindOfField(x) !== undefined && kinds.includes(kindOfField(x)!)) : undefined
      if (f) put(f, w)
      else left.push(w)
    }
    // Затем по позиции.
    const rem: string[] = []
    for (const w of left) {
      const f = byPos.find(free)
      if (f) put(f, w)
      else rem.push(w)
    }
    left = rem
  }
  if (left.length) {
    // Слово, похожее на действие, — первым в подсказке (`kd x <url> pubish`).
    const w = left.find((x) => nearest(x, actionNames)) ?? left[0]!
    const near = nearest(w, actionNames) ?? nearest(w, applicable.map((f) => f.name))
    const hint = near ? `«${w}» — может быть «${near}»?` : `слово «${w}» не легло ни в одно поле`
    const fixed = near && actionNames.includes(near) ? { tool: decl.name, action: near, params: stripLeft(params) } : undefined
    throw new KdError(2, `${decl.name}: ${hint}`, { hint, ...(fixed ? { fixCall: fixed } : {}), ...(near ? { choices: [near] } : {}) })
  }
  return { tool: decl.name, ...(action ? { action } : {}), params }
}

const stripLeft = (p: Record<string, unknown>): Record<string, unknown> => ({ ...p })

export interface Normalized {
  call: ToolCall
  /** Обязательные поля действия без значения (в терминале — вопрос, без него — код 2). */
  missing: string[]
}

function coerce(decl: ToolDecl, f: ToolField, v: unknown): KdValue {
  const bad = (what: string): KdError => new KdError(2, `${decl.name}: --${f.name} — ${what}`, { field: f.name, hint: `--${f.name}: ${what}` })
  const s = f.schema
  if (s.type === 'boolean') {
    if (v === true || v === 'true' || v === '' || v === 1 || v === '1') return true
    if (v === false || v === 'false' || v === 0 || v === '0') return false
    throw bad(`ждёт да/нет, а не ${JSON.stringify(v)}`)
  }
  if (s.type === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n)) throw bad(`ждёт число, а не ${JSON.stringify(v)}`)
    if (s.minimum !== undefined && n < s.minimum) throw bad(`не меньше ${s.minimum}`)
    if (s.maximum !== undefined && n > s.maximum) throw bad(`не больше ${s.maximum}`)
    return n
  }
  if (s.type === 'array') {
    const items = Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? x.split(',') : [x])) : typeof v === 'string' ? v.split(',') : [v]
    return items.filter((x) => x !== null && x !== undefined).map((x) => String(x).trim()).filter((x) => x !== '')
  }
  if (v === true) throw bad('ждёт значение (--' + f.name + '=…)')
  if (Array.isArray(v)) throw bad('одно значение, а пришёл список')
  if (typeof v === 'object') throw bad('строка, а пришёл объект')
  const str = String(v)
  if (s.enum && str !== '' && !s.enum.includes(str)) {
    const near = nearest(str, s.enum)
    throw new KdError(2, `${decl.name}: --${f.name}=${str} — есть: ${s.enum.join(', ')}`, { field: f.name, hint: near ? `может быть ${near}?` : `одно из: ${s.enum.join(', ')}`, choices: s.enum })
  }
  return str
}

const isEmpty = (v: KdValue | undefined): boolean => v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/**
 * Одна нормализация (§9.6): действие, проверка полей, приведение к типу, умолчания.
 * `null` и отсутствие — одно и то же (берётся умолчание); пустая строка — значение (у обязательного — пусто).
 */
export function normalize(decl: ToolDecl, raw: RawCall): Normalized {
  if (decl.legacy) {
    const params: Record<string, KdValue> = {}
    for (const [k, v] of Object.entries(raw.params)) if (v !== null && v !== undefined) params[k] = v as KdValue
    return { call: { tool: decl.name, params }, missing: [] }
  }
  const names = decl.actions.map((a) => a.name)
  let action = raw.action ?? undefined
  if (action === undefined && typeof raw.params[decl.actionArg] === 'string' && !decl.fields.some((f) => f.name === decl.actionArg)) {
    action = raw.params[decl.actionArg] as string
  }
  if (action !== undefined) {
    if (!names.includes(action)) {
      const near = nearest(action, names)
      throw new KdError(2, `${decl.name}: действия «${action}» нет — есть: ${names.join(', ') || 'никаких'}`, { hint: near ? `«${action}» — может быть «${near}»?` : `действия: ${names.join(', ')}`, choices: names })
    }
  } else if (names.length) {
    action = defaultAction(decl)
    if (!action) throw new KdError(2, `${decl.name}: нужно действие — ${names.join(', ')}`, { hint: `действия: ${names.join(', ')}`, choices: names })
  }
  const byName = new Map(decl.fields.map((f) => [f.name, f]))
  const params: Record<string, KdValue> = {}
  for (const [k0, v] of Object.entries(raw.params)) {
    const k = decl.aliases?.[k0] ?? k0
    if (k === decl.actionArg && !byName.has(k)) continue
    if (v === null || v === undefined) continue
    const f = byName.get(k)
    if (!f) {
      const near = nearest(k, [...byName.keys()])
      throw new KdError(2, `${decl.name}: поля --${k} нет${near ? ` (может, --${near}?)` : ''}`, { field: k, hint: near ? `может, --${near}?` : `поля: ${[...byName.keys()].map((n) => `--${n}`).join(' ')}` })
    }
    if (!appliesTo(f, action)) throw new KdError(2, `${decl.name}: --${k} не для действия «${action}» (только ${(f.schema['x-ui'].for ?? []).join(', ')})`, { field: k })
    params[k] = coerce(decl, f, v)
  }
  const missing: string[] = []
  for (const f of decl.fields) {
    if (!appliesTo(f, action)) continue
    if (params[f.name] === undefined && f.schema.default !== undefined) params[f.name] = f.schema.default as KdValue
    if (f.required && isEmpty(params[f.name])) missing.push(f.name)
  }
  return { call: { tool: decl.name, ...(action ? { action } : {}), params }, missing }
}

/** Слово для шелла: в одинарных кавычках, если нужно. */
export function shellWord(s: string): string {
  if (s !== '' && /^[\p{L}\p{N}_@%+=:,./~-]+$/u.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Канонический вид вызова: `kd <тул> <действие> <позиционные…> --поле=значение`. */
export function formatCommand(decl: ToolDecl, call: { action?: string; params: Record<string, unknown> }, opts: { placeholders?: string[] } = {}): string {
  const parts = ['kd', decl.name]
  if (call.action && call.action !== defaultAction(decl)) parts.push(call.action)
  const byPos = decl.fields.filter((f) => f.schema['x-ui'].pos !== undefined && appliesTo(f, call.action)).sort((a, b) => a.schema['x-ui'].pos! - b.schema['x-ui'].pos!)
  const used = new Set<string>()
  for (const f of byPos) {
    const v = call.params[f.name]
    if (typeof v !== 'string' || v === '' || (f.schema.default !== undefined && v === f.schema.default)) break
    if (decl.actions.some((a) => a.name === v)) break
    parts.push(shellWord(v))
    used.add(f.name)
  }
  for (const f of decl.fields) {
    if (used.has(f.name)) continue
    const v = call.params[f.name]
    if (v === undefined || (f.schema.default !== undefined && JSON.stringify(v) === JSON.stringify(f.schema.default))) continue
    if (v === true) parts.push(`--${f.name}`)
    else if (v === false) parts.push(`--no-${f.name}`)
    else parts.push(`--${f.name}=${shellWord(Array.isArray(v) ? v.join(',') : String(v))}`)
  }
  for (const k of Object.keys(call.params)) if (!decl.fields.some((f) => f.name === k)) parts.push(`--${k}=${shellWord(String(call.params[k]))}`)
  for (const p of opts.placeholders ?? []) {
    const f = decl.fields.find((x) => x.name === p)
    parts.push(`--${p}=<${f?.schema.title?.split(':')[0] ?? p}>`)
  }
  return parts.join(' ')
}

/** Ошибка недостающих полей (без терминала — код 2 с исправленной командой). */
export function missingError(decl: ToolDecl, n: Normalized): KdError {
  const what = n.missing.map((m) => `--${m}`).join(', ')
  return new KdError(2, `${decl.name}: не хватает ${what}`, { field: n.missing[0]!, hint: `нужно: ${what}`, fix: formatCommand(decl, n.call, { placeholders: n.missing }) })
}
