/**
 * Пути файловых тулов (tools-spec §4): относительно `cwd` сессии, `~` —
 * домашний каталог, `@` в начале снимается (модели пишут `@src/a.ts`, как в
 * pi). Выход за `cwd` — только при `scope: 'any'` (у владельца стенда
 * это дефолт, у гостя — `cwd` без права перебить; см. `agent-tools.ts`).
 *
 * Порт `pi-nrchat/packages/coding-agent/src/core/tools/path-utils.ts` (MIT,
 * Mario Zechner): варианты имени macOS (NFD, U+202F перед AM/PM скриншотов,
 * U+2019 вместо апострофа) — для чтения существующих файлов.
 */

import { dirname, isAbsolute, isInside, relative, resolve, sep, type Fs } from '@kerneldreams/chat-store/fs'

/** `cwd` — только он и вглубь; `any` — любой путь (владелец стенда; явная политика профиля `$fs_scope`). */
export type FsScope = 'cwd' | 'any'

export interface FsRoot {
  cwd: string
  scope?: FsScope
  /**
   * Каталоги только для чтения вне `cwd` (`read`/`ls`/`find`/`grep`): файлы
   * скиллов рана в кэше (backend-nr-spec §6). Запись туда — по `scope`, как везде.
   */
  readRoots?: string[]
  /**
   * Источники скиллов каталога (имя + каталог): путь внутри такого каталога в
   * ошибке «вне каталога» получает подсказку «загрузи скилл через skill».
   */
  skillSources?: () => Promise<SkillSource[]>
  /** Носитель хоста: пути и симлинки — через него. */
  fs: Fs
  /** Домашний каталог для `~`; нет — `~` не раскрывается. */
  home?: string
}

export interface SkillSource {
  name: string
  dir: string
}

const UNICODE_SPACES = /[  -   　]/g

/** Путь модели → абсолютный (без проверки границы). */
export function expandPath(path: string, cwd: string, home?: string): string {
  let p = path.replace(UNICODE_SPACES, ' ').trim()
  if (p.startsWith('@')) p = p.slice(1)
  if (home && p === '~') return resolve(home)
  if (home && p.startsWith('~/')) return resolve(home, p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** Ошибка границы — текст для модели. */
export class PathOutsideError extends Error {
  constructor(path: string, skill?: string) {
    super(
      `path outside workspace: ${path} (workspace: the session cwd; paths must stay inside it)` +
        (skill ? `. This path is the source of the skill "${skill}": load it with the skill tool (name: "${skill}") instead of reading it.` : ''),
    )
    this.name = 'PathOutsideError'
  }
}

/** Скилл каталога, в чьём каталоге лежит путь; нет — `undefined`. */
async function skillOf(root: FsRoot, real: string): Promise<string | undefined> {
  if (!root.skillSources) return undefined
  try {
    for (const s of await root.skillSources()) if (isInside(await realOf(root.fs, resolve(s.dir)), real)) return s.name
  } catch {
    /* подсказка не обязательна */
  }
  return undefined
}

/**
 * Абсолютный путь внутри корня. Симлинки резолвятся по существующей части
 * пути: ссылка наружу — тоже выход.
 */
export async function resolveIn(root: FsRoot, path: string): Promise<string> {
  const abs = expandPath(path || '.', root.cwd, root.home)
  if (root.scope === 'any') return abs
  const base = await realOf(root.fs, resolve(root.cwd))
  const real = await realOf(root.fs, abs)
  if (!isInside(base, real)) throw new PathOutsideError(path, await skillOf(root, real))
  return abs
}

/** Как {@link resolveIn}, но внутри `readRoots` тоже можно (только для чтения). */
export async function resolveReadableIn(root: FsRoot, path: string): Promise<string> {
  try {
    return await resolveIn(root, path)
  } catch (err) {
    if (!(err instanceof PathOutsideError) || !root.readRoots?.length) throw err
    const abs = expandPath(path || '.', root.cwd, root.home)
    const real = await realOf(root.fs, abs)
    for (const r of root.readRoots) if (isInside(await realOf(root.fs, resolve(r)), real)) return abs
    throw err
  }
}

/** Для чтения: если файла нет — варианты имени macOS (pi `resolveReadPath`). */
export async function resolveReadIn(root: FsRoot, path: string): Promise<string> {
  const abs = await resolveReadableIn(root, path)
  if (await root.fs.exists(abs)) return abs
  const amPm = abs.replace(/ (AM|PM)\./gi, ' $1.')
  const nfd = abs.normalize('NFD')
  const curly = abs.replace(/'/g, '’')
  const nfdCurly = nfd.replace(/'/g, '’')
  for (const v of [amPm, nfd, curly, nfdCurly]) if (v !== abs && (await root.fs.exists(v))) return resolveReadableIn(root, v)
  return abs
}

/** Путь для показа модели: относительно cwd, если внутри; иначе как есть. */
export function displayPath(root: FsRoot, abs: string): string {
  const rel = relative(root.cwd, abs)
  if (rel === '') return '.'
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  return abs
}

/** realpath существующей части пути + хвост как есть. */
async function realOf(fs: Fs, abs: string): Promise<string> {
  let head = abs
  const tail: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(head)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(head)
      if (parent === head) return abs
      tail.push(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      head = parent
    }
  }
}
