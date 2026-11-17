/**
 * Пространства и проекты — чистая часть (spaces-spec §1, §4): без
 * node-модулей (store-backend собирается и в браузер). ФС — у реестра проектов
 * хоста (`createRepos` из `./repos.js`, node).
 */

import type { ProjectInfo } from '@kerneldreams/ui-protocol'
import type { ProjectEntry } from './projects.js'

/** Блок префикса (как `PrefixBlock` билдера nr-chat-store). */
export interface RepoPrefixBlock {
  source: string
  text: string
}

/** Проекты пространств на диске (`workspace.repos`): у хоста — `createRepos()`. */
export interface ReposSource {
  list(space: ProjectEntry): ProjectInfo[]
  find(space: ProjectEntry, id: string): ProjectInfo | undefined
  /** Проект старой записи-алиаса (`$aliases`): тот, чей корень — её `$root`. */
  ofRoot(space: ProjectEntry, root: string | undefined): ProjectInfo | undefined
  /** Текст файла префикса; нет файла — `undefined`. */
  readText(path: string): Promise<string | undefined>
}

/** Пространство, в котором видна сессия с пометкой `ws`: то, чей `$aliases` её содержит, иначе само. */
export function spaceOfSession(spaces: readonly ProjectEntry[], ws: string): ProjectEntry | undefined {
  return spaces.find((s) => s.aliases?.includes(ws)) ?? spaces.find((s) => s.id === ws)
}

/** Id записей-алиасов (их id — в `$aliases` другой записи). */
export function aliasIds(spaces: readonly ProjectEntry[]): Set<string> {
  const out = new Set<string>()
  for (const s of spaces) for (const a of s.aliases ?? []) if (a !== s.id) out.add(a)
  return out
}

const fileBlock = (path: string, text: string): string => `<file path="${path}">\n${text.replace(/\n+$/, '')}\n</file>`
const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p

/**
 * Блоки префикса сессии (spaces-spec §4): контекст проекта — «Проект <id> (<root>)»
 * и его файлы; затем доп. скиллы — `SKILL.md` каждого. `skillDir` — папка
 * скилла по имени (кэш skillbox / `$skills_dir`); не нашлась — в `missing`.
 */
export async function repoPrefix(
  repo: ProjectInfo | undefined,
  skills: readonly string[] | undefined,
  readText: (path: string) => Promise<string | undefined>,
  skillDir?: (names: string[]) => Promise<Array<{ name: string; dir: string }>>,
): Promise<{ blocks: RepoPrefixBlock[]; files: string[]; missing: string[] }> {
  const blocks: RepoPrefixBlock[] = []
  const files: string[] = []
  const missing: string[] = []
  const read = (p: string): Promise<string | undefined> => readText(p).catch(() => undefined)
  if (repo) {
    const parts = [`Проект ${repo.id} (${repo.root})${repo.context && repo.context !== repo.root ? `, контекст-пакет ${repo.context}` : ''}.`]
    for (const f of repo.files) {
      const text = await read(f)
      if (text === undefined) continue
      files.push(f)
      parts.push(fileBlock(f, text))
    }
    blocks.push({ source: 'project', text: parts.join('\n\n') })
  }
  const want = [...new Set((skills ?? []).map((s) => s.trim()).filter(Boolean))]
  if (want.length) {
    const found = skillDir ? await skillDir(want).catch(() => []) : []
    for (const name of want) {
      const dir = (found.find((s) => s.name === name)?.dir ?? (name.startsWith('/') ? name : undefined))?.replace(/\/+$/, '')
      const path = dir ? `${dir}/SKILL.md` : undefined
      const text = path ? await read(path) : undefined
      if (text === undefined || !path) {
        missing.push(name)
        continue
      }
      files.push(path)
      blocks.push({ source: `skill:${baseName(dir!)}`, text: fileBlock(path, text) })
    }
  }
  return { blocks, files, missing }
}
