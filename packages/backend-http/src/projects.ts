/**
 * Проекты стенда (projects-spec §1–3, протокол v1.26): реестр — у хоста.
 *
 * Бэкенд знает реестр только интерфейсом `ProjectsRegistry`: файлы
 * `projects/<id>.mdz` читает и пишет хост (appz/pi), фикстуры — память
 * (`createMemoryProjects`). Проект `default` (`$root` = `$cwd` стенда) реестр
 * отдаёт сам: сессии без пометки проекта живут в нём, файлы не переносятся.
 *
 * Пути записи — уже раскрытые (`~` → home): бэкенд проверяет и пишет их как есть.
 */

import { DEFAULT_PROJECT_ID, isProjectId, projectIdOf } from '@kerneldreams/ui-protocol'
import type { WorkspaceInfo, WorkspaceProject, WorkspaceProjectPatch } from '@kerneldreams/ui-protocol'

/** Проект реестра: запись + id (имя файла). */
export interface ProjectEntry extends WorkspaceProject {
  id: string
  /**
   * Каталог проекта в реестре (`projects/<id>/`: слепки `profiles/`, память
   * `memory/`) — для хоста и бэкендов; наружу (`WorkspaceInfo.project`) не уходит.
   */
  dir?: string
}

/** Реестр проектов стенда. `list` — всегда с `default`. */
export interface ProjectsRegistry {
  list(): ProjectEntry[] | Promise<ProjectEntry[]>
  /** capability workspace.edit: новый проект (id свободен — проверено бэкендом). */
  create?(entry: ProjectEntry): Promise<ProjectEntry>
  /** capability workspace.edit: правка; `null` в патче — снять поле. */
  update?(id: string, patch: WorkspaceProjectPatch): Promise<ProjectEntry>
  /**
   * Раскрыть путь записи с провода (`~/…` → домашний каталог хоста) до проверки:
   * форма шлёт пути как их пишет человек. Нет — пути как есть (абсолютные).
   */
  expand?(path: string): string
}

/** Проекта с таким id в реестре нет. */
export class ProjectNotFoundError extends Error {
  readonly code = 'not_found'
  constructor(id: string) {
    super(`backend-store: проекта ${id} нет в реестре`)
    this.name = 'ProjectNotFoundError'
  }
}

/** Id проекта занят (`workspace.create`). */
export class ProjectConflictError extends Error {
  readonly code = 'conflict'
  constructor(id: string) {
    super(`backend-store: проект ${id} уже есть`)
    this.name = 'ProjectConflictError'
  }
}

/** Запись проекта негодна (нет `name`/`root`, чужой тип поля). */
export class ProjectBadRequestError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(`backend-store: проект — ${message}`)
    this.name = 'ProjectBadRequestError'
  }
}

/** Проект → `WorkspaceInfo` провода (`kind: 'project'`, `path` = `$root`). */
export function projectInfo(p: ProjectEntry): WorkspaceInfo {
  const { id, dir: _dir, ...project } = p
  return {
    id,
    name: p.name,
    path: p.root,
    kind: 'project',
    ...(p.description ? { description: p.description } : {}),
    project: structuredClone(project),
  }
}

const STRING_FIELDS = ['name', 'description', 'root', 'context', 'profile', 'model', 'engine', 'projektor', 'claudeAccount', 'claudeAccountLeftover'] as const
const LIST_FIELDS = ['dirs', 'skills', 'plugins', 'reads', 'projects', 'aliases'] as const
const ROLES = new Set(['owner', 'editor', 'viewer'])

/**
 * Проверка записи с провода: строки — строками, списки — строк, `name`/`root`
 * не пустые (`partial` — патч: поля могут отсутствовать, `null` — снять,
 * кроме `name`/`root`). Лишние поля отбрасываются.
 */
