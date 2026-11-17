/**
 * Управляемый контекст сессии (v1.32, front-context-spec §4): мета `context`
 * (`pinned`/`dropped`/`cleared` — id вызовов тулов) и заглушка с адресом для
 * выкинутого результата. Общее для бэкендов (nr, ACP) и фронта: формат
 * заглушки — контракт, модель по нему понимает, что и как перечитать.
 */

import type { SessionContextMeta, SessionMetaDoc } from './types.js'

/** Тул загрузки скилла (nr — свой, ACP — MCP): результат неприкосновенен для чистки и компакции. */
export const SKILL_LOAD_TOOL = 'skill_load'

/** Тул агента «заморозить результат»: пишет `context.pinned` меты своей сессии. */
export const CONTEXT_PIN_TOOL = 'context_pin'

/** Ключи входа вызова, которые служат адресом в заглушке — по порядку. */
export const CLEARED_KEY_FIELDS = ['file_path', 'path', 'command', 'pattern', 'url', 'query'] as const

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : undefined)

/** `meta.context` в нормальной форме: только строковые списки; нет — пустой объект. */
export function sessionContextOf(meta: SessionMetaDoc | Record<string, unknown> | null | undefined): SessionContextMeta {
  const c = (meta as { context?: unknown } | null | undefined)?.context
  if (!c || typeof c !== 'object') return {}
  const o = c as Record<string, unknown>
  const out: SessionContextMeta = {}
  for (const k of ['pinned', 'dropped', 'cleared'] as const) {
    const l = strList(o[k])
    if (l) out[k] = [...new Set(l)]
  }
  return out
}

/**
 * Новый `context` с заменой одного списка (остальные — как были): объект для
 * патча меты целиком. Пустой список — ключ убирается.
 */
export function withSessionContext(meta: SessionMetaDoc | Record<string, unknown> | null | undefined, key: keyof SessionContextMeta, ids: Iterable<string>): SessionContextMeta {
  const out = { ...sessionContextOf(meta) }
  const list = [...new Set(ids)]
  if (list.length) out[key] = list
  else delete out[key]
  return out
}

/** Размер для человека и модели: `320 B`, `14.2 KB`, `1.3 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Адрес вызова: первое строковое поле входа из {@link CLEARED_KEY_FIELDS}. */
export function clearedKeyOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const k of CLEARED_KEY_FIELDS) {
    const v = o[k]
    if (typeof v === 'string' && v.trim() !== '') {
      const one = v.trim().replace(/\s+/g, ' ')
      return one.length > 200 ? `${one.slice(0, 200)}…` : one
    }
  }
  return undefined
}

/**
 * Заглушка вместо выкинутого/срезанного результата тула:
 * `[cleared: <тул> <ключ>, <размер> — перечитай при нужде]`. `bytes` — размер
 * результата (UTF-8); ключа во входе нет — без него.
 */
export function clearedStub(tool: string, input: unknown, bytes: number): string {
  const key = clearedKeyOf(input)
  return `[cleared: ${tool}${key ? ` ${key}` : ''}, ${formatBytes(bytes)} — перечитай при нужде]`
}
