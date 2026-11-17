/**
 * Пакеты по хэшу содержимого (compute-pool-spec §6). Имя пакета — sha256
 * манифеста (отсортированные `путь, режим, sha файла`), а не байтов архива: tar
 * несёт mtime, а один и тот же код должен давать один хэш на любой машине.
 * Перевозка — `tar.gz` (системный tar, есть на darwin и linux).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export interface Pack {
  sha: string
  /** `tar.gz` файлов пакета. */
  bytes: Buffer
  files: string[]
  /** Рабочая копия с правками без коммита (§6 «dirty»). */
  dirty?: boolean
}

const SKIP = new Set(['.git', 'node_modules', '.nr-trash', '.DS_Store'])

/** Все файлы каталога (без `.git`, `node_modules`), пути от корня, `/`-разделитель. */
export function walk(root: string): string[] {
  const out: string[] = []
  const go = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (SKIP.has(name)) continue
      const p = join(d, name)
      let st = lstatSync(p)
      // Вход-ссылка (`link: true`) — едет содержимым.
      if (st.isSymbolicLink()) {
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (!st.isFile()) continue
      }
      if (st.isDirectory()) go(p)
      else if (st.isFile()) out.push(relative(root, p).split(sep).join('/'))
    }
  }
  go(root)
  return out
}

/** sha256 манифеста файлов: одинаковое содержимое — одинаковый хэш. */
export function manifestSha(root: string, files: string[]): string {
  const h = createHash('sha256')
  for (const f of [...files].sort()) {
    const p = join(root, f)
    const mode = statSync(p).mode & 0o111 ? 'x' : '-'
    h.update(`${f}\0${mode}\0${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`)
  }
  return h.digest('hex')
}

/** Упаковать файлы (`files` — от `root`; нет — весь каталог). */
export function pack(root: string, files?: string[]): Pack {
  const list = (files ?? walk(root)).filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile())
  const sha = manifestSha(root, list)
  const bytes = list.length === 0
    ? execFileSync('tar', ['-czf', '-', '-T', '/dev/null'], { cwd: root })
    : execFileSync('tar', ['-czhf', '-', '-T', '-'], { cwd: root, input: list.join('\n') + '\n', maxBuffer: 4 * 1024 ** 3 })
  return { sha, bytes, files: list }
}

/** Распаковать `tar.gz` в каталог. */
export function unpack(bytes: Buffer, to: string): void {
  mkdirSync(to, { recursive: true })
  execFileSync('tar', ['-xzf', '-'], { cwd: to, input: bytes, maxBuffer: 64 * 1024 ** 2 })
}

const git = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export interface CodePack extends Pack {
  /** Путь документа внутри пакета. */
  entry: string
  /** Рабочий каталог задачи внутри пакета (`.` — корень). */
  cwd: string
}

/**
 * Код задачи (§6 «код»): репа документа — файлы под git (`ls-files -co
 * --exclude-standard`: закоммиченное и новое, правки как есть, `dirty` — если
 * есть незакоммиченное); вне git — каталог документа целиком.
 */
export function packCode(target: string, cwd: string): CodePack {
  const dir = dirname(target)
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  let root: string
  let files: string[]
  let dirty = false
  if (top) {
    root = top
    files = (git(top, ['ls-files', '-co', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean)
    dirty = (git(top, ['status', '--porcelain']) ?? '') !== ''
  } else {
    root = dir
    files = walk(dir)
  }
  const p = pack(root, files)
  const rel = (x: string): string => relative(root, x).split(sep).join('/') || '.'
  const inside = (x: string): boolean => !relative(root, x).startsWith('..')
  const out: CodePack = { ...p, entry: rel(target), cwd: inside(cwd) ? rel(cwd) : '.' }
  if (dirty) out.dirty = true
  return out
}
