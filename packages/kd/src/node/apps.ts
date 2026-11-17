/**
 * Регистрация сборок в общем слое (kd-cli-spec §10): один файл `~/.kd/apps/<id>.mdz` — путь к сборке,
 * её тулы и правила объектов. Пишется через временный файл и переименование, удаляется при снятии.
 * Сборки по пути нет или запись не читается — каталог её пропускает с сообщением (`layers.ts`).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAttrs, strList } from './home.js'
import { SHARED_FORMAT } from './layers.js'

export interface AppRegistration {
  id: string
  /** Корень сборки. */
  path: string
  /** Каталоги тулов (от корня сборки). */
  tools?: string[]
  /** Файлы правил объектов (от корня сборки). */
  links?: string[]
  name?: string
  version?: string
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

export const appsDir = (sharedHome: string): string => join(sharedHome, 'apps')

const q = (s: string): string => JSON.stringify(s)

export function registerApp(sharedHome: string, r: AppRegistration): string {
  if (!ID_RE.test(r.id)) throw new Error(`id сборки «${r.id}»: только a-z, 0-9, . _ -`)
  const dir = appsDir(sharedHome)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${r.id}.mdz`)
  const lines = [`$format: ${SHARED_FORMAT}`, `$path: ${q(r.path)}`]
  if (r.name) lines.push(`$name: ${q(r.name)}`)
  if (r.version) lines.push(`$version: ${q(r.version)}`)
  if (r.tools?.length) lines.push(`$tools: $[${r.tools.map(q).join(', ')}]`)
  if (r.links?.length) lines.push(`$links: $[${r.links.map(q).join(', ')}]`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, lines.join('\n') + '\n')
  renameSync(tmp, file)
  return file
}

export function unregisterApp(sharedHome: string, id: string): boolean {
  const file = join(appsDir(sharedHome), `${id}.mdz`)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

export function listApps(sharedHome: string): Array<AppRegistration & { ok: boolean }> {
  const dir = appsDir(sharedHome)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mdz'))
    .map((f) => {
      const a = readAttrs(join(dir, f)) ?? {}
      const path = typeof a.path === 'string' ? a.path : ''
      return { id: f.replace(/\.mdz$/, ''), path, tools: strList(a.tools), links: strList(a.links), ok: !!path && existsSync(path), ...(typeof a.name === 'string' ? { name: a.name } : {}) }
    })
}
