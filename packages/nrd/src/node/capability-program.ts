/**
 * Node-комплект capability для программного слоя.
 *
 * Недоверенное звено не получает ни ФС, ни исполнителя, ни загрузчика кода —
 * гейт сборки контекста (`UNTRUSTED_SOURCES`) и плагины программы опираются на
 * отсутствие capability, а не на дисциплину вызывающего.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fsStorage } from './storage.js'
import { spawnExecutor } from './spawn.js'
import { nodeCodeLoader } from './code-loader.js'
import { discoverFunctions } from './functions.js'
import type { ProgramCapabilities, SyncStorage } from '../program/capability.js'

/** Синхронное лицо ФС, укоренённое в `root`. */
export function syncFsStorage(root: string): SyncStorage {
  const abs = (p: string) => resolvePath(root, p)
  return {
    root,
    read(path) {
      try {
        return readFileSync(abs(path), 'utf-8')
      } catch {
        return undefined
      }
    },
    write(path, content) {
      const full = abs(path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf-8')
    },
    exists(path) {
      return existsSync(abs(path))
    },
    list(path) {
      return readdirSync(abs(path)).map(String)
    },
    readBytes(path) {
      try {
        return new Uint8Array(readFileSync(abs(path)))
      } catch {
        return undefined
      }
    },
    writeBytes(path, data) {
      const full = abs(path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, data)
    },
  }
}

/** Комплект возможностей программы под Node. */
export function nodeProgramCaps(baseDir: string, trusted = true): ProgramCapabilities {
  if (!trusted) return { baseDir, trusted }
  return {
    baseDir,
    trusted,
    storage: fsStorage(baseDir),
    executor: spawnExecutor,
    fs: syncFsStorage(baseDir),
    codeLoader: nodeCodeLoader(baseDir),
    // fs-функции + `.nrd/functions/` по соглашению — та же привилегия, что у
    // конфигов runz. Без неё `${loadJSON('./preset.json')}` в декларации
    // документа оставался литералом.
    privilegedFunctions: discoverFunctions(baseDir),
  }
}
