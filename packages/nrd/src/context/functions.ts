/**
 * Built-in resolver functions for `${fn(args)}` in nrd placeholders.
 *
 * loadMDD(path) — parse file as mdd (@ sigil) → IContext
 * loadMDZ(path) — parse file as mdz ($ sigil) → IContext
 * loadJSON(path) — parse JSON file → IContext (objectContext)
 * readFile(path) — raw text string
 *
 * Модуль PORTABLE (§2.5). Раньше он импортил `node:fs`/`node:path` напрямую и
 * тянул node в ядро сборки контекста. `FuncFn` синхронна, а `IStorage` из
 * `SourceContext` — асинхронна, поэтому выразить эти функции через уже
 * инжектируемую capability нельзя. Escape-hatch спеки: реализация fs
 * ИНЪЕКТИРУЕТСЯ портом {@link SyncFileIO}, а сами функции регистрируются из
 * `nrd/node` (`builtinFunctions`) и попадают в `buildContext` через
 * `opts.privilegedFunctions`.
 */

import { parseDocument, objectContext } from '../core/index.js'
import type { FuncFn, Value, IContext } from '../contracts/index.js'

/**
 * Порт синхронного файлового ввода — всё, что fs-функциям нужно от платформы.
 * Единственная реализация — `nodeFileIO` в `nrd/node` (закрывает DEBT MAP §4.2
 * «четыре реализации чтения файла»).
 */
export interface SyncFileIO {
  /** Прочитать файл как UTF-8 текст. Бросает, если файла нет. */
  readText(path: string): string
  /** Абсолютный ли путь по правилам платформы. */
  isAbsolute(path: string): boolean
  /** Склеить baseDir с относительным путём в абсолютный. */
  resolve(baseDir: string, path: string): string
}

/**
 * Служебный ключ baseDir в контексте, который получает `FuncFn` вторым
 * аргументом (resolve-fix §1.5).
 *
 * Ключ намеренно с `$`: контекст функций — отдельный, построенный хостом, и в
 * пользовательский неймспейс не смотрит. Прежняя реализация читала голый
 * `baseDir` из ПОЛЬЗОВАТЕЛЬСКОГО контекста — ключ коллизионный (документ вправе
 * объявить свой `$baseDir`) и никем не заполнявшийся, из-за чего относительные
 * пути функций резолвились от cwd (DEBT 08.08 №5).
 */
export const FUNC_BASE_DIR = '$baseDir'

/** Служебный контекст для `funcContext` — то, что функция не выводит из аргументов. */
export function funcServiceContext(baseDir?: string): IContext {
  return objectContext(baseDir === undefined ? {} : { [FUNC_BASE_DIR]: baseDir })
}

/**
 * Аргумент-путь → абсолютный путь. Относительный резолвится от baseDir —
 * ПАПКИ ДОКУМЕНТА, единая семантика с инклудами `$[[./x]]` и `$path:` источника.
 *
 * Абсолютность проверяется портом (`path.isAbsolute` в Node): прежняя
 * `resolvePath(raw).startsWith('/')` Unix-центрична (на Windows resolve всегда
 * даёт `C:\…`, то есть проверка не срабатывала никогда и спасал только костыль
 * `/^[A-Z]:/`).
 */
function resolveFSPath(io: SyncFileIO, args: Value[], ctx: IContext): string {
  const raw = String(args[0] ?? '')
  if (!raw) throw new Error('path argument required')
  if (io.isAbsolute(raw)) return raw
  const baseDir = ctx.get([FUNC_BASE_DIR])
  return typeof baseDir === 'string' && baseDir !== '' ? io.resolve(baseDir, raw) : raw
}

/**
 * Собрать fs-функции поверх порта. Вызывается один раз из `nrd/node`; в корне
 * (`nrd`) не вызывается никогда — там нет платформы, которая дала бы `io`.
 */
export function fileFunctions(io: SyncFileIO): Record<string, FuncFn> {
  const loadMDD: FuncFn = (args, ctx) =>
    parseDocument(io.readText(resolveFSPath(io, args, ctx)), { sigil: '@' }) as unknown as Value

  const loadMDZ: FuncFn = (args, ctx) =>
    parseDocument(io.readText(resolveFSPath(io, args, ctx)), { sigil: '$' }) as unknown as Value

  const loadJSON: FuncFn = (args, ctx) =>
    objectContext(JSON.parse(io.readText(resolveFSPath(io, args, ctx)))) as unknown as Value

  const readFile: FuncFn = (args, ctx) => io.readText(resolveFSPath(io, args, ctx))

  return { loadMDD, loadMDZ, loadJSON, readFile }
}
