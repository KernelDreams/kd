/**
 * Объекты в контексте сессии (v1.53, objects-spec §15.1 п.5): `SessionCreateOpts.objects` →
 * `sessionMeta.objects`, блоки промпта источником `object:<type>/<id>` — общие у nr (префикс сессии)
 * и ACP (system-блоки после агента). Текст объекта кладёт клиент (карточка целиком): движок
 * сервис объектов не зовёт.
 */

import { objectBlockSource, type SessionObjectRef } from '@kerneldreams/ui-protocol'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** Входной список → чистые ссылки (тип и id обязательны, дубли — первый). */
export function sessionObjectsOf(raw: unknown): SessionObjectRef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SessionObjectRef[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const type = str(o.type)
    const id = str(o.id)
    if (!type || !id || seen.has(`${type}/${id}`)) continue
    seen.add(`${type}/${id}`)
    const hash = str(o.hash)
    const title = str(o.title)
    const text = str(o.text)
    out.push({ type, id, ...(hash ? { hash } : {}), ...(title ? { title } : {}), ...(text ? { text } : {}) })
  }
  return out
}

/** Блоки промпта объектов сессии: заголовок и текст; объект без текста — строка-ссылка. */
export function sessionObjectBlocks(meta: unknown): Array<{ source: string; text: string }> {
  const list = sessionObjectsOf((meta as { objects?: unknown } | null | undefined)?.objects)
  return list.map((o) => ({
    source: objectBlockSource(o),
    text: `## ${o.title ?? o.id} (${o.type}/${o.id})\n\n${o.text ?? 'Объект в контексте этой сессии; содержимого нет — спроси, если нужно.'}`.trim(),
  }))
}
