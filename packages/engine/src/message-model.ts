// Message / ContentBlock — модель ленты контекст-слоя.
//
// Раньше типы жили в `@kerneldreams/nrd` (сплиттер). Сплиттер умер в nrd-core
// 4.0.0: формат `%role` целиком принадлежит `@kerneldreams/nrd/chat`,
// чья форма сообщения — `ChatMessage` (role/body/meta), без типизированных
// блоков. Контекст-движок же построен именно на блоках: скоринг и фильтрация
// читают `$visibility`, `%summary`, `$collapsed`, типы `thinking`/`tool_use`.
// Поэтому модель переехала сюда — она и была внутренней моделью движка, а не
// частью ядра. Внешняя поверхность nr-engine не изменилась: `types.ts`
// реэкспортирует те же имена.
//
// Спека модели: nrd-core `docs/specs/message-format-spec.md` §3 (документ
// остался в ядре как описание, реализации там больше нет).

import type { Value } from '@kerneldreams/nrd'

/**
 * Типизированный блок контента внутри сообщения.
 *
 * `body` непрозрачно — движок хранит его как есть и не интерпретирует.
 */
export interface ContentBlock {
  /** Тип блока: "text", "thinking", "tool_use", … */
  type: string
  /** Атрибуты блока. */
  attrs: Record<string, Value>
  /** Тело блока, дословно. */
  body: string
}

/** Сообщение: конверт роли + упорядоченные типизированные блоки. */
export interface Message {
  /** Имя роли. */
  role: string
  /** Атрибуты сообщения. */
  attrs: Record<string, Value>
  /** Упорядоченные блоки контента. */
  blocks: ContentBlock[]
}
