/**
 * Корни машины для тулов `nr-tools`: обёртка над `Fs`, каждый доступ к диску — только внутри `$roots`
 * (по пути и по реальному пути существующей части: симлинк наружу — тоже выход). Тулы работают со
 * `scope: 'any'` и любым абсолютным путём, а граница одна — здесь, у диска.
 */

import { realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { Fs } from '@kerneldreams/chat-store/fs'

export class OutsideRootsError extends Error {
  constructor(path: string, roots: readonly string[]) {
    super(`path outside the roots of this machine: ${path} (roots: ${roots.join(', ')})`)
    this.name = 'OutsideRootsError'
  }
}

/** Windows: диск и имена без учёта регистра (`S:\\x` = `s:\\X`). */
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

const inside = (root: string, p: string): boolean => {
  const r = fold(root)
  const x = fold(p)
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** realpath существующей части пути + хвост как есть. */
function realOf(abs: string): string {
  const tail: string[] = []
  for (let head = abs; ; ) {
    try {
      const r = realpathSync(head)
      return tail.length ? resolve(r, ...tail.reverse()) : r
    } catch {
      const parent = dirname(head)
      if (parent === head) return abs
      tail.push(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      head = parent
    }
  }
}

export interface RootsGuard {
  roots: string[]
  allowed(path: string): boolean
  check(path: string): string
}

export function createRootsGuard(roots: readonly string[]): RootsGuard {
  const list = roots.map((r) => resolve(r))
  const real = list.map(realOf)
  const allowed = (path: string): boolean => {
    const abs = resolve(path)
    if (!list.some((r) => inside(r, abs)) && !real.some((r) => inside(r, abs))) return false
    const r = realOf(abs)
    return real.some((x) => inside(x, r)) || list.some((x) => inside(x, r))
  }
  return {
    roots: list,
    allowed,
    check(path) {
      if (!allowed(path)) throw new OutsideRootsError(path, list)
      return path
    },
  }
}

/** `Fs` с границей корней: вне — {@link OutsideRootsError}, у `realpath` тоже (тулы проверяют им cwd). */
export function guardFs(fs: Fs, guard: RootsGuard): Fs {
  const c = guard.check
  return {
    ...fs,
    readText: (p) => fs.readText(c(p)),
    writeText: (p, t) => fs.writeText(c(p), t),
    readBytes: (p) => fs.readBytes(c(p)),
    writeBytes: (p, d) => fs.writeBytes(c(p), d),
    stat: (p) => fs.stat(c(p)),
    exists: (p) => fs.exists(c(p)),
    readdir: (p) => fs.readdir(c(p)),
    mkdir: (p) => fs.mkdir(c(p)),
    rename: (a, b) => fs.rename(c(a), c(b)),
    remove: (p, o) => fs.remove(c(p), o),
    list: (p) => fs.list(c(p)),
    realpath: (p) => fs.realpath(c(p)),
    append: (p, t) => fs.append(c(p), t),
    copyDir: (a, b) => fs.copyDir(c(a), c(b)),
  }
}
