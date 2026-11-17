// nrd/node — комплект capabilities (§5.2, реш. D; бывший @kerneldreams/nrd/node).
//
// Тянет nr-infra (Storage, http) + nrd-exec (spawnExecutor). ОТДЕЛЬНЫЙ экспорт:
// браузерный бандл его не импортит, `node:*` / `zx` tree-shake-аются, ядро
// слой сборки контекста остаётся portable.

import { fsStorage } from './storage.js'
import { httpGet, httpPost } from '../web/http.js'
import { ok, type IStorage, type Executor } from '../contracts/index.js'
import { spawnExecutor } from './spawn.js'
import type { HttpClient } from '../context/types.js'

/**
 * Тонкий HttpClient поверх nr-infra.httpGet/httpPost. (nr-infra не экспортит
 * `fetchHttp` — адаптер тут, чтобы не расширять nr-infra ради не-scope http.)
 */
export const fetchHttp: HttpClient = {
  async get(url, opts) {
    const r = await httpGet(url, { headers: opts?.headers })
    if (!r.ok) return r
    return ok({ status: r.value.status, body: r.value.body })
  },
  async post(url, body, opts) {
    const r = await httpPost(url, body, { headers: opts?.headers })
    if (!r.ok) return r
    return ok({ status: r.value.status, body: r.value.body })
  },
}

/**
 * Готовый Node-комплект capabilities: fs + spawn + fetch одной строкой.
 *
 * `storage` — `fsStorage(baseDir)`: `$path` в source трактуется относительно
 * baseDir. Передавайте тот же baseDir, что и в buildContext.
 */
export function nodeCapabilities(
  baseDir: string = typeof process !== 'undefined' ? process.cwd() : '.',
): { storage: IStorage; executor: Executor; http: HttpClient } {
  return {
    storage: fsStorage(baseDir),
    executor: spawnExecutor,
    http: fetchHttp,
  }
}
