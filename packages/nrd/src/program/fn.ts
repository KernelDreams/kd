/**
 * Плагин `fn`: тело (TS/JS) → исполняемая функция.
 *
 * Тело загружается через capability `codeLoader` (rz-merge §0.5), а не
 * `new Function`: тело — модуль, оно импортирует пакеты и объявляет `export`.
 * `export default` вызывается как `(ctx, meta, helpers)`. Дополнительно, если
 * модуль экспортирует `fn` — она регистрируется как `FuncFn` и доступна в
 * `${name(args)}` через funcContext (синхронный контракт резолвера; async-тело
 * туда не годится и остаётся действием).
 *
 * Trust: исполнение кода из недоверенного звена запрещено. Оговорка честная:
 * тело `fn` — произвольный TS, он может импортировать что угодно;
 * capability-дисциплина применяется к декларативным источникам, не к коду в
 * теле. Песочница — не в этом срезе.
 */

import type { CodeLang } from '../contracts/index.js'
import type { FuncFn } from '../core/index.js'
import type { Decl } from './registry.js'
import { requireCodeLoader, requireFs, type ProgramCapabilities } from './capability.js'
import { stripFence } from './blocks.js'

/** Откуда берётся тело: инлайн или внешний файл (`nr.src: './x.ts'`). */
export const FN_TYPES: readonly string[] = ['inline', 'file']

/** Языки тела. Оба исполняются нативным TS ноды — различие декларативное. */
export const FN_LANGS: readonly string[] = ['ts', 'js']

export interface LoadedFn {
  id: string
  /** `export default` — действие `(ctx, meta, helpers)`. */
  run: (...args: unknown[]) => unknown
  /** `export const fn` — чистая функция для `${name(...)}`, если объявлена. */
  func?: FuncFn
}

/** Исходник тела `fn` по декларации (инлайн / `nr.src`), без фенсов. */
export function fnSource(decl: Decl, caps: ProgramCapabilities): string {
  const type = decl.type ?? 'inline'
  if (!FN_TYPES.includes(type)) {
    throw new Error(
      `nrd: неизвестный nr.type "${type}" у fn "${decl.id}" — известные: ${FN_TYPES.join(' | ')}`,
    )
  }
  if (!FN_LANGS.includes(decl.lang)) {
    throw new Error(
      `nrd: неизвестный nr.lang "${decl.lang}" у fn "${decl.id}" — известные: ${FN_LANGS.join(' | ')}`,
    )
  }
  if (type === 'file') {
    if (!decl.src) throw new Error(`nrd: fn "${decl.id}" (nr.type: file) требует nr.src`)
    const text = requireFs(caps, `fn "${decl.id}"`).read(decl.src)
    if (text === undefined) throw new Error(`nrd: fn "${decl.id}" — файл не найден: ${decl.src}`)
    return stripFence(text.trim())
  }
  if (decl.body.trim() === '') throw new Error(`nrd: fn "${decl.id}" пуст`)
  return stripFence(decl.body.trim())
}

/**
 * Загрузить тело как модуль.
 *
 * @throws если звено недоверенное (`caps.trusted === false`) — исполнение кода
 *   из недоверенного источника запрещено.
 * @throws если хост не дал `codeLoader` — исполнение кода на нём недоступно.
 */
export async function loadFn(decl: Decl, caps: ProgramCapabilities): Promise<LoadedFn> {
  if (!caps.trusted) {
    throw new Error(
      `nrd: fn "${decl.id}" не исполняется в недоверенном звене (trusted: false) — ` +
        `исполнение кода доступно только доверенной декларации`,
    )
  }

  const code = fnSource(decl, caps)
  const loader = requireCodeLoader(caps, `fn "${decl.id}"`)
  const mod = await loader.load(code, {
    lang: decl.lang as CodeLang,
    filename: `${decl.id}.${decl.lang}`,
    baseDir: caps.baseDir,
  })

  if (typeof mod.default !== 'function') {
    throw new Error(`nrd: fn "${decl.id}" не экспортирует default function`)
  }
  return {
    id: decl.id,
    run: mod.default as (...args: unknown[]) => unknown,
    func: typeof mod.fn === 'function' ? (mod.fn as FuncFn) : undefined,
  }
}
