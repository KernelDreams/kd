/**
 * Файлы пространства (workspace-files-spec §1): правила, общие для бэкендов.
 *
 * Здесь, а не в каждом бэкенде, по той же причине, что и правила вложений:
 * «какой путь законен», «что считается текстом», «что игнорируется» и «когда
 * отказать» — часть контракта `workspace.files`. backend-fs (диск) и memory-FS
 * фикстуры обязаны отвечать одинаково, иначе e2e nrchat врали бы про живой
 * бэкенд.
 *
 * Чистые функции, zero-dep: TextDecoder/TextEncoder/atob/btoa есть и в node, и
 * в браузере.
 */

import type { FileContent, FileEncoding, FileSearchHit, FileSearchQuery, WorkspaceUpdateEvent } from './types.js'
import { parseRunEvent } from './sse.js'
import { TEXT_ATTACHMENT_EXTENSIONS } from './attachments.js'
import { toBase64, utf8Text } from './bytes.js'

// ────────────────────────────────────────────────────────────────────────────
// Константы
// ────────────────────────────────────────────────────────────────────────────

/** Лимит `read` по умолчанию (workspace-files-spec §1): 2 МБ — как у вложений. */
export const DEFAULT_FILE_READ_MAX_BYTES = 2_000_000

/** Корзина пространства: `delete` переносит сюда (workspace-files-spec §2). */
export const WORKSPACE_TRASH_DIR = '.nr-trash'

/** Каталоги, игнорируемые всегда, на любой глубине — без `.gitignore`. */
export const ALWAYS_IGNORED_NAMES: readonly string[] = ['.git', 'node_modules']

// ────────────────────────────────────────────────────────────────────────────
// Ошибки — коды провода (backends-spec §3.1)
// ────────────────────────────────────────────────────────────────────────────

/** Путь или вход операции не годится: `..`, абсолютный путь, симлинк наружу, лимит. */
export class FileBadRequestError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'FileBadRequestError'
  }
}

/** Файла или каталога нет. */
export class FileNotFoundError extends Error {
  readonly code = 'not_found'
  constructor(path: string) {
    super(`Файла «${path}» нет в пространстве`)
    this.name = 'FileNotFoundError'
  }
}

/** `revision` разошёлся, создание поверх существующего, `rename` в занятый путь. */
export class FileConflictError extends Error {
  readonly code = 'conflict'
  constructor(message: string) {
    super(message)
    this.name = 'FileConflictError'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Пути
// ────────────────────────────────────────────────────────────────────────────

/**
 * Путь с провода → нормальная форма: относительный, POSIX, без `.` и пустых
 * сегментов; корень — `''` (`undefined`, `''`, `.`, `/`-хвосты сводятся к нему).
 *
 * Отказ (`bad_request`): абсолютный путь (`/x`, `C:…`), обратный слэш, NUL,
 * любой сегмент `..` — даже если он «сокращается»: законный клиент его не шлёт.
 * Симлинки наружу — проверка бэкенда с диском, здесь пути ещё не на диске.
 */
export function normalizeFilePath(path: string | undefined | null): string {
  if (path === undefined || path === null) return ''
  if (typeof path !== 'string') throw new FileBadRequestError('Путь файла должен быть строкой')
  if (path.includes('\0')) throw new FileBadRequestError('Путь файла содержит NUL-байт')
  if (path.includes('\\')) throw new FileBadRequestError(`Путь «${path}»: только POSIX-слэши, без «\\»`)
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new FileBadRequestError(`Путь «${path}» абсолютный — нужен относительный от пространства`)
  }
  const segs: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new FileBadRequestError(`Путь «${path}» выходит из пространства («..»)`)
    segs.push(seg)
  }
  return segs.join('/')
}

/** Каталог пути: `a/b/c.md` → `a/b`, `c.md` → `''`, корень → `''`. */
export function parentFilePath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Путь лежит в корзине пространства (или это она сама). */
export function isTrashPath(path: string): boolean {
  return path === WORKSPACE_TRASH_DIR || path.startsWith(`${WORKSPACE_TRASH_DIR}/`)
}

// ────────────────────────────────────────────────────────────────────────────
// Типы файлов
// ────────────────────────────────────────────────────────────────────────────

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/tsx',
  py: 'text/x-python',
  sh: 'application/x-sh',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  wasm: 'application/wasm',
}

