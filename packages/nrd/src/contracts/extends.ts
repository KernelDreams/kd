// Слоистые контексты: загрузчик `$nr-extends` и опции резолва с привязанным self.
// Реализации (blockSelf/selfScope/resolveBlockValue) — в потребителе (nrd-core).

import type { IContext } from './context.js'

/**
 * Загрузчик документа по пути `$nr-extends`. Возвращает СЫРОЙ текст файла;
 * ядро остаётся IO-free (чтение — дело рантайма, как у includes). Путь резолвит
 * загрузчик (он знает директорию документа-владельца).
 */
export type ExtendsLoader = (path: string) => string

export interface SelfOptions {
  /** Цепочка читателя для свободных переменных — bare `${x}`. */
  reader?: IContext
  /** Загрузчик для `$nr-extends`. Обязателен, если атрибут присутствует. */
  load?: ExtendsLoader
  /** Реестр функций; по умолчанию — stdlib `coreFunctions`. */
  functions?: IContext
  mode?: 'lenient' | 'strict'
}
