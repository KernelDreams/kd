/**
 * Мост `__host.skins` (artifacts-spec §4): артефакт — редактор тем.
 * Право `$uses: skins`.
 *
 *   skins.list()                                  → SkinInfo[]          (общие + рабочая область)
 *   skins.get(name)                               → {info, source, css, vars, chain}
 *   skins.contract()                              → {groups, tokens, selectors, properties, fontHosts}
 *   skins.check(name, css, {base?, mode?, description?}) → {ok, errors?, warnings?, css?, vars?}
 *   skins.save(name, css, {…})                    → {ok, path?, skin?, errors?}  (в `.nr/skins` рабочей области)
 *   skins.preview(name, css, {…}) | (null)        → живое превью поверх nrchat (CSS проверен здесь)
 *   skins.apply(name)                             → сделать скин текущим (и перечитать список)
 *
 * list/get/contract/check/save исполняет хост (Node, `@kerneldreams/skins`):
 * файлы скинов — на диске бэкенда. preview/apply — у фронта (`{delegate}`, как
 * буфер): тема — у клиента.
 */

import { ELEMENT_PROPERTIES, ELEMENT_SELECTORS, FONT_HOSTS, SKIN_NAME_RE, TEXT_TAGS, TOKEN_GROUPS, TOKENS, type SkinMode } from '@kerneldreams/skins'
import { createFsSkins } from '@kerneldreams/skins/node'

export const SKINS_METHODS = ['skins.list', 'skins.get', 'skins.contract', 'skins.check', 'skins.save', 'skins.preview', 'skins.apply'] as const
export type SkinsMethod = (typeof SKINS_METHODS)[number]

/** Методы, которые исполняет фронт. */
export const SKINS_DELEGATED: readonly string[] = ['skins.preview', 'skins.apply']

export type SkinsCheck = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

interface SaveOpts {
  base?: string
  mode?: SkinMode
  description?: string
}

function saveOpts(raw: unknown): SaveOpts | string {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'третий аргумент — {base?, mode?, description?}'
  const o = raw as Record<string, unknown>
  const out: SaveOpts = {}
  if (o.base !== undefined && o.base !== null && o.base !== '') {
    if (typeof o.base !== 'string') return 'base — имя скина'
    out.base = o.base
  }
  if (o.mode !== undefined && o.mode !== null) {
    if (o.mode !== 'light' && o.mode !== 'dark' && o.mode !== 'both') return 'mode — light | dark | both'
    out.mode = o.mode
  }
  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== 'string') return 'description — строка'
    out.description = o.description
  }
  return out
}

/** Форма аргументов `skins.*` (право проверено раньше). */
export function checkSkinsArgs(method: string, args: readonly unknown[]): SkinsCheck {
  const name = (i = 0): string | null => (typeof args[i] === 'string' && SKIN_NAME_RE.test(args[i] as string) ? (args[i] as string) : null)
  const nameErr = (m: string) => ({ ok: false as const, error: `${m}: имя скина — латиница в нижнем регистре, цифры, дефис (${String(args[0])})` })
  switch (method) {
    case 'skins.list':
    case 'skins.contract':
      return { ok: true, value: {} }
    case 'skins.get':
    case 'skins.apply':
      return name() ? { ok: true, value: { name: name()! } } : nameErr(method)
    case 'skins.preview':
      if (args[0] === null || args[0] === undefined) return { ok: true, value: { clear: true } }
    // fallthrough: превью — те же аргументы, что check/save
    case 'skins.check':
    case 'skins.save': {
      if (!name()) return nameErr(method)
      if (typeof args[1] !== 'string') return { ok: false, error: `${method}: второй аргумент — текст CSS скина` }
      const o = saveOpts(args[2])
      if (typeof o === 'string') return { ok: false, error: `${method}: ${o}` }
      return { ok: true, value: { name: name()!, css: args[1], opts: o } }
    }
  }
  return { ok: false, error: `unknown bridge method: ${method}` }
}

/** Контракт для редактора: группы, токены с описаниями, элементы ленты. */
export function skinsContract(): Record<string, unknown> {
  return {
    groups: TOKEN_GROUPS,
    tokens: TOKENS,
    selectors: ELEMENT_SELECTORS,
    textTags: TEXT_TAGS,
    properties: ELEMENT_PROPERTIES,
    fontHosts: FONT_HOSTS,
  }
}

/**
 * Исполнить `skins.*` на хосте. `root` — корень бэкенда (общие `<root>/skins`),
 * `workspace` — рабочая область сессии (`.nr/skins`). Делегируемые методы
 * возвращают `{delegate, value}`: превью — уже собранный и проверенный CSS.
 */
export async function runSkins(
  method: string,
  value: Record<string, unknown>,
  env: { root: string; workspace: string | null },
): Promise<{ ok: true; value?: unknown; delegate?: string } | { ok: false; error: string }> {
  const skins = createFsSkins({ root: env.root })
  const where = env.workspace ? { cwd: env.workspace } : {}
  const name = value.name as string
  switch (method) {
    case 'skins.list':
      return { ok: true, value: await skins.list(where) }
    case 'skins.contract':
      return { ok: true, value: skinsContract() }
    case 'skins.get': {
      const d = await skins.get(name, where)
      return { ok: true, value: { info: d.info, source: d.source, css: d.css, vars: d.vars, chain: d.chain } }
    }
    case 'skins.check':
      return { ok: true, value: await skins.check(name, value.css as string, { ...where, ...(value.opts as SaveOpts) }) }
    case 'skins.save':
      return { ok: true, value: await skins.save(name, value.css as string, { ...where, ...(value.opts as SaveOpts) }) }
    case 'skins.apply': {
      const info = (await skins.list(where)).find((s) => s.name === name)
      if (!info) return { ok: false, error: `skins.apply: скина ${name} нет` }
      if (info.error) return { ok: false, error: `skins.apply: скин ${name} не прошёл проверку: ${info.error}` }
      return { ok: true, delegate: method, value: { name } }
    }
    case 'skins.preview': {
      if (value.clear) return { ok: true, delegate: method, value: null }
      const r = await skins.check(name, value.css as string, { ...where, ...(value.opts as SaveOpts) })
      if (!r.ok) return { ok: false, error: `skins.preview: ${(r.errors ?? []).join('; ')}` }
      return { ok: true, delegate: method, value: { skin: name, css: r.css, ...(r.warnings ? { warnings: r.warnings } : {}) } }
    }
  }
  return { ok: false, error: `unknown bridge method: ${method}` }
}