const TEXT_EXTENSIONS = new Set(TEXT_ATTACHMENT_EXTENSIONS)

/**
 * Mime по имени файла; `undefined` — тип неизвестен (UI рендерит по содержимому).
 * Исходники без собственного mime — `text/plain`: главное, что это текст.
 */
export function fileMime(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // Без точки — имя целиком (Dockerfile); дотфайл (.env) — хвост после точки.
  const ext = (dot === -1 ? base : base.slice(dot + 1)).toLowerCase()
  if (ext === '') return undefined
  return MIME_BY_EXTENSION[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : undefined)
}

// ────────────────────────────────────────────────────────────────────────────
// Содержимое
// ────────────────────────────────────────────────────────────────────────────

/** Отказ `read` по размеру — до чтения байтов: сообщение несёт размер и лимит. */
export function checkFileReadSize(path: string, size: number, maxBytes: number = DEFAULT_FILE_READ_MAX_BYTES): void {
  if (size > maxBytes) {
    throw new FileBadRequestError(
      `Файл «${path}» — ${formatBytes(size)} (${size} байт), лимит чтения — ${formatBytes(maxBytes)}`,
    )
  }
}

export interface FileContentInput {
  path: string
  data: Uint8Array
  revision: string
  /** Default — {@link fileMime} по пути. */
  mime?: string
}

/**
 * Байты → `FileContent`: UTF-8 без NUL — текстом (BOM сохраняется), иначе
 * base64. Одно правило на все бэкенды: иначе один и тот же файл приезжал бы то
 * текстом, то байтами.
 */
export function fileContent(input: FileContentInput): FileContent {
  const { path, data, revision } = input
  const text = utf8Text(data)
  const out: FileContent =
    text !== undefined
      ? { path, content: text, encoding: 'utf8', size: data.byteLength, revision }
      : { path, content: toBase64(data), encoding: 'base64', size: data.byteLength, revision }
  const mime = input.mime ?? fileMime(path)
  if (mime !== undefined) out.mime = mime
  return out
}

/**
 * Содержимое `write` → байты. Неизвестная кодировка или битый base64 —
 * `bad_request`: молча записать мусор хуже, чем отказать.
 */
export function decodeFileContent(content: string, encoding: FileEncoding = 'utf8'): Uint8Array {
  if (typeof content !== 'string') throw new FileBadRequestError('Содержимое файла должно быть строкой')
  if (encoding === 'utf8') return new TextEncoder().encode(content)
  if (encoding !== 'base64') throw new FileBadRequestError(`Кодировка «${String(encoding)}» не поддержана: utf8 или base64`)
  const clean = content.replace(/\s+/g, '')
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new FileBadRequestError('Содержимое не base64')
  }
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} Б`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} КБ`
  return `${(n / 1_000_000).toFixed(1)} МБ`
}

// ────────────────────────────────────────────────────────────────────────────
// .gitignore — `FileEntry.ignored`
// ────────────────────────────────────────────────────────────────────────────

/** Правило `.gitignore`: скомпилированный паттерн относительно каталога файла. */
export interface GitignoreRule {
  negate: boolean
  dirOnly: boolean
  re: RegExp
}

/**
 * Текст `.gitignore` → правила. Подмножество git, которого хватает для
 * пометки дерева: комментарии, `!`, `/` в конце (только каталоги), `/` в
 * начале или середине (якорь к каталогу файла), `*`, `?`, `**`, `[…]`, `\`.
 */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\) +$/, '')
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    const body = globToRegExp(line)
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) })
  }
  return rules
}

/**
 * Решение правил одного `.gitignore` по пути относительно его каталога:
 * последнее совпавшее побеждает; `undefined` — ни одно не совпало.
 */
export function matchGitignore(rules: readonly GitignoreRule[], path: string, isDir: boolean): boolean | undefined {
  let result: boolean | undefined
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.re.test(path)) result = !rule.negate
  }
  return result
}

