/**
 * Декораторы записей лорбука CCv3 и логика ключей (bot-assembly-spec §4.1):
 * строки `@@имя аргументы` в начале `content` (спека CCv3, «Decorators») переводятся в
 * обычные поля записи и `extensions` до отбора — их понимают обе подачи (классика и v2).
 * `@@@имя` — запасной декоратор: применяется, только если предыдущий не поддержан.
 *
 * Поддержаны: `activate`, `dont_activate`, `depth`, `role`, `position`, `scan_depth`,
 * `activate_only_after`, `activate_only_every`, `additional_keys`, `exclude_keys`,
 * `keep_activate_after_match`, `dont_activate_after_match`, `is_greeting`.
 * Читаются и намеренно ничего не делают (у нас нет такого места): `instruct_depth` (нет
 * instruct-режима), `ignore_on_max_context` (вытеснение — бюджетом книги), `is_user_icon`,
 * `disable_ui_prompt` (UI-флаги чужих фронтов).
 */
import type { Lorebook, LorebookEntry } from './lorebook.js'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface Decorator {
  name: string
  args: string
  /** `@@@` — запасной. */
  fallback: boolean
}

export const SUPPORTED_DECORATORS: readonly string[] = [
  'activate', 'dont_activate', 'depth', 'role', 'position', 'scan_depth', 'activate_only_after', 'activate_only_every',
  'additional_keys', 'exclude_keys', 'keep_activate_after_match', 'dont_activate_after_match', 'is_greeting',
  'instruct_depth', 'ignore_on_max_context', 'is_user_icon', 'disable_ui_prompt',
]

/** «Навсегда» для `hold`/`pause` (держать после срабатывания / больше не срабатывать). */
export const FOREVER = 1_000_000

/** Декораторы в начале текста и текст без них. */
export function parseDecorators(content: string): { decorators: Decorator[]; content: string } {
  const lines = content.split('\n')
  const decorators: Decorator[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^(@@@?)([a-z_]+)(?:\s+(.*))?$/.exec(lines[i]!.trim())
    if (!m) break
    decorators.push({ name: m[2]!, args: (m[3] ?? '').trim(), fallback: m[1] === '@@@' })
  }
  return decorators.length ? { decorators, content: lines.slice(i).join('\n') } : { decorators, content }
}

/** Применённые декораторы: запасной — только после неподдержанного основного. */
export function effectiveDecorators(list: readonly Decorator[]): Decorator[] {
  const out: Decorator[] = []
  let lastUnsupported = false
  for (const d of list) {
    const ok = SUPPORTED_DECORATORS.includes(d.name)
    if (d.fallback) {
      if (lastUnsupported && ok) {
        out.push(d)
        lastUnsupported = false
      }
      continue
    }
    if (ok) out.push(d)
    lastUnsupported = !ok
  }
  return out
}

