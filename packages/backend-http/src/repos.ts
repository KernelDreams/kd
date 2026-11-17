/**
 * Проекты пространства на диске (spaces-spec §2, протокол v1.35).
 *
 * Пространство (запись реестра) находит проекты само — по маскам `$projects`:
 * путь или `<каталог>/*` (`*` — один уровень, можно `pre-*`). Проект — каталог
 * из маски, кроме `*.dev`, `*.skills` и скрытых. `id` — имя каталога; конфликт
 * имён внутри пространства — `<родитель>/<имя>`.
 *
 * Контекст-пакет проекта: `<root>.dev` рядом → `<root>/<имя>.dev` → `SKILL.md` в
 * корне. В префикс идут `SKILL.md` и `HANDOFF.md` пакета (что есть).
 * `<root>/.nrchat/project.mdz` перебивает: `$context`, `$files`, `$skills`,
 * `$agent`, `$model`.
 *
 * Список — лениво, кэш с инвалидацией по mtime каталогов масок.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProjectInfo } from '@kerneldreams/ui-protocol'
import type { ProjectEntry } from './projects.js'
import type { ReposSource } from './repos-core.js'

export { aliasIds, repoPrefix, spaceOfSession, type RepoPrefixBlock, type ReposSource } from './repos-core.js'

const CONTEXT_FILES = ['SKILL.md', 'HANDOFF.md']

const expand = (p: string, home: string): string => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p)

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** Каталог годится в проекты: не пакет контекста/скиллов, не скрытый. */
const isRepoName = (name: string): boolean => !name.startsWith('.') && !name.endsWith('.dev') && !name.endsWith('.skills')

/** `pre-*` → RegExp имени. */
function nameRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

/** Маска → каталоги-кандидаты (абсолютные, по имени). */
export function expandMask(mask: string, home = homedir()): string[] {
  const p = expand(mask.trim(), home).replace(/\/+$/, '')
  if (!p || !isAbsolute(p)) return []
  const last = basename(p)
  if (!last.includes('*') && !last.includes('?')) return isDir(p) ? [p] : []
  const parent = dirname(p)
  if (/[*?]/.test(parent)) return []
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return []
  }
  const re = nameRe(last)
  return names
    .filter((n) => isRepoName(n) && re.test(n) && isDir(join(parent, n)))
    .sort()
    .map((n) => join(parent, n))
}

/** `.nrchat/project.mdz`: строки `$ключ: значение` (`$[a, b]` — список). */
export function readProjectOverride(root: string): { context?: string; files?: string[]; skills?: string[]; agent?: string; model?: string } {
  const file = join(root, '.nrchat', 'project.mdz')
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return {}
  }
  const out: Record<string, string | string[]> = {}
  for (const line of text.split('\n')) {
    const m = /^\$([A-Za-z_]\w*)\s*:\s*(.*?)\s*(?:\/\/.*)?$/.exec(line)
    if (!m) continue
    const raw = m[2]!.trim()
    const list = /^\$?\[(.*)\]$/.exec(raw)
    const unq = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2')
    out[m[1]!] = list ? list[1]!.split(',').map(unq).filter(Boolean) : unq(raw)
  }
  const str = (k: string): string | undefined => (typeof out[k] === 'string' && out[k] ? (out[k] as string) : undefined)
  const arr = (k: string): string[] | undefined => (Array.isArray(out[k]) ? (out[k] as string[]) : typeof out[k] === 'string' && out[k] ? [out[k] as string] : undefined)
  return {
    ...(str('context') ? { context: str('context')! } : {}),
    ...(arr('files') ? { files: arr('files')! } : {}),
    ...(arr('skills') ? { skills: arr('skills')! } : {}),
    ...(str('agent') ? { agent: str('agent')! } : {}),
    ...(str('model') ? { model: str('model')! } : {}),
  }
}

/** Проект по корню: контекст-пакет, файлы префикса, перебивка `.nrchat/project.mdz`. */
export function repoInfo(root: string, id: string, home = homedir()): ProjectInfo {
  const name = basename(root)
  const own = readProjectOverride(root)
  const abs = (p: string): string => {
    const e = expand(p, home)
    return isAbsolute(e) ? e : resolve(root, e)
  }
  let context: string | undefined
  if (own.context) context = abs(own.context)
  else if (isDir(`${root}.dev`)) context = `${root}.dev`
  else if (isDir(join(root, `${name}.dev`))) context = join(root, `${name}.dev`)
  else if (existsSync(join(root, 'SKILL.md'))) context = root
  const files = own.files
    ? own.files.map(abs).filter((f) => existsSync(f))
    : context
      ? CONTEXT_FILES.map((f) => join(context!, f)).filter((f) => existsSync(f))
      : []
  return {
    id,
    name,
    root,
    ...(context ? { context } : {}),
    files,
    ...(own.skills?.length ? { skills: own.skills } : {}),
    ...(own.agent ? { agent: own.agent } : {}),
    ...(own.model ? { model: own.model } : {}),
  }
}

/** Проекты пространства по маскам `$projects` (без кэша). */
export function listRepos(space: Pick<ProjectEntry, 'projects'>, home = homedir()): ProjectInfo[] {
  const roots: string[] = []
  for (const mask of space.projects ?? []) for (const r of expandMask(mask, home)) if (!roots.includes(r)) roots.push(r)
  const byName = new Map<string, number>()
  for (const r of roots) byName.set(basename(r), (byName.get(basename(r)) ?? 0) + 1)
  return roots.map((r) => repoInfo(r, byName.get(basename(r))! > 1 ? `${basename(dirname(r))}/${basename(r)}` : basename(r), home))
}

/**
 * Реестр проектов с кэшем: ключ — пространство, подпись — маски и mtime их
 * каталогов (появился/пропал каталог — список заново).
 */
export function createRepos(opts: { home?: string } = {}): ReposSource {
  const home = opts.home ?? homedir()
  const cache = new Map<string, { sig: string; list: ProjectInfo[] }>()
  const sigOf = (space: ProjectEntry): string =>
    (space.projects ?? [])
      .map((m) => {
        const p = expand(m, home).replace(/\/+$/, '')
        const at = /[*?]/.test(basename(p)) ? dirname(p) : p
        return `${m}@${mtime(at)}`
      })
      .join('|')
  const list = (space: ProjectEntry): ProjectInfo[] => {
    if (!space.projects?.length) return []
    const sig = sigOf(space)
    const hit = cache.get(space.id)
    if (hit && hit.sig === sig) return hit.list
    const got = listRepos(space, home)
    cache.set(space.id, { sig, list: got })
    return got
  }
  return {
    list,
    find: (space, id) => list(space).find((r) => r.id === id),
    ofRoot: (space, root) => (root ? list(space).find((r) => r.root === root.replace(/\/+$/, '')) : undefined),
    readText: (path) => readFile(path, 'utf-8').catch(() => undefined),
  }
}