/**
 * Игнорируется ли путь пространства (`FileEntry.ignored`).
 *
 * Всегда: `.git` и `node_modules` на любой глубине, корзина в корне. Дальше —
 * `.gitignore` каталогов от корня вниз, как у git: игнорируемый каталог
 * игнорирует всё внутри (исключение `!` внутрь него не пробивается), ближний
 * `.gitignore` перекрывает дальний. `rulesOf(dir)` — правила `.gitignore`
 * каталога (`''` — корень) или `undefined`, если файла нет.
 *
 * `isRepoRoot(dir)` — каталог со своим `.git`: вложенная репа.
 * Правила родителей на неё и внутрь не действуют, как у git (зонтичная папка
 * вроде nrlib игнорирует свои пакеты-репы, но это не мусор, а код).
 */
export function isIgnoredPath(
  path: string,
  isDir: boolean,
  rulesOf: (dir: string) => readonly GitignoreRule[] | undefined,
  isRepoRoot?: (dir: string) => boolean,
): boolean {
  if (path === '') return false
  const segs = path.split('/')
  if (segs[0] === WORKSPACE_TRASH_DIR) return true
  if (segs.some((s) => ALWAYS_IGNORED_NAMES.includes(s))) return true
  /** С какого каталога действуют правила: ближайший предок-репа (или сам путь-каталог). */
  let from = 0
  for (let i = 1; i <= segs.length; i++) {
    const sub = segs.slice(0, i).join('/')
    const subIsDir = i < segs.length || isDir
    if (subIsDir && isRepoRoot?.(sub)) {
      from = i
      continue
    }
    let decided: boolean | undefined
    for (let d = from; d < i; d++) {
      const dir = segs.slice(0, d).join('/')
      const rules = rulesOf(dir)
      if (!rules) continue
      const m = matchGitignore(rules, dir === '' ? sub : sub.slice(dir.length + 1), subIsDir)
      if (m !== undefined) decided = m
    }
    if (decided) return true
  }
  return false
}

function globToRegExp(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        const next = glob[i + 2]
        if (atSegmentStart && next === '/') {
          re += '(?:.*/)?'
          i += 2
          continue
        }
        if (atSegmentStart && next === undefined) {
          re += '.*'
          i += 1
          continue
        }
        i += 1 // `**` посреди сегмента — как `*`
      }
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) {
        re += '\\['
        continue
      }
      let cls = glob.slice(i + 1, end)
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
      re += `[${cls.replace(/\\/g, '\\\\')}]`
      i = end
    } else if (c === '\\' && i + 1 < glob.length) {
      re += escapeRegExp(glob[++i]!)
    } else {
      re += escapeRegExp(c)
    }
  }
  return re
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// ────────────────────────────────────────────────────────────────────────────
// Поиск по пространству — `workspace.files.search` (v1.28)
// ────────────────────────────────────────────────────────────────────────────

/** Строк в ответе `search` по умолчанию. */
export const DEFAULT_FILE_SEARCH_LIMIT = 500
/** Потолок `limit`: больше бэкенд не отдаёт, сколько ни проси. */
export const MAX_FILE_SEARCH_LIMIT = 5000
/** Текст строки в ответе — не длиннее (минифицированный бандл одной строкой). */
export const FILE_SEARCH_LINE_MAX = 400

/** Скомпилированный запрос поиска: одни правила у backend-fs (node-обход), memory-FS и проверки rg. */
export interface FileSearchMatcher {
  /** Индекс первого совпадения в строке, `-1` — нет. */
  match(line: string): number
  /** Путь проходит `glob` (нет `glob` — любой). */
  accepts(path: string): boolean
  limit: number
  /** Строка совпадения → хит (текст обрезан вокруг совпадения). */
  hit(path: string, lineNo: number, line: string, at: number): FileSearchHit
}

/**
 * Запрос с провода → матчер. Пустой `query`, битый regex, не та форма полей —
 * `bad_request`. Подстрока без `case` — без учёта регистра (`toLowerCase`
 * обеих сторон); regex — флаги `u` и `i` без `case`.
 */