const csv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean)
const int = (s: string): number | undefined => {
  const n = Number(s.trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * Запись с применёнными декораторами (копия; без декораторов — та же запись):
 * `extensions.position: 4` + `depth` + `role` — «на глубине», `extensions.nr` — таймеры v2.
 */
export function withDecorators(entry: LorebookEntry): LorebookEntry {
  if (typeof entry.content !== 'string' || !entry.content.trimStart().startsWith('@@')) return entry
  const { decorators, content } = parseDecorators(entry.content.trimStart())
  const used = effectiveDecorators(decorators)
  const out: LorebookEntry = { ...entry, content }
  const ext: Record<string, unknown> = { ...(isRecord(entry.extensions) ? entry.extensions : {}) }
  const nr: Record<string, unknown> = { ...(isRecord(ext.nr) ? ext.nr : {}) }
  const keys = Array.isArray(entry.keys) ? [...(entry.keys as unknown[])] : []
  for (const d of used) {
    switch (d.name) {
      case 'activate':
        out.constant = true
        break
      case 'dont_activate':
        out.enabled = false
        break
      case 'depth': {
        const n = int(d.args)
        if (n !== undefined) {
          ext.position = 4
          ext.depth = n
        }
        break
      }
      case 'role':
        if (['system', 'user', 'assistant'].includes(d.args)) ext.role = d.args
        break
      case 'position':
        // before_desc / after_desc / personality / scenario → до или после карточки.
        out.position = d.args === 'before_desc' ? 'before_char' : 'after_char'
        break
      case 'scan_depth': {
        const n = int(d.args)
        if (n) nr.scan = Array.from({ length: n }, () => 1)
        break
      }
      case 'activate_only_after': {
        const n = int(d.args)
        if (n) nr.since = n
        break
      }
      case 'activate_only_every': {
        const n = int(d.args)
        if (n) nr.every = n
        break
      }
      case 'additional_keys':
        keys.push(...csv(d.args))
        break
      case 'exclude_keys':
        nr.exclude = [...(Array.isArray(nr.exclude) ? (nr.exclude as unknown[]) : []), ...csv(d.args)]
        break
      case 'keep_activate_after_match':
        nr.hold = FOREVER
        break
      case 'dont_activate_after_match':
        nr.pause = FOREVER
        break
      case 'is_greeting': {
        const n = int(d.args)
        if (n !== undefined) nr.greeting = n
        break
      }
      default:
        // instruct_depth, ignore_on_max_context, is_user_icon, disable_ui_prompt — читаются, места нет.
        break
    }
  }
  if (keys.length) out.keys = keys
  if (Object.keys(nr).length) ext.nr = nr
  out.extensions = ext
  return out
}

/** Книга с применёнными декораторами записей (копия только если есть что менять). */
export function bookWithDecorators<B extends Lorebook>(book: B): B {
  if (!Array.isArray(book.entries)) return book
  let changed = false
  const entries = (book.entries as unknown[]).map((e) => {
    if (!isRecord(e)) return e
    const n = withDecorators(e as LorebookEntry)
    if (n !== e) changed = true
    return n
  })
  return changed ? { ...book, entries } : book
}

// ────────────────────────────────────────────────────────────────────────────
// Логика вторичных ключей (`extensions.selectiveLogic` ST) и регэкспы (`use_regex` CCv3)
// ────────────────────────────────────────────────────────────────────────────

/** 0 — AND ANY (по умолчанию спеки CCv3), 1 — NOT ALL, 2 — NOT ANY, 3 — AND ALL. */
export type SelectiveLogic = 0 | 1 | 2 | 3

export function selectiveLogicOf(entry: LorebookEntry): SelectiveLogic {
  const ext = isRecord(entry.extensions) ? entry.extensions : {}
  const v = Number(ext.selectiveLogic ?? entry.selectiveLogic)
  return v === 1 || v === 2 || v === 3 ? v : 0
}

/** Вторичные ключи прошли по логике записи; пустой список — проходят. */
export function secondaryPass(logic: SelectiveLogic, hits: readonly boolean[]): boolean {
  if (!hits.length) return true
  const any = hits.some(Boolean)
  const all = hits.every(Boolean)
  return logic === 0 ? any : logic === 1 ? !all : logic === 2 ? !any : all
}

/** Регэксп-ключи записи: `use_regex` CCv3 (поле или `extensions`). */
export function useRegexOf(entry: LorebookEntry): boolean {
  const ext = isRecord(entry.extensions) ? entry.extensions : {}
  return entry.use_regex === true || ext.use_regex === true
}

/** Ключ как регэксп: `/тело/флаги` или тело целиком; кривой — `undefined` (ключ не срабатывает). */
export function keyRegExp(key: string, caseSensitive: boolean): RegExp | undefined {
  const k = key.trim()
  if (!k) return undefined
  const m = /^\/(.+)\/([a-z]*)$/s.exec(k)
  try {
    if (m) return new RegExp(m[1]!, m[2]!.includes('i') || caseSensitive ? m[2]! : `${m[2]}i`)
    return new RegExp(k, caseSensitive ? 'u' : 'iu')
  } catch {
    return undefined
  }
}
