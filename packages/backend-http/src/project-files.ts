/**
 * Файлы проекта: `workspace.files` стенда с проектами — пространство
 * на диске текущего проекта, которое собирает хост (backend-fs: `$root` плюс
 * `$dirs` папками в корне). Бэкенд не знает диска — только фабрику.
 *
 * Файлы следуют за текущим проектом процесса (`workspace.switch`, клиент шлёт
 * его при коннекте и при смене проекта): переход — подписчикам `watch` уходит
 * `['']` («перечитай всё»), подписка переезжает на новое пространство.
 * Пространства кэшируются по записи проекта (id + корни) и живут до `close`.
 * `ops.at(ws)` (v1.33) — файлы проекта вкладки, без оглядки на процесс.
 */

import type {
  FileContent,
  FileEntry,
  FileReadOpts,
  FileSearchHit,
  FileSearchQuery,
  FileWriteOpts,
  WorkspaceFilesCapability,
  WorkspaceFilesOps,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'
import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type { ProjectEntry } from './projects.js'

/** Пространство проекта от хоста: операции, честные флаги, закрытие. */
export interface ProjectFiles extends WorkspaceFilesOps {
  readonly capability: WorkspaceFilesCapability
  close?(): void
}

export type ProjectFilesFactory = (project: ProjectEntry) => ProjectFiles

export interface ProjectFilesRouter {
  ops: WorkspaceFilesOps
  /** Флаги текущего проекта (для `Capabilities.workspace.files`). */
  capability(): Promise<WorkspaceFilesCapability>
  /** Текущий проект сменился — подписчикам `['']`, подписка — на новое. */
  switched(): void
  close(): void
}

/** Проект по id для `files.at` (v1.33); чужой/нет — бросает (`forbidden`/`not_found`). */
export type ProjectById = (id: string) => Promise<ProjectEntry>

/**
 * `byId` — файлы проекта вкладки (`ops.at(ws)`, v1.33): дерево и поиск по
 * проекту из запроса, не по текущему проекту процесса. `guardWrite` — проверка
 * записи (роль) в проекте `ws` (гейт пользователей).
 */
export function createProjectFilesRouter(
  factory: ProjectFilesFactory,
  current: () => Promise<ProjectEntry>,
  byId?: ProjectById,
  guardWrite?: (project: ProjectEntry) => Promise<void>,
): ProjectFilesRouter {
  const cache = new Map<string, ProjectFiles>()
  const keyOf = (p: ProjectEntry): string => JSON.stringify([p.id, p.root, p.dirs ?? []])

  function filesOf(p: ProjectEntry): ProjectFiles {
    const key = keyOf(p)
    let got = cache.get(key)
    if (!got) {
      got = factory(p)
      cache.set(key, got)
    }
    return got
  }
  async function files(): Promise<ProjectFiles> {
    return filesOf(await current())
  }

  /** Файлы одного проекта (v1.33): без переездов — подписка прямо на его пространство. */
  function scoped(ws: string): WorkspaceFilesOps {
    const at = async (): Promise<{ f: ProjectFiles; p: ProjectEntry }> => {
      const p = await byId!(ws)
      return { f: filesOf(p), p }
    }
    const writable = async (op: 'write' | 'delete' | 'rename'): Promise<ProjectFiles> => {
      const { f, p } = await at()
      if (!f[op]) throw new NotSupportedError(`workspace.files.${op}`)
      await guardWrite?.(p)
      return f
    }
    return {
      list: async (path?: string) => (await at()).f.list(path),
      read: async (path: string, opts?: FileReadOpts) => (await at()).f.read(path, opts),
      write: async (path: string, content: string, opts?: FileWriteOpts) => (await writable('write')).write!(path, content, opts),
      delete: async (path: string) => (await writable('delete')).delete!(path),
      rename: async (from: string, to: string) => (await writable('rename')).rename!(from, to),
      async stat(path: string) {
        const { f } = await at()
        if (!f.stat) throw new NotSupportedError('workspace.files.stat')
        return f.stat(path)
      },
      async search(q: FileSearchQuery) {
        const { f } = await at()
        if (!f.search) throw new NotSupportedError('workspace.files.search')
        return f.search(q)
      },
      watch(listener: WorkspaceUpdateListener): () => void {
        let off: (() => void) | undefined
        let active = true
        void at()
          .then(({ f }) => {
            if (active && f.watch) off = f.watch(listener)
          })
          .catch(() => {})
        return () => {
          active = false
          off?.()
        }
      },
    }
  }

  const listeners = new Set<WorkspaceUpdateListener>()
  let unwatch: (() => void) | undefined
  let watching: ProjectFiles | undefined

  async function resubscribe(): Promise<void> {
    if (listeners.size === 0) return
    const next = await files()
    if (next === watching) return
    unwatch?.()
    unwatch = undefined
    watching = next
    if (next.watch) unwatch = next.watch((ev) => listeners.forEach((l) => l(ev)))
  }

  const ops: WorkspaceFilesOps = {
    async list(path?: string): Promise<FileEntry[]> {
      return (await files()).list(path)
    },
    async read(path: string, opts?: FileReadOpts): Promise<FileContent> {
      return (await files()).read(path, opts)
    },
    async write(path: string, content: string, opts?: FileWriteOpts): Promise<{ revision: string }> {
      const f = await files()
      if (!f.write) throw new NotSupportedError('workspace.files.write')
      return f.write(path, content, opts)
    },
    async delete(path: string): Promise<void> {
      const f = await files()
      if (!f.delete) throw new NotSupportedError('workspace.files.delete')
      return f.delete(path)
    },
    async rename(from: string, to: string): Promise<void> {
      const f = await files()
      if (!f.rename) throw new NotSupportedError('workspace.files.rename')
      return f.rename(from, to)
    },
    async stat(path: string): Promise<FileEntry> {
      const f = await files()
      if (!f.stat) throw new NotSupportedError('workspace.files.stat')
      return f.stat(path)
    },
    async search(q: FileSearchQuery): Promise<FileSearchHit[]> {
      const f = await files()
      if (!f.search) throw new NotSupportedError('workspace.files.search')
      return f.search(q)
    },
    ...(byId ? { at: scoped } : {}),
    watch(listener: WorkspaceUpdateListener): () => void {
      listeners.add(listener)
      void resubscribe().catch(() => {})
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
        if (listeners.size === 0) {
          unwatch?.()
          unwatch = undefined
          watching = undefined
        }
      }
    },
  }

  return {
    ops,
    async capability() {
      return { ...(await files()).capability }
    },
    switched() {
      if (listeners.size === 0) return
      void resubscribe()
        .catch(() => {})
        .finally(() => listeners.forEach((l) => l({ type: 'workspace_update', paths: [''] })))
    },
    close() {
      unwatch?.()
      listeners.clear()
      for (const f of cache.values()) f.close?.()
      cache.clear()
    },
  }
}
