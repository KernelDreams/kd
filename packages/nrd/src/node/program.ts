/**
 * Ступень Node для программного слоя: детект по имени файла и чтение с диска.
 *
 * Detect — что запускаем и как. Порядок: расширение файла → явная декларация
 * (аргумент CLI `--as=` / `nr.input` файла). Только декларация, никогда
 * сниффинг содержимого. Неизвестный тип — громкая ошибка, не дефолт.
 */

import { readTextSync } from './fs.js'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { ExtendsLoader } from '../core/index.js'
import {
  INPUT_KINDS,
  isInputKind,
  programFromText,
  type InputKind,
  type Program,
} from '../program/program.js'
import { readTextWithIncludes } from './includes.js'
import { expandPresets, presetDirs } from './presets.js'

/** Расширение → вид входа. Единственная таблица detect'а. */
const BY_EXT: Record<string, InputKind> = {
  '.mdz': 'mdz',
  '.md': 'mdz',
  '.mdd': 'mdd',
  '.mds': 'mds',
}

/** Расширения, которые detect понимает без `--as` — для реестра хоста. */
export const PROGRAM_EXTENSIONS: readonly string[] = Object.keys(BY_EXT)

/**
 * Определить вид входа по имени файла.
 *
 * `explicit` — явная декларация (аргумент CLI `--as=` или `nr.input` файла);
 * она сильнее расширения, но так же громко падает на неизвестном значении.
 */
export function detectKind(file: string, explicit?: unknown): InputKind {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const e = String(explicit).trim().toLowerCase()
    if (isInputKind(e)) return e
    throw new Error(
      `nrd: неизвестный вид входа "${String(explicit)}" — известные: ${INPUT_KINDS.join(' | ')}`,
    )
  }
  const ext = extname(file).toLowerCase()
  const kind = BY_EXT[ext]
  if (!kind) {
    throw new Error(
      `nrd: неизвестный тип файла "${file}" (расширение "${ext || '(нет)'}") — ` +
        `известные: ${Object.keys(BY_EXT).join(' | ')}; либо укажи --as=${INPUT_KINDS.join('|')}`,
    )
  }
  return kind
}

export interface LoadProgramOptions {
  /**
   * Значения поверх документа (аргументы CLI): поле-профиль формы (`preset`,
   *) из них разворачивается атрибутами профиля, как значение в документе.
   */
  presets?: Record<string, unknown>
}

/**
 * Загрузить и разобрать файл. `explicitKind` — явная декларация вида входа.
 * Профили (`$поле: preset маска` в `## $form`) развёрнуты — presets.ts.
 */
export function loadProgram(file: string, explicitKind?: unknown, opts: LoadProgramOptions = {}): Program {
  const kind = detectKind(file, explicitKind)
  const baseDir = dirname(file)
  const included: string[] = []
  const text = readTextWithIncludes(file, undefined, '[nrd]', { onRead: (f) => included.push(f) })
  const source = kind === 'mds' ? text : expandPresets(text, { dirs: presetDirs(file, included), values: opts.presets })

  // Загрузчик `$nr-extends`: путь резолвится относительно документа-владельца,
  // ядро остаётся IO-free. Кэш — на вызов: ядро грузит базу на каждое
  // обращение к унаследованному ключу.
  const cache = new Map<string, string>()
  const load: ExtendsLoader = (target) => {
    const p = isAbsolute(target) ? target : join(baseDir, target)
    const hit = cache.get(p)
    if (hit !== undefined) return hit
    const text = readTextSync(p)
    cache.set(p, text)
    return text
  }

  return programFromText(source, kind, file, load)
}
