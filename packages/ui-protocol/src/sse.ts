/**
 * nr-ui-protocol — SSE-хелперы референсного HTTP-биндинга (§9).
 *
 * Кадр SSE: `event: <type>\ndata: {json}\n\n`.
 * Только сериализация/парсинг — никакого транспорта (fetch/EventSource — дело клиента).
 */

import type { AnyRunEvent } from './types.js'

/** Разделитель кадров SSE (пустая строка между событиями). */
const FRAME_SEP = '\n\n'

/**
 * Сериализует событие рана в один SSE-кадр (§9).
 * `event:` = `event.type`, `data:` = компактный JSON, завершается `\n\n`.
 */
export function serializeRunEvent(event: AnyRunEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${FRAME_SEP}`
}

/**
 * Парсит один SSE-кадр в событие рана.
 *
 * Устойчив к graceful degradation: несколько `data:`-строк склеиваются
 * через `\n` (спека SSE), поле `event:` информативно (истина — `type`
 * внутри JSON). Возвращает `null`, если `data` пуст или не парсится —
 * НЕ бросает (§5.2: неизвестное клиент игнорирует, а не падает).
 */
export function parseRunEvent(frame: string): AnyRunEvent | null {
  const dataLines: string[] = []

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue // разделитель / комментарий
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    if (field !== 'data') continue
    // по спеке SSE один ведущий пробел после ':' срезается
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }

  const data = dataLines.join('\n').trim()
  if (data === '') return null

  try {
    const parsed = JSON.parse(data)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null
    }
    return parsed as AnyRunEvent
  } catch {
    return null
  }
}

/**
 * Парсит SSE-стрим (текст из нескольких кадров) в массив событий.
 * Кадры разделяются пустой строкой; непарсящиеся кадры отбрасываются
 * (не роняют разбор — §1.2 graceful degradation).
 */
export function parseSSEStream(text: string): AnyRunEvent[] {
  const out: AnyRunEvent[] = []
  // нормализуем CRLF, режем по границе кадров (пустая строка)
  const normalized = text.replace(/\r\n/g, '\n')
  for (const frame of normalized.split(/\n{2,}/)) {
    if (frame.trim() === '') continue
    const event = parseRunEvent(frame)
    if (event) out.push(event)
  }
  return out
}
