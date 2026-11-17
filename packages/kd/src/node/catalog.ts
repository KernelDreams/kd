/**
 * Каталог тулов по слоям (kd-cli-spec §3): файлы `*.ts|*.mjs|*.md|*.mdz` и папки с `index.ts`
 * или `tool.mdz` в каталогах тулов каждого слоя. Объявление (§2) — `tool.mdz` рядом с `index.ts`,
 * `export const tool` модуля, `## $form` / `## $action` документа; нет — тул по-старому.
 *
 * Совпадение имён: пользовательский слой и сборки сильнее комплекта, комплект сильнее студийного
 * профиля (тихо, видно в `kd -v`); проект не перекрывает никого — громкая ошибка с обоими путями.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as nrd from '@kerneldreams/nrd'
import { describeScript, importScriptModule, parseFlags } from '@kerneldreams/runz-runtime'
import { declFromMdz, declFromObject, legacyDecl, type ToolDecl, type ToolObject } from '../core/decl.js'
import { KdError } from '../core/errors.js'
import type { Layer, LayerId, Layers } from './layers.js'

export interface ToolEntry {
  name: string
  /** Файл, который исполняется (`index.ts`, документ). */
  file: string
  /** Файл объявления, если отдельный (`tool.mdz`). */
  declFile?: string
  layer: LayerId
  layerLabel: string
}

export interface Catalog {
  tools: Map<string, ToolEntry>
  /** Перекрытые записи (для `kd -v`). */
  shadowed: Array<{ kept: ToolEntry; hidden: ToolEntry }>
  /** Конфликты проекта (громкая ошибка). */
  conflicts: Array<{ project: ToolEntry; other: ToolEntry }>
}

const EXT = /\.(ts|mjs|mdz|md)$/i
const NOT_TOOL = /(\.test\.ts|\.config\.md|\.d\.ts|^README\.md|^CLAUDE\.md|^AGENTS\.md|^MOVED\.md|^LICENSE.*|^CHANGELOG\.md|\.links\.mdz|^links\.mdz|^settings\.mdz)$/i

function scanDir(dir: string, layer: Layer): ToolEntry[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ToolEntry[] = []
  for (const e of entries) {
    if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isFile && EXT.test(e.name) && !NOT_TOOL.test(e.name)) out.push({ name: e.name.replace(EXT, ''), file: full, layer: layer.id, layerLabel: layer.label })
    else if (isDir) {
      const idx = ['index.ts', 'index.mjs'].map((f) => join(full, f)).find((f) => existsSync(f))
      const tool = join(full, 'tool.mdz')
      if (idx) out.push({ name: e.name, file: idx, layer: layer.id, layerLabel: layer.label, ...(existsSync(tool) ? { declFile: tool } : {}) })
      else if (existsSync(tool)) out.push({ name: e.name, file: tool, declFile: tool, layer: layer.id, layerLabel: layer.label })
    }
  }
  return out
}

/** Сила слоя при совпадении имён (проект — отдельно). */
const STRENGTH: Record<LayerId, number> = { studio: 0, kit: 1, app: 2, data: 3, shared: 4, project: -1 }

export function loadCatalog(l: Layers): Catalog {
  const tools = new Map<string, ToolEntry>()
  const shadowed: Catalog['shadowed'] = []
  const conflicts: Catalog['conflicts'] = []
  for (const layer of l.layers) {
    for (const dir of layer.toolDirs) {
      for (const t of scanDir(dir, layer)) {
        const have = tools.get(t.name)
        if (!have) {
          tools.set(t.name, t)
          continue
        }
        if (have.file === t.file) continue
        if (t.layer === 'project' || have.layer === 'project') {
          conflicts.push(t.layer === 'project' ? { project: t, other: have } : { project: have, other: t })
          continue
        }
        if (have.layer === t.layer) {
          // Внутри слоя первый каталог сильнее (как $paths runz).
          shadowed.push({ kept: have, hidden: t })
        } else if (STRENGTH[t.layer] > STRENGTH[have.layer]) {
          tools.set(t.name, t)
          shadowed.push({ kept: t, hidden: have })
        } else shadowed.push({ kept: have, hidden: t })
      }
    }
  }
  return { tools, shadowed, conflicts }
}

/** Конфликт проекта — код 2 с обоими путями. */
export function assertNoConflicts(c: Catalog): void {
  if (!c.conflicts.length) return
  const lines = c.conflicts.map((x) => `  ${x.project.name}: ${x.project.file} (проект) и ${x.other.file} (${x.other.layerLabel})`)
  throw new KdError(2, `kd: проект не перекрывает тулы комплекта и пользователя — переименуйте:\n${lines.join('\n')}`, { hint: 'переименуйте тул в .kd/tools проекта' })
}

/** Описание тула одной строкой без загрузки модуля. */
export function describeEntry(t: ToolEntry): string {
  if (t.declFile) {
    const m = /^\$description:\s*(.+)$/m.exec(readFileSync(t.declFile, 'utf8'))
    if (m) return m[1]!.trim()
  }
  if (/\.(ts|mjs)$/.test(t.file)) {
    // `export const tool = { description: '…' }` — без загрузки модуля.
    const m = /export const tool\b[^=]*=\s*\{[\s\S]*?\bdescription:\s*(['"`])(.*?)\1/.exec(readFileSync(t.file, 'utf8'))
    if (m) return m[2]!.trim()
  }
  return describeScript(t.file)
}

const isDoc = (f: string): boolean => /\.(md|mdz)$/i.test(f)

/** Объявление без загрузки модуля (документ, `tool.mdz`); `.ts` без `tool.mdz` — `null`. */
export function staticDecl(t: ToolEntry): ToolDecl | null {
  const file = t.declFile ?? (isDoc(t.file) ? t.file : null)
  if (!file) return null
  const text = readFileSync(file, 'utf8')
  const d = declFromMdz(nrd, t.name, text, file)
  if (d) return d
  const flags = /^\$flags:\s*(.+)$/m.exec(text)?.[1]
  return legacyDecl(t.name, describeEntry(t), flags ? parseFlags(flags) : null, t.file)
}

/** Объявление тула: документ, `tool.mdz`, `export const tool`, `export const flags` — по порядку. */
export async function loadDecl(t: ToolEntry): Promise<ToolDecl> {
  const st = staticDecl(t)
  if (st) return st
  if (!/\.(ts|mjs)$/.test(t.file)) return legacyDecl(t.name, describeEntry(t), null, t.file)
  const mod = await importScriptModule(t.file)
  if (mod.tool && typeof mod.tool === 'object') return declFromObject(t.name, mod.tool as ToolObject, t.file)
  return legacyDecl(t.name, describeEntry(t), parseFlags(mod.flags), t.file)
}

export const toolName = (file: string): string => basename(file).replace(EXT, '')
