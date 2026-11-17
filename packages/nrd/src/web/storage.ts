// memoryStorage — in-memory IStorage. WinterCG-чистая реализация: ни `node:`,
// ни fs. Жила в nr-infra рядом с fsStorage; по лестнице платформ (nrd-merge
// §2.2) уехала в `nrd/web`, fsStorage остался в `nrd/node`.

import { ok } from '../infra/result.js'
import type { IStorage } from '../contracts/index.js'

export type { IStorage } from '../contracts/index.js'

/** In-memory хранилище, для тестов. */
export function memoryStorage(): IStorage {
  const store = new Map<string, string>()
  const norm = (p: string): string => p.split('/').filter(Boolean).join('/')

  return {
    async read(path) {
      const key = norm(path)
      return ok(store.has(key) ? store.get(key) : undefined)
    },

    async write(path, content) {
      store.set(norm(path), content)
      return ok(undefined)
    },

    async exists(path) {
      return ok(store.has(norm(path)))
    },

    async list(prefix) {
      const p = norm(prefix)
      const match = p === '' ? '' : p + '/'
      const files = [...store.keys()].filter((k) => p === '' || k === p || k.startsWith(match))
      return ok(files.sort())
    },

    async delete(path) {
      store.delete(norm(path))
      return ok(undefined)
    },
  }
}