export function checkProject(v: unknown, partial: false): WorkspaceProject
export function checkProject(v: unknown, partial: true): WorkspaceProjectPatch
export function checkProject(v: unknown, partial: boolean): WorkspaceProject | WorkspaceProjectPatch {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ProjectBadRequestError('ожидается объект')
  const src = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of STRING_FIELDS) {
    const x = src[k]
    if (x === undefined) continue
    if (x === null && partial && k !== 'name' && k !== 'root') {
      out[k] = null
      continue
    }
    if (typeof x !== 'string') throw new ProjectBadRequestError(`${k}: ожидается строка`)
    const t = x.trim()
    if (t.includes('\n')) throw new ProjectBadRequestError(`${k}: одна строка`)
    if (t === '' && (k === 'name' || k === 'root')) throw new ProjectBadRequestError(`${k}: пусто`)
    out[k] = t === '' && partial ? null : t
  }
  for (const k of LIST_FIELDS) {
    const x = src[k]
    if (x === undefined) continue
    if (x === null && partial) {
      out[k] = null
      continue
    }
    if (!Array.isArray(x) || !x.every((i) => typeof i === 'string')) throw new ProjectBadRequestError(`${k}: ожидается список строк`)
    out[k] = (x as string[]).map((i) => i.trim()).filter(Boolean)
  }
  // Участники (v1.30, users-spec §3): {id: owner|editor|viewer}.
  const m = src.members
  if (m === null && partial) out.members = null
  else if (m !== undefined) {
    if (typeof m !== 'object' || Array.isArray(m)) throw new ProjectBadRequestError('members: ожидается {пользователь: роль}')
    const mm: Record<string, string> = {}
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(k)) throw new ProjectBadRequestError(`members: id «${k}»`)
      if (typeof v !== 'string' || !ROLES.has(v)) throw new ProjectBadRequestError(`members.${k}: роль owner | editor | viewer`)
      mm[k] = v
    }
    out.members = Object.keys(mm).length ? mm : partial ? null : undefined
    if (out.members === undefined) delete out.members
  }
  if (!partial) {
    if (out.name === undefined) throw new ProjectBadRequestError('нет name')
    if (out.root === undefined) throw new ProjectBadRequestError('нет root')
    for (const k of Object.keys(out)) if (out[k] === '' || (Array.isArray(out[k]) && !(out[k] as unknown[]).length)) delete out[k]
  }
  return out as unknown as WorkspaceProject
}

/** Id нового проекта: заданный (проверка формы) или из имени; занят — `conflict`. */
export function newProjectId(want: string | undefined, name: string, taken: Iterable<string>): string {
  const busy = new Set(taken)
  if (want !== undefined) {
    if (!isProjectId(want)) throw new ProjectBadRequestError(`id «${want}» — не имя файла (латиница, цифры, -, _)`)
    if (busy.has(want)) throw new ProjectConflictError(want)
    return want
  }
  const base = projectIdOf(name)
  if (!busy.has(base)) return base
  for (let i = 2; ; i++) if (!busy.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Пути записи (`root`, `dirs`, `context`, `plugins`) — через `expand` реестра. */
export function expandProject<T extends WorkspaceProject | WorkspaceProjectPatch>(p: T, expand: ((path: string) => string) | undefined): T {
  if (!expand) return p
  const out: Record<string, unknown> = { ...p }
  for (const k of ['root', 'context'] as const) if (typeof out[k] === 'string') out[k] = expand(out[k] as string)
  for (const k of ['dirs', 'plugins', 'projects'] as const) if (Array.isArray(out[k])) out[k] = (out[k] as string[]).map(expand)
  return out as T
}

/** Патч поверх записи: `null` — снять, `undefined` — оставить. */
export function patchProject(p: ProjectEntry, patch: WorkspaceProjectPatch): ProjectEntry {
  const next: Record<string, unknown> = { ...p }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null) delete next[k]
    else next[k] = v
  }
  return next as unknown as ProjectEntry
}

/**
 * Реестр в памяти (фикстуры, тесты): `default` с `root` и записи опции.
 * `edit: false` — без create/update.
 */
export function createMemoryProjects(opts: { root: string; projects?: ProjectEntry[]; edit?: boolean }): ProjectsRegistry {
  const items = new Map<string, ProjectEntry>()
  items.set(DEFAULT_PROJECT_ID, { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_ID, root: opts.root })
  for (const p of opts.projects ?? []) items.set(p.id, structuredClone(p))
  const reg: ProjectsRegistry = { list: () => [...items.values()].map((p) => structuredClone(p)) }
  if (opts.edit === false) return reg
  reg.create = async (entry) => {
    items.set(entry.id, structuredClone(entry))
    return structuredClone(entry)
  }
  reg.update = async (id, patch) => {
    const cur = items.get(id)
    if (!cur) throw new ProjectNotFoundError(id)
    const next = patchProject(cur, patch)
    items.set(id, next)
    return structuredClone(next)
  }
  return reg
}
