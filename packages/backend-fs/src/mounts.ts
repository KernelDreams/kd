/**
 * Пространство из нескольких корней: основной каталог плюс
 * подключённые — каталоги `$dirs` проекта видны папками в корне под своим
 * именем (`nrchat.dev/HANDOFF.md`). Одно дерево, один поиск, один watch.
 *
 * Подключённый каталог перекрывает одноимённый узел основного корня. Перенос
 * между корнями — `bad_request` (это копирование, а не rename), корень
 * подключения не правится, как и корень пространства.
 */

import { FileBadRequestError, normalizeFilePath } from '@kerneldreams/ui-protocol'
import type {
  FileContent,
  FileEntry,
  FileReadOpts,
  FileSearchHit,
  FileSearchQuery,
  FileWriteOpts,
  WorkspaceFilesCapability,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'
import { compileFileSearch } from '@kerneldreams/ui-protocol'
import type { FsWorkspace } from './workspace.js'

/**
 * `mounts` — имя папки в корне → пространство. Имя — один сегмент пути
 * (без `/`); пусто — вернётся `main` как есть. Закрытие составного закрывает все.
 */
export function mountWorkspaces(main: FsWorkspace, mounts: Record<string, FsWorkspace>): FsWorkspace {
  const names = Object.keys(mounts)
  if (names.length === 0) return main
  for (const n of names) {
    if (n === '' || n.includes('/') || n === '.' || n === '..') throw new Error(`backend-fs: имя подключения «${n}» — один сегмент пути`)
  }
  const all = [main, ...names.map((n) => mounts[n]!)]

  /** Путь → пространство, путь внутри него и префикс обратно. */
  function route(path: string | undefined): { ws: FsWorkspace; sub: string; prefix: string } {
    const norm = normalizeFilePath(path)
    const head = norm.split('/')[0]!
    const mounted = norm !== '' ? mounts[head] : undefined
    if (!mounted) return { ws: main, sub: norm, prefix: '' }
    return { ws: mounted, sub: norm.slice(head.length + 1), prefix: head }
  }
  const join = (prefix: string, sub: string): string => (prefix === '' ? sub : sub === '' ? prefix : `${prefix}/${sub}`)
  const entry = <T extends { path: string }>(prefix: string, e: T): T => (prefix === '' ? e : { ...e, path: join(prefix, e.path) })
  const mountEntry = (name: string): FileEntry => ({ name, path: name, kind: 'dir' })

  function mutable(path: string): { ws: FsWorkspace; sub: string; prefix: string } {
    const r = route(path)
    if (r.prefix !== '' && r.sub === '') throw new FileBadRequestError(`«${r.prefix}» — подключённый каталог, он не правится файловыми операциями`)
    return r
  }

  const capability: WorkspaceFilesCapability = { ...main.capability }
  if (!all.every((w) => w.capability.search)) delete capability.search
  if (!all.every((w) => w.capability.watch)) delete capability.watch

  const out: FsWorkspace = {
    root: main.root,
    capability,
    async list(path?: string): Promise<FileEntry[]> {
      const r = route(path)
      const got = (await r.ws.list(r.sub)).map((e) => entry(r.prefix, e))
      if (r.prefix !== '' || r.sub !== '') return got
      const rest = got.filter((e) => !(e.name in mounts))
      return [...names.map(mountEntry), ...rest].sort((a, b) =>
        a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'dir' ? -1 : 1,
      )
    },
    async read(path: string, opts?: FileReadOpts): Promise<FileContent> {
      const r = route(path)
      return entry(r.prefix, await r.ws.read(r.sub, opts))
    },
    async stat(path: string): Promise<FileEntry> {
      const r = route(path)
      if (r.prefix !== '' && r.sub === '') return mountEntry(r.prefix)
      return entry(r.prefix, await r.ws.stat!(r.sub))
    },
    close(): void {
      for (const w of all) w.close()
    },
  }
  if (main.write) {
    out.write = async (path: string, content: string, opts?: FileWriteOpts) => {
      const r = mutable(path)
      if (!r.ws.write) throw new FileBadRequestError(`«${path}»: только чтение`)
      return r.ws.write(r.sub, content, opts)
    }
    out.delete = async (path: string) => {
      const r = mutable(path)
      if (!r.ws.delete) throw new FileBadRequestError(`«${path}»: только чтение`)
      return r.ws.delete(r.sub)
    }
    out.rename = async (from: string, to: string) => {
      const a = mutable(from)
      const b = mutable(to)
      if (a.ws !== b.ws) throw new FileBadRequestError(`«${from}» → «${to}»: перенос между подключёнными каталогами не поддержан`)
      if (!a.ws.rename) throw new FileBadRequestError(`«${from}»: только чтение`)
      return a.ws.rename(a.sub, b.sub)
    }
  }
  if (capability.watch) {
    out.watch = (listener: WorkspaceUpdateListener) => {
      const offs = all.map((w, i) => {
        const prefix = i === 0 ? '' : names[i - 1]!
        return w.watch!((ev) => {
          // Основной корень: событие про имя подключения — не про него.
          const paths = ev.paths
            .map((p) => join(prefix, p))
            .filter((p) => prefix !== '' || p === '' || !(p.split('/')[0]! in mounts))
          if (paths.length > 0) listener({ type: 'workspace_update', paths })
        })
      })
      return () => {
        for (const off of offs) off()
      }
    }
  }
  if (capability.search) {
    out.search = async (q: FileSearchQuery): Promise<FileSearchHit[]> => {
      const m = compileFileSearch(q)
      const parts = await Promise.all(
        all.map(async (w, i) => {
          const prefix = i === 0 ? '' : names[i - 1]!
          // glob с `/` — по пути пространства: подключение без своего префикса его не проверит, фильтр потом.
          const { glob, ...rest } = q
          const sub: FileSearchQuery = glob && !glob.includes('/') ? { ...rest, glob, limit: m.limit } : { ...rest, limit: m.limit * 4 }
          const hits = await w.search!(sub)
          return hits.map((h) => entry(prefix, h)).filter((h) => (prefix !== '' || !(h.path.split('/')[0]! in mounts)) && m.accepts(h.path))
        }),
      )
      return parts
        .flat()
        .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
        .slice(0, m.limit)
    }
  }
  return out
}
