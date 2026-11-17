/**
 * Кэш пакетов воркера (compute-pool-spec §6): `<cache>/<sha>/` — распакованный
 * пакет, `<cache>/index.json` — размер и последнее использование. Пакет есть —
 * не тянется; не влезает в `$budget.disk` — выкидываются давно не нужные (LRU),
 * кроме тех, что сейчас в работе.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unpack } from './pack.js'

interface Entry {
  size: number
  used: number
}

export class PkgCache {
  private index: Record<string, Entry>
  private readonly file: string

  constructor(
    readonly dir: string,
    /** Предел байтов (`$budget.disk`). */
    public limit: number,
    private readonly clock: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'index.json')
    try {
      this.index = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>
    } catch {
      this.index = {}
    }
    // Каталог стёрли руками — запись не врёт.
    for (const sha of Object.keys(this.index)) if (!existsSync(join(dir, sha))) delete this.index[sha]
  }

  list(): string[] {
    return Object.keys(this.index)
  }

  has(sha: string): boolean {
    return sha in this.index && existsSync(join(this.dir, sha))
  }

  path(sha: string): string {
    return join(this.dir, sha)
  }

  size(): number {
    return Object.values(this.index).reduce((s, e) => s + e.size, 0)
  }

  /** Пакет на диске: есть — отметить использование, нет — `fetch` и распаковать. */
  async ensure(sha: string, fetch: (sha: string) => Promise<Buffer>, keep: Iterable<string> = []): Promise<string> {
    const dst = join(this.dir, sha)
    if (this.has(sha)) {
      this.index[sha]!.used = this.clock()
      this.save()
      return dst
    }
    const bytes = await fetch(sha)
    const tmp = `${dst}.tmp-${process.pid}`
    rmSync(tmp, { recursive: true, force: true })
    unpack(bytes, tmp)
    rmSync(dst, { recursive: true, force: true })
    renameSync(tmp, dst)
    this.index[sha] = { size: bytes.length, used: this.clock() }
    this.evict(new Set([sha, ...keep]))
    this.save()
    return dst
  }

  /** Выкинуть давно не нужные, пока сумма > предела; `keep` не трогать. */
  evict(keep: Set<string> = new Set()): string[] {
    const gone: string[] = []
    const order = Object.entries(this.index).sort((a, b) => a[1].used - b[1].used)
    let total = this.size()
    for (const [sha, e] of order) {
      if (total <= this.limit) break
      if (keep.has(sha)) continue
      rmSync(join(this.dir, sha), { recursive: true, force: true })
      delete this.index[sha]
      total -= e.size
      gone.push(sha)
    }
    return gone
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.index, null, 1))
    renameSync(tmp, this.file)
  }
}
