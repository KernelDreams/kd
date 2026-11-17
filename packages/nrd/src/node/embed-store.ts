/**
 * sqliteEmbedStore — EmbedStore на `node:sqlite` (embed-cas-spec §3).
 *
 * Файл на пространство: `{dir}/{slug(space)}.db`, WAL. Вектор хранится f16.
 * meta фиксирует `space` (исходное имя), `norm` (NORM_V) и `dim` (первым
 * `put`): чужой файл, другая нормализация или размерность — ошибка, а не
 * тихая подмена. `node:sqlite` грузится лениво (через `createRequire`: бандлеры
 * и vite 5 не знают его как builtin) — остальная node-ступень его не тянет.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import type { EmbedStore } from '../contracts/index.js'
import { NORM_V, toF16Bytes, fromF16Bytes } from '../web/embed.js'

/** Максимум параметров в одном `IN (...)`. */
const GET_CHUNK = 500

/** Имя файла пространства: `/` → `__`, прочее вне `[A-Za-z0-9._-]` → `_`. */
export function embedSpaceSlug(space: string): string {
  return space.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

export interface SqliteEmbedStore extends EmbedStore {
  /** Закрыть открытые файлы (тесты, долгоживущие процессы). */
  close(): void
}

export function sqliteEmbedStore(dir: string): SqliteEmbedStore {
  const root = path.resolve(expandHome(dir))
  const open = new Map<string, DatabaseSync>()
  let sqlite: typeof import('node:sqlite') | undefined

  const fileOf = (space: string) => path.join(root, `${embedSpaceSlug(space)}.db`)

  async function lib() {
    return (sqlite ??= createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  }

  function readMeta(db: DatabaseSync, k: string): string | undefined {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
    return row?.v
  }

  /** Открыть файл пространства; `create: false` и файла нет → undefined. */
  async function db(space: string, create: boolean): Promise<DatabaseSync | undefined> {
    const cached = open.get(space)
    if (cached) return cached
    const file = fileOf(space)
    if (!create && !fs.existsSync(file)) return undefined
    fs.mkdirSync(root, { recursive: true })

    const { DatabaseSync } = await lib()
    const d = new DatabaseSync(file)
    try {
      d.exec('PRAGMA journal_mode = WAL')
      d.exec(
        'CREATE TABLE IF NOT EXISTS vec (hash TEXT PRIMARY KEY, v BLOB NOT NULL, ts INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
      )
      const s = readMeta(d, 'space')
      if (s !== undefined && s !== space) {
        throw new Error(`nrd: embed store ${file} — файл пространства "${s}", открыт как "${space}"`)
      }
      const n = readMeta(d, 'norm')
      if (n !== undefined && n !== String(NORM_V)) {
        throw new Error(`nrd: embed store "${space}" — norm файла ${n}, у кода NORM_V ${NORM_V}: нужен новый алиас`)
      }
      const ins = d.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)')
      ins.run('space', space)
      ins.run('norm', String(NORM_V))
    } catch (e) {
      d.close()
      throw e
    }
    open.set(space, d)
    return d
  }

  function dimOf(d: DatabaseSync): number | null {
    const v = readMeta(d, 'dim')
    return v === undefined ? null : Number(v)
  }

  return {
    async get(space, hashes) {
      const out = new Map<string, Float32Array>()
      if (!hashes.length) return out
      const d = await db(space, false)
      if (!d) return out
      const uniq = [...new Set(hashes)]
      for (let at = 0; at < uniq.length; at += GET_CHUNK) {
        const part = uniq.slice(at, at + GET_CHUNK)
        const rows = d
          .prepare(`SELECT hash, v FROM vec WHERE hash IN (${part.map(() => '?').join(',')})`)
          .all(...part) as { hash: string; v: Uint8Array }[]
        for (const r of rows) out.set(r.hash, fromF16Bytes(r.v))
      }
      return out
    },

    async put(space, entries) {
      if (!entries.size) return
      const d = (await db(space, true))!
      let dim = dimOf(d)
      for (const v of entries.values()) {
        if (dim === null) dim = v.length
        else if (v.length !== dim) {
          throw new Error(`nrd: embed store "${space}" — размерность ${v.length}, в пространстве ${dim}`)
        }
      }
      const ts = Date.now()
      d.exec('BEGIN')
      try {
        d.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('dim', String(dim))
        const ins = d.prepare('INSERT OR IGNORE INTO vec (hash, v, ts) VALUES (?, ?, ?)')
        for (const [h, v] of entries) ins.run(h, toF16Bytes(v), ts)
        d.exec('COMMIT')
      } catch (e) {
        d.exec('ROLLBACK')
        throw e
      }
    },

    async stat(space) {
      const d = await db(space, false)
      if (!d) return { count: 0, dim: null }
      const { n } = d.prepare('SELECT COUNT(*) AS n FROM vec').get() as { n: number }
      return { count: Number(n), dim: dimOf(d) }
    },

    async spaces() {
      if (!fs.existsSync(root)) return []
      const { DatabaseSync } = await lib()
      const out: string[] = []
      for (const f of fs.readdirSync(root).sort()) {
        if (!f.endsWith('.db')) continue
        const d = new DatabaseSync(path.join(root, f), { readOnly: true })
        try {
          const row = d.prepare("SELECT v FROM meta WHERE k = 'space'").get() as { v: string } | undefined
          if (row) out.push(row.v)
        } catch {
          // не наш файл — пропускаем
        } finally {
          d.close()
        }
      }
      return out
    },

    close() {
      for (const d of open.values()) d.close()
      open.clear()
    },
  }
}
