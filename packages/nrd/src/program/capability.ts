/**
 * Capability-слой программы: один вход к ФС, исполнителю и загрузчику кода.
 *
 * Дыра, которую это закрывает: capability-слоёв было два и они не связаны —
 * принципиальный `SourceContext.storage` сборки контекста и ad-hoc
 * `helpers.read/write/...` + прямой `node:fs` в телах mdz. Второй обходил
 * первый, т.е. любой `fn` обходил гейт. Здесь оба берут ФС из одного объекта,
 * укоренённого в `baseDir`, и недоверенное звено не получает его вовсе.
 *
 * Модуль portable: только типы и проверки. Комплект под платформу собирает
 * ступень (`nodeProgramCaps` в `nrd/node`).
 *
 * Честная оговорка: контракт `IStorage` асинхронный, а `helpers.*` и `FuncFn` —
 * синхронные. Пока сигнатуры фиксированы приёмочными файлами, синхронная
 * сторона берёт ФС здесь — в ОДНОЙ точке, с baseDir и trust-проверкой, а не
 * россыпью по хендлерам.
 */

import type { CodeLoader, Executor, IStorage } from '../contracts/index.js'
import type { FuncFn } from '../core/index.js'

/** Синхронное лицо storage-capability. Пути — относительно корня. */
export interface SyncStorage {
  read(path: string): string | undefined
  write(path: string, content: string): void
  exists(path: string): boolean
  list(path: string): string[]
  /** Байты файла; нет файла — `undefined`. Опционально: хост без бинарного IO не даёт `helpers.image`. */
  readBytes?(path: string): Uint8Array | undefined
  /** Записать байты; каталоги создаются. */
  writeBytes?(path: string, data: Uint8Array): void
  readonly root: string
}

export interface ProgramCapabilities {
  /** Асинхронный контракт — уходит в SourceContext плагинов сборки контекста. */
  storage?: IStorage
  executor?: Executor
  /** Синхронное лицо того же хранилища — под helpers и FuncFn. */
  fs?: SyncStorage
  /** Загрузка тела `fn` как модуля (rz-merge §0.5). */
  codeLoader?: CodeLoader
  /**
   * Привилегированные функции резолвера (`${loadJSON}`/`${loadMDD}`/…) — те,
   * что ходят на диск. Приезжают со ступени платформы и недоверенному звену не
   * выдаются. Без них `${loadJSON('./x.json')}` в декларации молча остаётся
   * литералом — плейсхолдер не резолвится, а fail-soft прячет причину.
   */
  privilegedFunctions?: Record<string, FuncFn>
  /** Обычные функции резолвера, если хост хочет добавить свои. */
  functions?: Record<string, FuncFn>
  baseDir: string
  trusted: boolean
}

/** Достать ФС или упасть внятно (undefined = недоверенное звено). */
export function requireFs(caps: ProgramCapabilities, who: string): SyncStorage {
  if (!caps.fs) {
    throw new Error(
      `nrd: "${who}" требует capability \`storage\` — недоступна в недоверенном звене (trusted: false)`,
    )
  }
  return caps.fs
}

/**
 * Достать загрузчик кода или упасть. Фолбэка нет намеренно: `new Function`
 * вместо модуля тихо ломает импорты внутри тела и меняет семантику `export`.
 */
export function requireCodeLoader(caps: ProgramCapabilities, who: string): CodeLoader {
  if (!caps.codeLoader) {
    throw new Error(
      `nrd: code loading not available on this host — "${who}" требует capability \`codeLoader\``,
    )
  }
  return caps.codeLoader
}
