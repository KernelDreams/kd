// Точки расширения сборки контекста: логгер, HTTP-capability, source/transform
// плагины. Реализации сборки (buildContext/chainSources) — в потребителе
// (nrd-context); плагины приносит потребитель через SourceContext.

import type { Value } from './value.js'
import type { IContext } from './context.js'
import type { IStorage } from './storage.js'
import type { Executor } from './executor.js'
import type { CodeLoader } from './code-loader.js'
import type { Result } from './result.js'

/** Минимальный логгер. Дефолт — noopLogger. */
export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

/** noop-логгер по умолчанию. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * HTTP-capability для http source. Тонкий контракт поверх fetch/nr-infra.
 * Конкретные http-source плагины — внешние пакеты; ядро лишь прокидывает клиент.
 *
 * Намеренно минимальный: адаптер (nrd-context/node.fetchHttp) сужает полный
 * HttpResponse nr-infra до `{status, body}`. Полная унификация с
 * HttpOptions/HttpResponse — зона ступени 2 (расширила бы этот контракт).
 */
export interface HttpClient {
  get(
    url: string,
    opts?: { headers?: Record<string, string> },
  ): Promise<Result<{ status: number; body: string }>>
  post(
    url: string,
    body: string,
    opts?: { headers?: Record<string, string> },
  ): Promise<Result<{ status: number; body: string }>>
}

/**
 * Контекст исполнения source/transform плагина.
 *
 * `baseDir`, `params`, `log` — всегда. Capabilities (`storage`/`executor`/`http`)
 * инъектируются потребителем под платформу; плагин, которому нужна отсутствующая
 * возможность, возвращает понятную ошибку.
 */
export interface SourceContext {
  baseDir: string
  params: Record<string, Value>
  log: Logger
  // инъектированные возможности:
  storage?: IStorage
  executor?: Executor
  http?: HttpClient
  /**
   * Загрузка кода из тела блока (`fn`). Нет capability — ошибка «code loading
   * not available on this host», не фолбэк на `new Function` (rz-merge §2.3).
   */
  codeLoader?: CodeLoader
  /**
   * Накопленный chain на момент вызова плагина (источники + параметры). exec/script
   * передают его как `external` в `execBlock` для резолва `${}` в теле/команде.
   * Внутреннее поле сборки — заполняется buildContext.
   */
  chain?: IContext
}

/** Source plugin. Возвращает IContext. Как получает данные — его дело. */
export interface SourcePlugin {
  readonly name: string
  resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext>
}

/** Transform plugin. IContext → IContext. */
export interface TransformPlugin {
  readonly name: string
  transform(input: IContext, attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext>
}
