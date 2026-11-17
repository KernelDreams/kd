/**
 * «Что угодно → тул» (kd-cli-spec §4): правила ссылок слоёв `kd` — `links.mdz` слоёв и тулов
 * (`<тул>/links.mdz` рядом с `index.ts`: тул приносит свои правила объектов). Разбор и
 * сопоставление — общая библиотека `@kerneldreams/ui-protocol/links-rules`.
 *
 * Действие для `kd` — `## $action <вид>.<слово>` с `$run: kd` и `$cmd` (слова вызова `kd` с `${}`:
 * `text` — слово целиком, группы шаблона по имени и номером `g1…`), `exec` (команда шелла)
 * или `script` (модуль с default-функцией).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as nrdModule from '@kerneldreams/nrd'
import type { LinkActionDef, LinkLayer, LinkRuleDef, LinkRules } from '@kerneldreams/ui-protocol'
import { actionsFor, matchWord, mergeLinkRules, parseLinksText, type LayeredLinksFile, type LinkMatch, type LinksNrd } from '@kerneldreams/ui-protocol/links-rules'
import type { Catalog } from './catalog.js'
import { expandHome } from './home.js'
import type { LayerId, Layers } from './layers.js'

const nrd = nrdModule as unknown as LinksNrd

/** Слой kd → слой каскада правил (меньше — сильнее): пользователь сильнее сборок, сборки — студии, студия — комплекта; проект слабее всех. */
const LINK_LAYER: Record<LayerId, LinkLayer> = { shared: 'agent', data: 'space', app: 'space', studio: 'user', kit: 'stand', project: 'stand' }

/** Порядок файлов правил: сильный слой первым. */
export function linkFiles(l: Layers, c: Catalog): Array<{ layer: LayerId; file: string }> {
  const out: Array<{ layer: LayerId; file: string }> = []
  for (const layer of l.layers) {
    for (const f of layer.linkFiles) out.push({ layer: layer.id, file: f })
  }
  for (const t of c.tools.values()) {
    const f = join(dirname(t.file), 'links.mdz')
    if (/index\.(ts|mjs)$|tool\.mdz$/.test(t.file) && existsSync(f)) out.push({ layer: t.layer, file: f })
  }
  const rank: Record<LinkLayer, number> = { agent: 0, space: 1, user: 2, stand: 3 }
  return out.sort((a, b) => rank[LINK_LAYER[a.layer]] - rank[LINK_LAYER[b.layer]] || (a.layer === 'project' ? 1 : 0) - (b.layer === 'project' ? 1 : 0))
}

export function loadRules(l: Layers, c: Catalog, warn: (s: string) => void = () => {}): LinkRules {
  const files: LayeredLinksFile[] = []
  const seen = new Set<string>()
  const walk = (layer: LayerId, file: string, depth: number): void => {
    if (seen.has(file) || depth > 4 || !existsSync(file)) return
    seen.add(file)
    try {
      const parsed = parseLinksText(nrd, file, readFileSync(file, 'utf8'), LINK_LAYER[layer])
      files.push({ layer: LINK_LAYER[layer], trusted: true, file: parsed })
      for (const inc of parsed.includes) {
        const e = expandHome(inc)
        walk(layer, isAbsolute(e) ? e : resolvePath(dirname(file), e), depth + 1)
      }
    } catch (err) {
      warn(`${file}: правила не разобраны — ${(err as Error).message}`)
    }
  }
  for (const { layer, file } of linkFiles(l, c)) walk(layer, file, 0)
  return mergeLinkRules(files)
}

const KIND_BY_EXT: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image', psd: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  pdf: 'pdf', md: 'text', mdz: 'text', mdd: 'text', txt: 'text', json: 'text',
  mds: 'session',
}

/** Виды файла: `file` + по расширению (`image`, `audio`, …). */
export function fileKinds(path: string): string[] {
  const ext = extname(path).slice(1).toLowerCase()
  return ['file', ...(KIND_BY_EXT[ext] ? [KIND_BY_EXT[ext]!] : []), ...(ext ? [`.${ext}`] : [])]
}

export const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Виды слова для раскладки по полям (§5): правила ссылок + файл. */
export function wordKinds(word: string, rules: LinkRules, cwd: string): string[] {
  const kinds = new Set<string>()
  for (const m of matchWord(word, rules.links)) if (m.rule.kind) kinds.add(m.rule.kind)
  if (/^https?:\/\//.test(word)) kinds.add('url')
  const p = resolvePath(cwd, expandHome(word))
  if (isFile(p)) for (const k of fileKinds(p)) kinds.add(k)
  return [...kinds]
}

/** Правило-объект для файла: синтетическое правило вида по расширению. */
export function fileRule(path: string): LinkRuleDef[] {
  return fileKinds(path).map((k) => ({ id: `file:${k}`, layer: 'stand' as const, kind: k }))
}

/** Действия объекта (кроме фронтовых `$run`): по `$for` — id правила или вид. */
export function objectActions(rules: LinkRules, ruleList: LinkRuleDef[]): LinkActionDef[] {
  const out: LinkActionDef[] = []
  const seen = new Set<string>()
  for (const r of ruleList) {
    for (const a of actionsFor(rules, r)) {
      if (seen.has(a.id) || !['kd', 'exec', 'script'].includes(a.run)) continue
      seen.add(a.id)
      out.push(a)
    }
  }
  return out
}

/** Слово действия: id действия или его хвост после последней точки (`bot.play` → `play`). */
export const actionWord = (a: LinkActionDef): string => a.id.slice(a.id.lastIndexOf('.') + 1)

/** Переменные конкретного действия: + `dir` — папка файла правил (команда сборки рядом со своими правилами). */
export function actionVarsFor(a: LinkActionDef, base: Record<string, unknown>): Record<string, unknown> {
  return a.source ? { ...base, dir: dirname(a.source) } : base
}

/** Переменные действия: слово, путь, группы шаблона (у конкретного действия + `dir` — `actionVarsFor`). */
export function actionVars(word: string, m: LinkMatch | null, path?: string): Record<string, unknown> {
  const vars: Record<string, unknown> = { text: word, target: word }
  if (path) Object.assign(vars, { path, file: path })
  if (m) {
    Object.assign(vars, m.named)
    m.groups.forEach((g, i) => (vars[`g${i + 1}`] = g))
  }
  return vars
}

export function resolveTemplate(t: string, vars: Record<string, unknown>): string {
  const n = nrdModule as unknown as LinksNrd
  return n.resolve(t, n.chainContext(n.objectContext(vars), n.funcContext(n.coreFunctions)))
}

/** Разбить строку на слова как шелл (кавычки, обратный слеш). */
export function shellSplit(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (q) {
      if (ch === q) q = null
      else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      has = true
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

export { matchWord }
