/**
 * createFsWorkspace — файлы пространства на диске (workspace-files-spec §1–2).
 *
 * Один каталог = одно пространство. Правила провода (нормализация путей,
 * кодировки, `.gitignore`, коды ошибок) — из nr-ui-protocol: memory-FS фикстуры
 * отвечает по тем же. Здесь только то, что знает диск: симлинки наружу,
 * атомарная запись, корзина, `fs.watch`.
 *
 * Потребители: backend-pi (cwd агента), backend-local (exz v2).
 */

import { randomBytes } from 'node:crypto'
import { watchTree, type TreeWatch } from './watch-tree.js'
import { existsSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename as fsRename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { searchWorkspace } from './search.js'
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
  GitignoreRule,
  WorkspaceFilesCapability,
  WorkspaceFilesOps,
  WorkspaceUpdateEvent,
  WorkspaceUpdateListener,
} from '@kerneldreams/ui-protocol'

export interface FsWorkspaceOpts {
  /** Мутации: `write`/`delete`/`rename`. Default true. */
  write?: boolean
  /** `watch` через `fs.watch` рекурсивно. Default true. */
  watch?: boolean
  /** Окно склейки изменений в одно `workspace_update`, мс. Default 200. */
  debounceMs?: number
  /** Больше путей в одном окне — событие `['']` («перечитай всё»). Default 500. */
  maxWatchPaths?: number
  /**
   * Поиск (`search`, протокол v1.28): ripgrep из PATH, иначе обход на node.
   * `{rg: false}` — только node (тесты), `{rg: '/path/rg'}` — свой rg. Default true.
   */
  search?: boolean | { rg?: string | false }
  /** Куда писать варнинги. Default — stderr. */
  warn?: (message: string) => void
}

/** Файловые операции пространства + то, что нужно хосту. */
export interface FsWorkspace extends WorkspaceFilesOps {
  /** Настоящий путь корня (симлинки раскрыты). */
  readonly root: string
  /** Для `Capabilities.workspace.files`: ровно те флаги, чьи методы есть. */
  readonly capability: WorkspaceFilesCapability
  /** Снять watch и отписать всех; операции дальше работают, `watch` — нет. */
  close(): void
}

/** Метка временного файла атомарной записи: такие имена не видны ни в list, ни в watch. */
const TMP_MARK = '.nr-tmp-'

/**
 * Пространство над каталогом `root`. Каталога нет — throw сразу: пространство
 * без корня — ошибка хоста, а не клиента.
 */
