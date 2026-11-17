/**
 * Слежение за деревом каталогов. На macOS и Windows рекурсивный `fs.watch` — родной и дешёвый;
 * на Linux Node эмулирует его: синхронный обход в главном потоке и вотч на каждую папку и файл
 * (server 30.10: 1.5 млн вотчей, 5 ГБ кучи, nr отвечал секундами). Здесь — свой обход:
 * асинхронно, только папки, без зависимостей и сборок, с потолком.
 *
 * Копия: backend-http, backend-fs и artifacts не связаны зависимостью; правка — во всех трёх (DEBT 30.10).
 */

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const SKIP_DIRS = ['node_modules', '.git', '.worktrees', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'target', '.next', '.turbo']
const SKIP = new Set(SKIP_DIRS)
/** Потолок вотчей на дерево: дальше события не приходят, стенд важнее. */
export const MAX_DIRS = 20_000

export interface TreeWatch {
  close(): void
}

export interface TreeWatchOptions {
  /** `false` — вотчи не держат процесс. Default — да. */
  persistent?: boolean
  /** Корень недоступен или слежение умерло — событий больше не будет. */
  onError?(err: Error): void
}

export function watchTree(root: string, onEvent: (name: string) => void, opts: TreeWatchOptions = {}): TreeWatch {
  const persistent = opts.persistent !== false
  if (process.platform !== 'linux') {
    const w = watch(root, { recursive: true, persistent }, (_ev, name) => onEvent(name ? String(name) : ''))
    if (opts.onError) w.on('error', opts.onError)
    return { close: () => w.close() }
  }
  const dirs = new Map<string, FSWatcher>()
  let closed = false
  const drop = (dir: string): void => {
    for (const [d, w] of dirs) {
      if (d === dir || d.startsWith(dir + '/')) {
        w.close()
        dirs.delete(d)
      }
    }
  }
  const add = async (dir: string): Promise<void> => {
    if (closed || dirs.has(dir) || dirs.size >= MAX_DIRS) return
    let w: FSWatcher
    try {
      w = watch(dir, { persistent }, (_ev, name) => {
        if (!name) return onEvent('')
        const path = join(dir, String(name))
        onEvent(relative(root, path))
        // Новая папка — под слежение (и её содержимое), удалённая — снять.
        stat(path).then(
          (s) => (s.isDirectory() && !SKIP.has(String(name)) ? add(path) : undefined),
          () => drop(path),
        )
      })
    } catch (e) {
      if (dir === root) opts.onError?.(e as Error)
      return
    }
    w.on('error', (e) => (dir === root ? opts.onError?.(e) : drop(dir)))
    dirs.set(dir, w)
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) if (it.isDirectory() && !SKIP.has(it.name)) await add(join(dir, it.name))
  }
  void add(root)
  return {
    close() {
      closed = true
      for (const w of dirs.values()) w.close()
      dirs.clear()
    },
  }
}
