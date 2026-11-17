/**
 * Function discovery — convention-based, upward search.
 *
 * Scan .nrd/functions/ from startDir upward to root.
 * Then ~/.nrd/functions/ (global).
 * Each .ts/.js file = one function. Filename (without ext) = function name.
 * Merge with fs-builtins (loadMDD/loadMDZ/loadJSON/readFile).
 *
 * Priority: builtins < global < project (closer wins).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, parse as parsePath, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { FuncFn } from '../core/index.js'
import { fileFunctions } from '../context/index.js'
import { nodeFileIO } from './fs.js'

/**
 * fs-функции `${loadMDD/loadMDZ/loadJSON/readFile}` — Node-регистрация
 * portable-фабрики из `./context/functions.ts` (nrd-merge §2.5).
 *
 * Раньше они жили прямо в ядре nrd-context и импортили `node:fs`. Теперь ядро
 * чистое, а привилегия приезжает сюда: `buildContext` берёт их через
 * `opts.privilegedFunctions` (и не подключает при `trusted:false`).
 */
export const builtinFunctions: Record<string, FuncFn> = fileFunctions(nodeFileIO)

const FUNCTIONS_DIR = '.nrd/functions'
const EXTENSIONS = ['.ts', '.js', '.mjs']

// ESM-пакет: глобального require нет. createRequire — единственный синхронный
// загрузчик; на Node >= 22.12 он грузит и ESM-модули (require(esm)).
const localRequire = createRequire(import.meta.url)

/**
 * Discover functions by convention.
 *
 * @param startDir - directory to start upward search from
 * @param globalDir - override for global ~/.nrd/functions/
 * @returns merged function registry (builtins + global + project)
 */
export function discoverFunctions(
  startDir: string,
  globalDir?: string,
): Record<string, FuncFn> {
  const result: Record<string, FuncFn> = { ...builtinFunctions }

  // Global: ~/.nrd/functions/
  const globalPath = globalDir ?? join(homedir(), FUNCTIONS_DIR)
  const globalFns = scanDir(globalPath)
  Object.assign(result, globalFns)

  // Upward: .nrd/functions/ from startDir to root
  const projectFns = scanUpward(startDir)
  Object.assign(result, projectFns)

  return result
}

/** Scan a single directory for function files. */
function scanDir(dir: string): Record<string, FuncFn> {
  const fns: Record<string, FuncFn> = {}
  if (!existsSync(dir)) return fns

  try {
    const files = readdirSync(dir)
    for (const file of files) {
      const { name, ext } = parsePath(file)
      if (!EXTENSIONS.includes(ext)) continue

      const fullPath = join(dir, file)
      try {
        const mod = localRequire(fullPath)
        const fn = mod.default ?? mod
        if (typeof fn === 'function') {
          fns[name] = fn as FuncFn
        } else {
          console.warn(`nrd/node: ${fullPath}: default export is not a function, skipped`)
        }
      } catch (e) {
        // Сломанный модуль — не молчим: молчание прятало нерабочий discovery целиком.
        console.warn(`nrd/node: failed to load ${fullPath}: ${(e as Error).message}`)
      }
    }
  } catch {
    // Directory not readable
  }

  return fns
}

/** Scan upward from startDir, collecting .nrd/functions/ at each level.
 *  Closer directories win (override farther ones). */
function scanUpward(startDir: string): Record<string, FuncFn> {
  const dirs: string[] = []
  let current = resolve(startDir)

  // Collect all .nrd/functions/ dirs from root to startDir (root first)
  while (true) {
    const candidate = join(current, FUNCTIONS_DIR)
    if (existsSync(candidate)) dirs.unshift(candidate) // root-first order
    const parent = dirname(current)
    if (parent === current) break // reached root
    current = parent
  }

  // Apply root-first → closest wins (later overwrites earlier)
  const result: Record<string, FuncFn> = {}
  for (const dir of dirs) {
    Object.assign(result, scanDir(dir))
  }
  return result
}
