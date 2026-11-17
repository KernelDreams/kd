/**
 * @kerneldreams/runz-runtime — script / document loader
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, resolveIncludes } from '@kerneldreams/nrd'
import type { ExtendsLoader, NRDocument } from '@kerneldreams/nrd'
import type { ScriptFn } from './types.ts'
import { registerResolveHook } from './hook.ts'

/** Dynamically import a `.ts` script and return its default export. */
export async function importScriptFn(file: string): Promise<ScriptFn> {
  return (await importScriptModule(file)).fn
}

/** Скрипт и то, что он объявил о себе: `flags` (известные флаги), `usage` (свой текст справки) —. */
export async function importScriptModule(file: string): Promise<{ fn: ScriptFn; flags?: unknown; usage?: string; tool?: unknown }> {
  // Ленивая регистрация: скрипт снаружи дерева runz импортирует @kerneldreams/*,
  // @kerneldreams/* и зависимости `.runz/`-окружений через один общий хук (hook.ts).
  registerResolveHook()
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; flags?: unknown; usage?: unknown; tool?: unknown }
  const fn = mod.default
  if (typeof fn !== 'function') {
    throw new Error(`script "${file}" has no default export function`)
  }
  return { fn: fn as ScriptFn, flags: mod.flags, usage: typeof mod.usage === 'string' ? mod.usage : undefined, tool: mod.tool }
}

/** Parse a `.md` file into an NRDocument. */
export function parseDocFile(file: string): NRDocument {
  const raw = fs.readFileSync(file, 'utf8')
  const baseDir = path.dirname(file)
  const text = resolveIncludes(raw, (target) => {
    const p = path.isAbsolute(target) ? target : path.join(baseDir, target)
    try {
      return fs.readFileSync(p, 'utf8')
    } catch (e) {
      // Молча выпавший инклюд = невидимо искалеченный документ.
      process.stderr.write(`[runz] include failed: ${target} (${p}) — ${(e as Error).message}\n`)
      return undefined
    }
  })
  // Загрузчик $nr-extends — тот же паттерн, что include-callback: путь резолвится
  // относительно документа-владельца, ядро остаётся IO-free. Битый файл — fail loud
  // (в отличие от инклюда: наследование молча потерять нельзя). Кэш — здесь, а не в
  // ядре: ядро грузит базу на каждое обращение к унаследованному ключу.
  const cache = new Map<string, string>()
  const load: ExtendsLoader = (target) => {
    const p = path.isAbsolute(target) ? target : path.join(baseDir, target)
    const hit = cache.get(p)
    if (hit !== undefined) return hit
    const text = fs.readFileSync(p, 'utf8')
    cache.set(p, text)
    return text
  }
  return parseDocument(text, undefined, load)
}