export function createFsWorkspace(root: string, opts: FsWorkspaceOpts = {}): FsWorkspace {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch (err) {
    throw new Error(`backend-fs: корня пространства ${root} нет: ${errText(err)}`)
  }
  if (!statSync(realRoot).isDirectory()) throw new Error(`backend-fs: корень пространства ${root} — не каталог`)

  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  const writable = opts.write ?? true
  const watchable = opts.watch ?? true
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep

  // ──────────────────────────────────────────────────────────────────────────
  // .gitignore — правила каталогов с кэшем по mtime
  // ──────────────────────────────────────────────────────────────────────────

  const gitignoreCache = new Map<string, { mtimeMs: number; size: number; rules: GitignoreRule[] }>()

  function rulesOf(dir: string): GitignoreRule[] | undefined {
    const file = join(absOf(dir), '.gitignore')
    let st: Stats
    try {
      st = statSync(file)
    } catch {
      gitignoreCache.delete(dir)
      return undefined
    }
    if (!st.isFile()) return undefined
    const hit = gitignoreCache.get(dir)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rules
    try {
      const rules = parseGitignore(readFileSync(file, 'utf8'))
      gitignoreCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, rules })
      return rules
    } catch {
      return undefined
    }
  }

  /**
   * Каталог со своим `.git` — вложенная репа: правила родителей на
   * неё не действуют (`isIgnoredPath`). Кэш на 10 с: зовётся на каждый префикс пути.
   */
  const repoCache = new Map<string, { at: number; repo: boolean }>()
  function isRepoRoot(dir: string): boolean {
    if (dir === '') return false
    const now = Date.now()
    const hit = repoCache.get(dir)
    if (hit && now - hit.at < 10_000) return hit.repo
    const repo = existsSync(join(absOf(dir), '.git'))
    repoCache.set(dir, { at: now, repo })
    return repo
  }

  function ignored(path: string, isDir: boolean): boolean {
    return isIgnoredPath(path, isDir, rulesOf, isRepoRoot)
  }

  /** Вложенная репа, которую прячут правила родителей (rg её сам не обойдёт). */
  function hiddenRepo(dir: string): boolean {
    return isRepoRoot(dir) && isIgnoredPath(dir, true, rulesOf)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Пути: всё, что уходит на диск, — внутри корня после раскрытия симлинков
  // ──────────────────────────────────────────────────────────────────────────

  function absOf(path: string): string {
    return path === '' ? realRoot : join(realRoot, ...path.split('/'))
  }

  function inside(real: string): boolean {
    return real === realRoot || real.startsWith(rootPrefix)
  }

  function escapes(path: string): FileBadRequestError {
    return new FileBadRequestError(`Путь «${path}» ведёт за пределы пространства (симлинк)`)
  }

  /** Существующий путь → настоящий путь (симлинки раскрыты и не выводят наружу). */
  async function resolveExisting(path: string): Promise<string> {
    let real: string
    try {
      real = await realpath(absOf(path))
    } catch (err) {
      if (isMissing(err)) {
        // Битая ссылка наружу — всё ещё попытка выйти, а не «файла нет».
        await resolveTarget(path)
        throw new FileNotFoundError(path)
      }
      throw err
    }
    if (!inside(real)) throw escapes(path)
    return real
  }

  /**
   * Путь, которого может не быть (запись, цель переноса): ближайший
   * существующий предок раскрыт и внутри корня, битых ссылок по дороге нет —
   * иначе запись ушла бы сквозь ссылку наружу.
   */
  async function resolveTarget(path: string): Promise<{ real: string; exists: boolean }> {
    try {
      const real = await realpath(absOf(path))
      if (!inside(real)) throw escapes(path)
      return { real, exists: true }
    } catch (err) {
      if (!isMissing(err)) throw err
    }
    const segs = path.split('/')
    for (let i = segs.length; i >= 1; i--) {
      const candidate = absOf(segs.slice(0, i).join('/'))
      try {
        await lstat(candidate)
      } catch (err) {
        if (isMissing(err)) continue
        throw err
      }
      let realAncestor: string
      try {
        realAncestor = await realpath(candidate)
      } catch {
        throw new FileBadRequestError(`Путь «${path}» идёт через битую ссылку`)
      }
      if (!inside(realAncestor)) throw escapes(path)
      if (i < segs.length && !(await stat(realAncestor)).isDirectory()) {
        throw new FileBadRequestError(`«${segs.slice(0, i).join('/')}» — файл, а не каталог`)
      }
      return { real: join(realAncestor, ...segs.slice(i)), exists: false }
    }
    return { real: absOf(path), exists: false }
  }

  /** Сам узел пути (ссылка в последнем сегменте НЕ раскрывается): для delete/rename. */
  async function resolveEntry(path: string): Promise<{ real: string; stats: Stats }> {
    const parent = await resolveExisting(parentFilePath(path))
    const real = join(parent, path.slice(path.lastIndexOf('/') + 1))
    try {
      return { real, stats: await lstat(real) }
    } catch (err) {
      if (isMissing(err)) throw new FileNotFoundError(path)
      throw err
    }
  }

  /** Корень и корзину не пишут, не удаляют и не переносят. */
  function guardMutable(path: string): void {
    if (path === '') throw new FileBadRequestError('Корень пространства не меняется файловыми операциями')
    if (isTrashPath(path)) throw new FileBadRequestError(`«${path}» — корзина пространства, её не правят`)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Узлы
  // ──────────────────────────────────────────────────────────────────────────

  function entryOf(name: string, path: string, st: Stats): FileEntry {
    const kind = st.isDirectory() ? 'dir' : 'file'
    const entry: FileEntry = { name, path, kind, mtime: new Date(st.mtimeMs).toISOString() }
    if (kind === 'file') {
      entry.size = st.size
      const mime = fileMime(path)
      if (mime !== undefined) entry.mime = mime
    }
    if (ignored(path, kind === 'dir')) entry.ignored = true
    return entry
  }

  /** Мутации по очереди: проверка revision и rename — одно действие для этого процесса. */
  let mutations: Promise<unknown> = Promise.resolve()
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutations.then(fn, fn)
    mutations = run.catch(() => {})
    return run
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Операции
  // ──────────────────────────────────────────────────────────────────────────

  async function list(path?: string): Promise<FileEntry[]> {
    const norm = normalizeFilePath(path)
    const real = await resolveExisting(norm)
    if (!(await stat(real)).isDirectory()) throw new FileBadRequestError(`«${norm}» — файл, а не каталог`)
    const names = await readdir(real)
    const entries = await Promise.all(
      names.map(async (name): Promise<FileEntry | undefined> => {
        if (name.includes(TMP_MARK)) return undefined
        const childPath = norm === '' ? name : `${norm}/${name}`
        const abs = join(real, name)
        try {
          let st = await lstat(abs)
          if (st.isSymbolicLink()) {
            // Ссылка наружу или битая — узла в пространстве нет.
            const target = await realpath(abs)
            if (!inside(target)) return undefined
            st = await stat(target)
          }
          if (!st.isFile() && !st.isDirectory()) return undefined // сокеты, FIFO
          return entryOf(name, childPath, st)
        } catch {
          return undefined // пропал между readdir и stat
        }
      }),
    )
    return entries
      .filter((e): e is FileEntry => e !== undefined)
      .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'dir' ? -1 : 1))
  }

  async function read(path: string, readOpts: FileReadOpts = {}): Promise<FileContent> {
    const norm = normalizeFilePath(path)
    const maxBytes = readOpts.maxBytes
    if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes >= 0)) {
      throw new FileBadRequestError('maxBytes — целое неотрицательное число')
    }
    const real = await resolveExisting(norm)
    const before = await stat(real)
    if (before.isDirectory()) throw new FileBadRequestError(`«${norm}» — каталог, а не файл`)
    if (!before.isFile()) throw new FileBadRequestError(`«${norm}» — не обычный файл`)
    checkFileReadSize(norm, before.size, maxBytes)
    const handle = await open(real, 'r')
    try {
      const data = await handle.readFile()
      checkFileReadSize(norm, data.byteLength, maxBytes) // вырос между stat и чтением
      // stat того же дескриптора: атомарная запись меняет inode, и ревизия
      // остаётся ревизией прочитанных байтов.
      const st = await handle.stat()
      return fileContent({ path: norm, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), revision: revisionOf(st) })
    } finally {
      await handle.close()
    }
  }

  async function write(path: string, content: string, writeOpts: FileWriteOpts = {}): Promise<{ revision: string }> {
    const norm = normalizeFilePath(path)
    guardMutable(norm)
    const revision = writeOpts.revision
    if (revision !== undefined && revision !== null && typeof revision !== 'string') {
      throw new FileBadRequestError('revision — строка из read, null (создать) или ничего')
    }
    const data = decodeFileContent(content, writeOpts.encoding ?? 'utf8')

    return exclusive(async () => {
      const target = await resolveTarget(norm)
      let current: Stats | undefined
      if (target.exists) {
        current = await stat(target.real)
        if (current.isDirectory()) throw new FileBadRequestError(`«${norm}» — каталог, а не файл`)
        if (!current.isFile()) throw new FileBadRequestError(`«${norm}» — не обычный файл`)
      }
      if (revision === null && current) throw new FileConflictError(`Файл «${norm}» уже есть`)
      if (typeof revision === 'string') {
        if (!current) throw new FileConflictError(`Файла «${norm}» больше нет — его удалили после чтения`)
        if (revisionOf(current) !== revision) throw new FileConflictError(`Файл «${norm}» изменился после чтения`)
      }

      const dir = dirname(target.real)
      const tmp = join(dir, `.${basename(target.real)}${TMP_MARK}${randomBytes(4).toString('hex')}`)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(tmp, data, { flag: 'wx' })
        if (current) await chmod(tmp, current.mode & 0o7777)
        // tmp + rename: читатель видит либо старый файл, либо новый целиком.
        await fsRename(tmp, target.real)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw fsError(err, norm)
      }
      return { revision: revisionOf(await stat(target.real)) }
    })
  }

  async function remove(path: string): Promise<void> {
    const norm = normalizeFilePath(path)
    guardMutable(norm)
    return exclusive(async () => {
      const entry = await resolveEntry(norm)
      const dest = await trashTarget(norm)
      try {
        await mkdir(dirname(dest), { recursive: true })
        await fsRename(entry.real, dest)
      } catch (err) {
        throw fsError(err, norm)
      }
    })
  }

  /**
   * Место в корзине: `.nr-trash/<путь>`; занято — с суффиксом времени; путь
   * упёрся в файл корзины — `.nr-trash/<время>/<путь>`.
   */
  async function trashTarget(path: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      const target = await resolveTarget(`${WORKSPACE_TRASH_DIR}/${path}`)
      return target.exists ? `${target.real}.${stamp}` : target.real
    } catch (err) {
      if (!(err instanceof FileBadRequestError)) throw err
      return (await resolveTarget(`${WORKSPACE_TRASH_DIR}/${stamp}/${path}`)).real
    }
  }

  async function rename(from: string, to: string): Promise<void> {
    const src = normalizeFilePath(from)
    const dst = normalizeFilePath(to)
    guardMutable(src)
    guardMutable(dst)
    if (src === dst) return
    if (dst.startsWith(`${src}/`)) throw new FileBadRequestError(`«${src}» нельзя перенести внутрь самого себя`)

    return exclusive(async () => {
      const source = await resolveEntry(src)
      const target = await resolveTarget(dst)
      let destReal = target.real
      if (target.exists) {
        // Регистронезависимая ФС: `a.md` → `A.md` находит сам источник.
        const same =
          src.toLowerCase() === dst.toLowerCase() && sameNode(await lstat(target.real), source.stats)
        if (!same) throw new FileConflictError(`«${dst}» уже есть`)
        destReal = join(dirname(source.real), dst.slice(dst.lastIndexOf('/') + 1))
      }
      try {
        await mkdir(dirname(destReal), { recursive: true })
        await fsRename(source.real, destReal)
      } catch (err) {
        throw fsError(err, src)
      }
    })
  }

  async function statPath(path: string): Promise<FileEntry> {
    const norm = normalizeFilePath(path)
    const real = await resolveExisting(norm)
    const st = await stat(real)
    const name = norm === '' ? basename(realRoot) : norm.slice(norm.lastIndexOf('/') + 1)
    return entryOf(name, norm, st)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // watch — fs.watch рекурсивно, окно склейки, свёртка шума
  // ──────────────────────────────────────────────────────────────────────────

  const listeners = new Set<WorkspaceUpdateListener>()
  const debounceMs = opts.debounceMs ?? 200
  const maxWatchPaths = opts.maxWatchPaths ?? 500
  let watcher: TreeWatch | undefined
  let pending = new Set<string>()
  let overflow = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const rootName = basename(realRoot)

  function onFsEvent(_event: string, filename: string | Buffer | null): void {
    const raw = filename === null ? '' : String(filename).split(sep).join('/')
    // FSEvents (macOS) шлёт событие самого корня его именем — о детях оно ничего
    // не говорит, а путём выглядело бы как несуществующий узел.
    if (raw === rootName && !existsSync(join(realRoot, raw))) return
    if (!overflow) {
      pending.add(raw)
      // Шторм (npm install, git checkout): сырые пути не копим, итог — «перечитай всё».
      if (pending.size > maxWatchPaths * 20) {
        overflow = true
        pending = new Set()
      }
    }
    if (timer === undefined) timer = setTimeout(flush, debounceMs)
  }

  /**
   * Сырой путь fs.watch → путь события: временные файлы и внутренности `.git`
   * — мимо; всё внутри игнорируемого каталога (`node_modules`, `dist/` из
   * `.gitignore`, корзина) — сам каталог: UI его и так свернул.
   */
  function collapse(raw: string, ignoredDir: (sub: string) => boolean): string | undefined {
    const segs = raw.split('/').filter((s) => s !== '' && s !== '.')
    if (segs.length === 0) return ''
    if (segs[0] === '.git') return undefined
    if (segs[segs.length - 1]!.includes(TMP_MARK)) return undefined
    for (let i = 1; i < segs.length; i++) {
      const sub = segs.slice(0, i).join('/')
      if (ignoredDir(sub)) return sub
    }
    return segs.join('/')
  }

  function flush(): void {
    timer = undefined
    const raw = pending
    const wasOverflow = overflow
    pending = new Set()
    overflow = false

    let paths: string[]
    if (wasOverflow) {
      paths = ['']
    } else {
      const memo = new Map<string, boolean>()
      const ignoredDir = (sub: string): boolean => {
        let hit = memo.get(sub)
        if (hit === undefined) memo.set(sub, (hit = ignored(sub, true)))
        return hit
      }
      const out = new Set<string>()
      for (const r of raw) {
        const path = collapse(r, ignoredDir)
        if (path !== undefined) out.add(path)
      }
      if (out.size === 0) return
      paths = out.has('') || out.size > maxWatchPaths ? [''] : [...out].sort()
    }
    emit({ type: 'workspace_update', paths })
  }

  function emit(event: WorkspaceUpdateEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener({ type: event.type, paths: [...event.paths] })
      } catch (err) {
        warn(`backend-fs: подписчик workspace_update упал: ${errText(err)}`)
      }
    }
  }

  function startWatcher(): void {
    try {
      // persistent:false — watch не держит процесс: живёт, пока жив хост.
      watcher = watchTree(realRoot, (name) => onFsEvent('change', name || null), {
        persistent: false,
        onError: (err) => {
          warn(`backend-fs: watch ${realRoot} остановлен: ${errText(err)}`)
          stopWatcher()
          // Подписчики остались без канала — последнее, что им можно сказать.
          emit({ type: 'workspace_update', paths: [''] })
        },
      })
    } catch (err) {
      warn(`backend-fs: watch ${realRoot} не запустился: ${errText(err)}`)
    }
  }

  function stopWatcher(): void {
    watcher?.close()
    watcher = undefined
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = new Set()
    overflow = false
  }

  function watch(listener: WorkspaceUpdateListener): () => void {
    if (closed) throw new Error('backend-fs: пространство закрыто (close())')
    listeners.add(listener)
    if (!watcher) startWatcher()
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
      if (listeners.size === 0) stopWatcher()
    }
  }

  const searchOpt = opts.search ?? true
  const searchable = searchOpt !== false
  async function search(q: FileSearchQuery): Promise<FileSearchHit[]> {
    const m = compileFileSearch(q)
    const rg = typeof searchOpt === 'object' ? searchOpt.rg : undefined
    return searchWorkspace({ root: realRoot, ignored, hiddenRepo, tmpMark: TMP_MARK, ...(rg === undefined ? {} : { rg }) }, q, m)
  }

  const capability: WorkspaceFilesCapability = {}
  if (writable) capability.write = true
  if (watchable) capability.watch = true
  if (searchable) capability.search = true

  return {
    root: realRoot,
    capability,
    list,
    read,
    stat: statPath,
    ...(writable ? { write, delete: remove, rename } : {}),
    ...(watchable ? { watch } : {}),
    ...(searchable ? { search } : {}),
    close(): void {
      closed = true
      listeners.clear()
      stopWatcher()
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Мелочи
// ────────────────────────────────────────────────────────────────────────────

/** Ревизия файла (workspace-files-spec §2): `size:mtimeMs`. */
function revisionOf(st: Stats): string {
  return `${st.size}:${st.mtimeMs}`
}

function sameNode(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Ошибка ФС → код провода там, где он честно известен; прочее — как есть (500). */
function fsError(err: unknown, path: string): unknown {
  if (err instanceof FileBadRequestError || err instanceof FileConflictError || err instanceof FileNotFoundError) return err
  switch ((err as { code?: unknown } | null)?.code) {
    case 'ENOENT':
      return new FileNotFoundError(path)
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new FileConflictError(`«${path}»: путь занят`)
    case 'ENOTDIR':
    case 'EISDIR':
    case 'ENAMETOOLONG':
    case 'EINVAL':
      return new FileBadRequestError(`«${path}»: ${errText(err)}`)
    default:
      return err
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
