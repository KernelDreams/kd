/**
 * createMemoryFiles — файлы пространства в памяти (workspace-files-spec §2):
 * фикстура для e2e фронта и тестов. Содержимое — карта `path → content` опцией.
 *
 * Семантика — та же, что у backend-fs на диске: правила протокола (пути,
 * кодировки, `ignored`, коды ошибок), корзина `.nr-trash`, revision
 * `size:mtimeMs`, родители создаются записью. Диска нет — нет симлинков и
 * гонок; watch — эмуляция на собственных мутациях.
 */

import {
  FileBadRequestError,
  FileConflictError,
  FileNotFoundError,
  WORKSPACE_TRASH_DIR,
  checkFileReadSize,
  compileFileSearch,
  decodeFileContent,
  fileContent,
  fileMime,
  isIgnoredPath,
  isTrashPath,
  normalizeFilePath,
  parentFilePath,
  parseGitignore,
} from '@kerneldreams/ui-protocol'
import type {
  FileContent,
  FileEntry,
  FileReadOpts,
  FileSearchHit,
  FileSearchQuery,
  FileWriteOpts,
  WorkspaceFilesOps,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'

export interface MemoryFilesOpts {
  /** Имя корня в `stat('')`. Default `'memory'`. */
  rootName?: string
}

/** memory-FS умеет всё: запись, stat и watch есть всегда. */
export interface MemoryFiles extends WorkspaceFilesOps {
  write: NonNullable<WorkspaceFilesOps['write']>
  delete: NonNullable<WorkspaceFilesOps['delete']>
  rename: NonNullable<WorkspaceFilesOps['rename']>
  stat: NonNullable<WorkspaceFilesOps['stat']>
  watch: NonNullable<WorkspaceFilesOps['watch']>
  search: NonNullable<WorkspaceFilesOps['search']>
}

interface MemNode {
  kind: 'file' | 'dir'
  data?: Uint8Array
  mtimeMs: number
}

/**
 * Пространство в памяти. Ключ с `/` в конце — пустой каталог; строка —
 * UTF-8, `Uint8Array` — байты как есть.
 */
export function createMemoryFiles(
  files: Record<string, string | Uint8Array> = {},
  opts: MemoryFilesOpts = {},
): MemoryFiles {
  const rootName = opts.rootName ?? 'memory'
  const nodes = new Map<string, MemNode>()
  const decoder = new TextDecoder()

  /** Время мутации: строго растёт, иначе две записи в одну мс дали бы одну ревизию. */
  let clock = 0
  const tick = (): number => (clock = Math.max(Date.now(), clock + 1))
  const root: MemNode = { kind: 'dir', mtimeMs: tick() }

  function ensureDirs(path: string, mtimeMs: number): void {
    if (path === '') return
    const segs = path.split('/')
    for (let i = 1; i <= segs.length; i++) {
      const sub = segs.slice(0, i).join('/')
      const node = nodes.get(sub)
      if (!node) nodes.set(sub, { kind: 'dir', mtimeMs })
      else if (node.kind === 'file') throw new FileBadRequestError(`«${sub}» — файл, а не каталог`)
    }
  }

  for (const [raw, content] of Object.entries(files)) {
    const path = normalizeFilePath(raw)
    if (path === '') continue
    const now = tick()
    if (raw.endsWith('/')) {
      ensureDirs(path, now)
      continue
    }
    ensureDirs(parentFilePath(path), now)
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice()
    nodes.set(path, { kind: 'file', data, mtimeMs: now })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Общее
  // ──────────────────────────────────────────────────────────────────────────

  function rulesOf(dir: string) {
    const node = nodes.get(dir === '' ? '.gitignore' : `${dir}/.gitignore`)
    return node?.kind === 'file' ? parseGitignore(decoder.decode(node.data)) : undefined
  }

  function nodeAt(path: string): MemNode | undefined {
    return path === '' ? root : nodes.get(path)
  }

  function existing(path: string): MemNode {
    const node = nodeAt(path)
    if (!node) throw new FileNotFoundError(path)
    return node
  }

  function entryOf(path: string, node: MemNode): FileEntry {
    const name = path === '' ? rootName : path.slice(path.lastIndexOf('/') + 1)
    const entry: FileEntry = { name, path, kind: node.kind, mtime: new Date(node.mtimeMs).toISOString() }
    if (node.kind === 'file') {
      entry.size = node.data!.byteLength
      const mime = fileMime(path)
      if (mime !== undefined) entry.mime = mime
    }
    if (isIgnoredPath(path, node.kind === 'dir', rulesOf)) entry.ignored = true
    return entry
  }

  function revisionOf(node: MemNode): string {
    return `${node.data!.byteLength}:${node.mtimeMs}`
  }

  function guardMutable(path: string): void {
    if (path === '') throw new FileBadRequestError('Корень пространства не меняется файловыми операциями')
    if (isTrashPath(path)) throw new FileBadRequestError(`«${path}» — корзина пространства, её не правят`)
  }

  /** Узел и всё под ним. */
  function subtree(path: string): string[] {
    return [...nodes.keys()].filter((key) => key === path || key.startsWith(`${path}/`))
  }

  /** Перенести поддерево; родители цели создаются, файл по дороге — bad_request до переноса. */
  function move(from: string, to: string): void {
    ensureDirs(parentFilePath(to), tick())
    const keys = subtree(from)
    const moved = keys.map((key) => [to + key.slice(from.length), nodes.get(key)!] as const)
    for (const key of keys) nodes.delete(key)
    for (const [key, node] of moved) nodes.set(key, node)
  }

  const listeners = new Set<WorkspaceUpdateListener>()

  /** Эмуляция watch (§2): событие после мутации, асинхронно — как с диска. */
  function emit(paths: string[]): void {
    if (listeners.size === 0) return
    const sorted = [...new Set(paths)].sort()
    queueMicrotask(() => {
      for (const listener of [...listeners]) {
        try {
          listener({ type: 'workspace_update', paths: [...sorted] })
        } catch {
          // упавший подписчик не мешает остальным
        }
      }
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Операции
  // ──────────────────────────────────────────────────────────────────────────

  return {
    async list(path?: string): Promise<FileEntry[]> {
      const norm = normalizeFilePath(path)
      if (existing(norm).kind !== 'dir') throw new FileBadRequestError(`«${norm}» — файл, а не каталог`)
      const out: FileEntry[] = []
      for (const [key, node] of nodes) {
        if (key !== norm && parentFilePath(key) === norm) out.push(entryOf(key, node))
      }
      return out.sort((a, b) =>
        a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'dir' ? -1 : 1,
      )
    },

    async read(path: string, readOpts: FileReadOpts = {}): Promise<FileContent> {
      const norm = normalizeFilePath(path)
      const maxBytes = readOpts.maxBytes
      if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes >= 0)) {
        throw new FileBadRequestError('maxBytes — целое неотрицательное число')
      }
      const node = existing(norm)
      if (node.kind !== 'file') throw new FileBadRequestError(`«${norm}» — каталог, а не файл`)
      checkFileReadSize(norm, node.data!.byteLength, maxBytes)
      return fileContent({ path: norm, data: node.data!.slice(), revision: revisionOf(node) })
    },

    async write(path: string, content: string, writeOpts: FileWriteOpts = {}): Promise<{ revision: string }> {
      const norm = normalizeFilePath(path)
      guardMutable(norm)
      const revision = writeOpts.revision
      if (revision !== undefined && revision !== null && typeof revision !== 'string') {
        throw new FileBadRequestError('revision — строка из read, null (создать) или ничего')
      }
      const data = decodeFileContent(content, writeOpts.encoding ?? 'utf8')
      const current = nodes.get(norm)
      if (current?.kind === 'dir') throw new FileBadRequestError(`«${norm}» — каталог, а не файл`)
      if (revision === null && current) throw new FileConflictError(`Файл «${norm}» уже есть`)
      if (typeof revision === 'string') {
        if (!current) throw new FileConflictError(`Файла «${norm}» больше нет — его удалили после чтения`)
        if (revisionOf(current) !== revision) throw new FileConflictError(`Файл «${norm}» изменился после чтения`)
      }
      const now = tick()
      ensureDirs(parentFilePath(norm), now)
      const node: MemNode = { kind: 'file', data, mtimeMs: now }
      nodes.set(norm, node)
      emit([norm])
      return { revision: revisionOf(node) }
    },

    async delete(path: string): Promise<void> {
      const norm = normalizeFilePath(path)
      guardMutable(norm)
      existing(norm)
      move(norm, trashTarget(norm))
      emit([norm, WORKSPACE_TRASH_DIR])
    },

    async rename(from: string, to: string): Promise<void> {
      const src = normalizeFilePath(from)
      const dst = normalizeFilePath(to)
      guardMutable(src)
      guardMutable(dst)
      if (src === dst) return
      if (dst.startsWith(`${src}/`)) throw new FileBadRequestError(`«${src}» нельзя перенести внутрь самого себя`)
      existing(src)
      if (nodes.has(dst)) throw new FileConflictError(`«${dst}» уже есть`)
      move(src, dst)
      emit([src, dst])
    },

    async stat(path: string): Promise<FileEntry> {
      const norm = normalizeFilePath(path)
      return entryOf(norm, existing(norm))
    },

    // Поиск (v1.28): те же правила, что у backend-fs — игнор, бинарное мимо, порядок путей.
    async search(q: FileSearchQuery): Promise<FileSearchHit[]> {
      const m = compileFileSearch(q)
      const hits: FileSearchHit[] = []
      const paths = [...nodes.keys()].filter((p) => nodes.get(p)!.kind === 'file').sort()
      for (const path of paths) {
        if (hits.length >= m.limit) break
        if (!m.accepts(path) || isIgnoredPath(path, false, rulesOf)) continue
        const data = nodes.get(path)!.data!
        if (data.subarray(0, 8192).includes(0)) continue
        const lines = decoder.decode(data).split('\n')
        for (let i = 0; i < lines.length && hits.length < m.limit; i++) {
          const at = m.match(lines[i]!)
          if (at >= 0) hits.push(m.hit(path, i + 1, lines[i]!, at))
        }
      }
      return hits
    },

    watch(listener: WorkspaceUpdateListener): () => void {
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
  }

  /** Как у backend-fs: `.nr-trash/<путь>`; занято — суффикс времени; упёрлись в файл — каталог времени. */
  function trashTarget(path: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const preferred = `${WORKSPACE_TRASH_DIR}/${path}`
    const segs = preferred.split('/')
    for (let i = 1; i < segs.length; i++) {
      if (nodes.get(segs.slice(0, i).join('/'))?.kind === 'file') return `${WORKSPACE_TRASH_DIR}/${stamp}/${path}`
    }
    let target = preferred
    if (nodes.has(target)) target = `${preferred}.${stamp}`
    for (let n = 1; nodes.has(target); n++) target = `${preferred}.${stamp}-${n}`
    return target
  }
}