export function compileFileSearch(q: FileSearchQuery): FileSearchMatcher {
  const v = q as Partial<Record<keyof FileSearchQuery, unknown>> | null
  if (typeof v !== 'object' || v === null) throw new FileBadRequestError('search: нужен объект запроса')
  if (typeof v.query !== 'string' || v.query === '') throw new FileBadRequestError('search: query — непустая строка')
  if (v.regex !== undefined && typeof v.regex !== 'boolean') throw new FileBadRequestError('search: regex — boolean')
  if (v.case !== undefined && typeof v.case !== 'boolean') throw new FileBadRequestError('search: case — boolean')
  if (v.glob !== undefined && typeof v.glob !== 'string') throw new FileBadRequestError('search: glob — строка')
  if (v.limit !== undefined && (typeof v.limit !== 'number' || !Number.isInteger(v.limit) || v.limit < 1)) {
    throw new FileBadRequestError('search: limit — целое ≥ 1')
  }
  const query = v.query
  const caseSensitive = v.case === true
  let match: (line: string) => number
  if (v.regex === true) {
    let re: RegExp
    try {
      re = new RegExp(query, caseSensitive ? 'u' : 'iu')
    } catch (err) {
      throw new FileBadRequestError(`search: regex «${query}»: ${err instanceof Error ? err.message : String(err)}`)
    }
    match = (line) => {
      const m = re.exec(line)
      return m ? m.index : -1
    }
  } else if (caseSensitive) {
    match = (line) => line.indexOf(query)
  } else {
    const needle = query.toLowerCase()
    match = (line) => line.toLowerCase().indexOf(needle)
  }
  const glob = v.glob === undefined || v.glob.trim() === '' ? undefined : fileGlobRegExp(v.glob.trim())
  const limit = Math.min(v.limit ?? DEFAULT_FILE_SEARCH_LIMIT, MAX_FILE_SEARCH_LIMIT)
  return {
    match,
    accepts: (path) => (glob ? glob.test(path) : true),
    limit,
    hit(path, lineNo, line, at) {
      let text = line.replace(/\r$/, '')
      let column = at + 1
      if (text.length > FILE_SEARCH_LINE_MAX) {
        const from = Math.max(0, Math.min(at - 80, text.length - FILE_SEARCH_LINE_MAX))
        text = (from > 0 ? '…' : '') + text.slice(from, from + FILE_SEARCH_LINE_MAX)
        column = at - from + 1 + (from > 0 ? 1 : 0)
      }
      return { path, line: lineNo, text, column }
    },
  }
}

/**
 * Glob фильтра поиска → regex по пути пространства. Без `/` — по имени файла
 * на любой глубине (`*.md`), с `/` — от корня (`docs/**\/*.md`); `{a,b}` —
 * альтернативы; несколько через запятую на верхнем уровне — любой из них.
 */
export function fileGlobRegExp(glob: string): RegExp {
  const parts = splitTopLevel(glob)
  const bodies = parts.map((g) => {
    const expanded = expandBraces(g.trim())
    return expanded
      .map((one) => {
        const anchored = one.includes('/')
        const body = globToRegExp(one.startsWith('/') ? one.slice(1) : one)
        return anchored ? body : `(?:.*/)?${body}`
      })
      .join('|')
  })
  return new RegExp(`^(?:${bodies.join('|')})$`)
}

function splitTopLevel(glob: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of glob) {
    if (c === '{') depth++
    if (c === '}') depth = Math.max(0, depth - 1)
    if (c === ',' && depth === 0) {
      if (cur.trim()) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open === -1) return [glob]
  const close = glob.indexOf('}', open)
  if (close === -1) return [glob]
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  return glob
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expandBraces(head + alt + tail))
}

// ────────────────────────────────────────────────────────────────────────────
// workspace_update на проводе (SSE `GET /workspace/events`)
// ────────────────────────────────────────────────────────────────────────────

export function isWorkspaceUpdateEvent(value: unknown): value is WorkspaceUpdateEvent {
  const v = value as { type?: unknown; paths?: unknown } | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.type === 'workspace_update' &&
    Array.isArray(v.paths) &&
    v.paths.every((p) => typeof p === 'string')
  )
}

/** Событие → SSE-кадр (тот же формат, что у событий рана, §9). */
export function serializeWorkspaceEvent(event: WorkspaceUpdateEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({ type: event.type, paths: event.paths })}\n\n`
}

/** SSE-кадр → событие; чужой или битый кадр — `null`, не throw. */
export function parseWorkspaceEvent(frame: string): WorkspaceUpdateEvent | null {
  const parsed = parseRunEvent(frame)
  return isWorkspaceUpdateEvent(parsed) ? { type: 'workspace_update', paths: [...parsed.paths] } : null
}
