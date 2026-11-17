/**
 * Поля вызова текстом (§9.4): `--params -` / `--params @файл` — mdz или JSON (по первому символу).
 * mdz: корневые `$поле: значение`; длинный текст — телом секции `## $поле`; текст со строками,
 * похожими на разметку, — в фенсе (тело, целиком завёрнутое в один фенс, отдаётся без него;
 * внутри фенса ничего не разбирается). Корневые `$tool` / `$action` — части вызова.
 */

import type { RawCall } from './call.js'
import { KdError } from './errors.js'

/** Минимум от nrd: корневые атрибуты типизированными значениями. */
export interface ParamsNrd {
  parseDocument(text: string, opts: { sigil: "$" }): unknown
  toJson(doc: unknown): unknown
}

const FENCE = /^(`{3,}|~{3,})/

/** Разрезать текст на голову и секции `## $имя`, не заглядывая внутрь фенсов. */
function sections(text: string): { head: string; secs: Array<{ name: string; body: string }> } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  const head: string[] = []
  const secs: Array<{ name: string; body: string[] }> = []
  for (const l of lines) {
    const t = FENCE.exec(l)?.[1]
    if (fence === null && t) fence = t
    else if (fence !== null && l.trim().startsWith(fence[0]!.repeat(fence.length)) && l.trim().replace(/[`~]/g, '') === '') fence = null
    else if (fence === null) {
      const m = /^##\s+\$([A-Za-z_][\w.-]*)\s*$/.exec(l)
      if (m) {
        secs.push({ name: m[1]!, body: [] })
        continue
      }
    }
    if (secs.length) secs[secs.length - 1]!.body.push(l)
    else head.push(l)
  }
  return { head: head.join('\n'), secs: secs.map((s) => ({ name: s.name, body: unfence(s.body.join('\n')) })) }
}

/** Тело, целиком завёрнутое в один фенс, → содержимое фенса как есть. */
function unfence(body: string): string {
  const t = body.replace(/^\n+|\n+$/g, '')
  const lines = t.split('\n')
  const open = FENCE.exec(lines[0] ?? '')?.[1]
  if (open && lines.length >= 2 && lines[lines.length - 1]!.trim() === open) return lines.slice(1, -1).join('\n')
  return t
}

const unquote = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) return s.slice(1, -1)
  return v
}

/** Текст полей → сырой вызов (поля; `$tool` / `$action`, если написаны). */
export function parseParamsText(nrd: ParamsNrd, text: string): { tool?: string; action?: string | null; params: Record<string, unknown> } {
  const trimmed = text.trimStart()
  let obj: Record<string, unknown>
  if (trimmed.startsWith('{')) {
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch (err) {
      throw new KdError(2, `--params: JSON не разобран — ${(err as Error).message}`, { hint: 'JSON — объект {"поле": значение}' })
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new KdError(2, '--params: JSON — объект {"поле": значение}')
    if (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params) && (typeof obj.tool === 'string' || 'action' in obj)) {
      return { ...(typeof obj.tool === 'string' ? { tool: obj.tool } : {}), ...('action' in obj ? { action: (obj.action as string | null) ?? null } : {}), params: obj.params as Record<string, unknown> }
    }
  } else {
    const { head, secs } = sections(text)
    obj = {}
    if (head.trim()) {
      const json = nrd.toJson(nrd.parseDocument(head, { sigil: '$' })) as { root?: { attrs?: Array<[string[], unknown]> } }
      for (const [path, v] of json.root?.attrs ?? []) obj[path.join('.')] = unquote(v)
    }
    for (const s of secs) obj[s.name] = s.body
  }
  const out: { tool?: string; action?: string | null; params: Record<string, unknown> } = { params: {} }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'tool' && typeof v === 'string') out.tool = v
    else if (k === 'action') out.action = v === null ? null : String(v)
    else out.params[k] = v
  }
  return out
}

/** Слить поля из текста под поля командной строки (командная строка сильнее). */
export function mergeRaw(base: RawCall, extra: { action?: string | null; params: Record<string, unknown> }): RawCall {
  return { tool: base.tool, ...(base.action ? { action: base.action } : extra.action ? { action: extra.action } : {}), params: { ...extra.params, ...base.params } }
}
