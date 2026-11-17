/**
 * Хост слоёв настроек (settings-spec §1, §3, §6; протокол v1.40): файлы стенда →
 * `SettingsOps` для `serveBackend({settings})`.
 *
 * Слои, что живут у хоста (сверху вниз):
 *   session  — `%meta.settings` сессии (через `meta.get/patch`);
 *   persona  — карта user-персоны сессии: `card.extensions.nrchat.settings` (v1.47, CYOA:
 *              персона игрока, запись — `personas.save`; только ключи с `persona` в scopes);
 *   bot      — карта char-персоны сессии: `data.extensions.nrchat.settings` (запись —
 *              `personas.save`; карта бота в сессии — экземпляр, библиотечная не меняется);
 *   agent    — `%meta.settings` файла агента `<agentsDir>/<id>.mds`;
 *   project  — `<корень репы>/.nr/settings.mdz`;
 *   space    — `<spacesDir>/<id>.mdz`, блоки `## $settings <плагин>` в файле пространства;
 *   user     — `<usersDir>/<id>/settings.mdz`;
 *   stand    — `<root>/settings/stand.mdz`.
 * Остальные слои (устройство, дистрибутив, код) — на клиенте.
 *
 * Файл слоя — обычный mdz: `## $settings <плагин>` и `$ключ: значение`. Запись —
 * `setAttr`/`removeAttr` из nr-md (правка точечная, файл остаётся читаемым и правится
 * руками; чужие блоки и комментарии не трогаются). Сложное значение — JSON5-объект
 * или список (атомарно целиком).
 *
 * Хост не знает схем плагинов: какие слои разрешены ключу, присылает клиент
 * (`SettingsGetOpts.scopes`); ключ без пометки живёт в `user`, `stand`, `distribution`.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseMds, stringify as stringifyMds, parseJson5 } from '@kerneldreams/nrd/chat'
import { ensureBlock, parse as parseMdz, removeAttr, setAttr } from '@kerneldreams/nrd/md'
import type { AttributeValue } from '@kerneldreams/nrd/md'
import {
  SERVER_SETTINGS_LAYERS,
  SETTINGS_KEY,
  SETTINGS_NAME,
  isSettingsLayer,
  scopesOf,
} from '@kerneldreams/ui-protocol'
import type {
  PersonasDoc,
  SessionMetaDoc,
  SessionMetaPatch,
  SettingsChangedEvent,
  SettingsContext,
  SettingsGetOpts,
  SettingsLayer,
  SettingsLayerInfo,
  SettingsOps,
  SettingsResetOpts,
  SettingsSection,
  SettingsSetOpts,
  SettingsSnapshot,
  SettingsValues,
  SettingsWriteResult,
} from '@kerneldreams/ui-protocol'
import { CODE_BAD_REQUEST, CODE_FORBIDDEN } from './wire.js'

/** Блок слоя в mdz. */
const BLOCK = 'settings'

/** Ошибка настроек с кодом протокола (`bad_request`, `forbidden`). */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SettingsError'
  }
}

const bad = (m: string): SettingsError => new SettingsError(m, CODE_BAD_REQUEST)
const forbidden = (m: string): SettingsError => new SettingsError(m, CODE_FORBIDDEN)

// ────────────────────────────────────────────────────────────────────────────
// Файл слоя: разбор и точечная запись
// ────────────────────────────────────────────────────────────────────────────

/** Значение атрибута mdz → значение настройки (список во flow-записи приходит строкой). */
function plainOf(v: AttributeValue): unknown {
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        return parseJson5(t)
      } catch {
        return v
      }
    }
  }
  return v
}

/** Блоки `## $settings <плагин>` текста слоя → `плагин → ключ → значение`. */
export function parseSettingsText(text: string): SettingsValues {
  const out: SettingsValues = {}
  if (text.trim() === '') return out
  const doc = parseMdz(text)
  for (const b of doc.root.children) {
    if (b.name !== BLOCK || !b.id || !SETTINGS_NAME.test(b.id)) continue
    const block = (out[b.id] ??= {})
    for (const a of b.attrs) {
      if (a.key.length !== 1) continue
      block[a.key[0]!] = plainOf(a.value)
    }
  }
  return out
}

/** Значение настройки → значение атрибута; не влезающее в строку — ошибка записи. */
function attrOf(value: unknown): AttributeValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  // Список объектов или списков flow-запись mdz не держит (`$[, ]` — элементы терялись, места pics): такой
  // список пишется JSON-строкой, `plainOf` читает её обратно списком.
  if (Array.isArray(value)) return value.some((x) => x !== null && typeof x === 'object') ? JSON.stringify(value) : (value as AttributeValue)
  if (typeof value === 'object') return value as AttributeValue
  throw bad('settings: значение — строка, число, флаг, список или объект')
}

/** Текст слоя с записанным ключом (блок заводится, если его нет). */
export function writeSettingsText(text: string, plugin: string, key: string, value: unknown): string {
  const path = [{ name: BLOCK, id: plugin }]
  let next = ensureBlock(text, path)
  try {
    next = setAttr(next, path, key, attrOf(value))
  } catch (e) {
    if (e instanceof SettingsError) throw e
    throw bad(`settings: ${plugin}.${key} — ${e instanceof Error ? e.message : String(e)}`)
  }
  return next
}

/** Текст слоя без ключа; блок остаётся (пустой блок безвреден, правку руками не теряем). */
export function removeSettingsText(text: string, plugin: string, key: string): string {
  if (!(parseSettingsText(text)[plugin]?.[key] !== undefined)) return text
  return removeAttr(text, [{ name: BLOCK, id: plugin }], key)
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/** Атомарная запись: tmp рядом и rename — читатель не видит половину файла. */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

// ────────────────────────────────────────────────────────────────────────────
// Агент: `%meta.settings` в первой строке `.mds`
// ────────────────────────────────────────────────────────────────────────────

function splitMeta(text: string): { meta: Record<string, unknown>; body: string } {
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  if (!/^%meta\b/.test(first)) return { meta: {}, body: text }
  return { meta: { ...(parseMds(first)[0]?.meta ?? {}) }, body: nl < 0 ? '' : text.slice(nl + 1) }
}

function joinMeta(meta: Record<string, unknown>, body: string): string {
  const line = stringifyMds([{ role: 'meta', meta, body: '' }]).trim()
  return `${line}\n${body}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `settings` из объекта меты: только `плагин → ключ → значение`. */
export function settingsOfMeta(meta: unknown): SettingsValues {
  const raw = isRecord(meta) ? meta.settings : undefined
  const out: SettingsValues = {}
  if (!isRecord(raw)) return out
  for (const [plugin, block] of Object.entries(raw)) if (isRecord(block)) out[plugin] = { ...block }
  return out
}

/** Персона игрока документа: `userId`, иначе первая `user`. */
function playerOf(doc: PersonasDoc): PersonasDoc['personas'][number] | undefined {
  return doc.personas.find((p) => p.kind === 'user' && (doc.userId === undefined || p.id === doc.userId)) ?? doc.personas.find((p) => p.kind === 'user')
}

/** Бот документа: по имени/id (`SettingsContext.bot`), иначе первая char-персона с картой, иначе первая char. */
function botOf(doc: PersonasDoc, name?: string): PersonasDoc['personas'][number] | undefined {
  const chars = doc.personas.filter((p) => p.kind === 'char')
  return name === undefined ? (chars.find((p) => p.card !== undefined) ?? chars[0]) : chars.find((p) => p.name === name || p.id === name)
}

/** Настройки карты персоны (`data.extensions.nrchat.settings`, у плоской — `extensions.nrchat.settings`). */
export function settingsOfCard(card: unknown): SettingsValues {
  const data = isRecord(card) && isRecord(card.data) ? card.data : isRecord(card) ? card : undefined
  const ext = data && isRecord(data.extensions) ? data.extensions : undefined
  const nr = ext && isRecord(ext.nrchat) ? ext.nrchat : undefined
  return settingsOfMeta(nr)
}

// ────────────────────────────────────────────────────────────────────────────
// Опции и хост
// ────────────────────────────────────────────────────────────────────────────

export interface FsSettingsOpts {
  /** Корень стенда (`envs`): от него — `settings/stand.mdz`, `users`, `projects`, `agents`. */
  root: string
  standFile?: string
  /** `<usersDir>/<id>/settings.mdz`. */
  usersDir?: string
  /** `<spacesDir>/<id>.mdz` — файл пространства. */
  spacesDir?: string
  /** `<agentsDir>/<id>.mds`. */
  agentsDir?: string
  /** Владелец стенда: пользователь без гейта и тот, кто пишет общие слои. */
  owner: string
  /** Владелец ли пользователь (общие слои стенда, пространства, репы, агента — только он). */
  isOwner?(userId: string): boolean
  /** Корень проекта пространства (репы): слой `project`. Нет — слоя нет. */
  projectRoot?(project: string, space?: string): string | undefined | Promise<string | undefined>
  /** Файл агента, если он лежит не в `agentsDir` (агент проекта пространства). */
  agentFile?(agent: string, space?: string): string | undefined | Promise<string | undefined>
  /** Мета сессии: слой `session`. */
  meta?: { get(id: string): Promise<SessionMetaDoc>; patch(id: string, patch: SessionMetaPatch): Promise<unknown> }
  /** Персоны сессии: слой `bot` и `persona` (персона игрока; запись — `save`). */
  personas?: { list(sessionId: string): Promise<PersonasDoc>; save?(sessionId: string, personas: PersonasDoc['personas'], userId?: string): Promise<PersonasDoc> }
  /** Схемы, которые знает хост (ручки скина, пресеты). */
  schemas?(ctx: SettingsContext): SettingsSection[] | Promise<SettingsSection[]>
  warn?(message: string): void
}

const ID = /^[A-Za-z0-9][\w.-]*$/

interface Resolved {
  ctx: SettingsContext
  who: string
}

/** Слой, как его видит хост в этом запросе: данные, куда писать, можно ли. */
interface LayerHandle {
  info: SettingsLayerInfo
  read(): Promise<SettingsValues>
}

export function createFsSettings(opts: FsSettingsOpts): SettingsOps {
  const root = resolve(opts.root)
  const standFile = resolve(opts.standFile ?? join(root, 'settings', 'stand.mdz'))
  const usersDir = resolve(opts.usersDir ?? join(root, 'users'))
  const spacesDir = resolve(opts.spacesDir ?? join(root, 'projects'))
  const agentsDir = resolve(opts.agentsDir ?? join(root, 'agents'))
  const isOwner = opts.isOwner ?? ((u: string) => u === opts.owner)
  const warn = opts.warn ?? (() => {})
  const listeners = new Set<(e: SettingsChangedEvent) => void>()
  const watchers = new Map<string, FSWatcher>()

  const emit = (event: SettingsChangedEvent): void => {
    for (const l of listeners) {
      try {
        l(event)
      } catch (e) {
        warn(`settings: слушатель — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // ── слои по файлам ──────────────────────────────────────────────────────

  function fileLayer(file: string, writable: boolean): LayerHandle {
    return {
      info: { present: true, file, writable, values: {} },
      read: async () => parseSettingsText(readText(file)),
    }
  }

  function userFile(user: string): string {
    if (!ID.test(user)) throw bad(`settings: недопустимый пользователь "${user}"`)
    return join(usersDir, user, 'settings.mdz')
  }

  function spaceFile(space: string): string {
    if (!ID.test(space)) throw bad(`settings: недопустимое пространство "${space}"`)
    return join(spacesDir, `${space}.mdz`)
  }

  async function agentPath(agent: string, space?: string): Promise<string | undefined> {
    if (!ID.test(agent)) throw bad(`settings: недопустимый агент "${agent}"`)
    const custom = await opts.agentFile?.(agent, space)
    if (custom) return custom
    const file = join(agentsDir, `${agent}.mds`)
    return existsSync(file) ? file : undefined
  }

  /** Контекст запроса: агент из меты сессии, если не задан явно. */
  async function contextOf(ctx: SettingsContext): Promise<SettingsContext> {
    if (!ctx.session || !opts.meta) return ctx
    if (ctx.agent !== undefined) return ctx
    try {
      const meta = await opts.meta.get(ctx.session)
      const agent = typeof meta.agent === 'string' ? meta.agent : undefined
      return agent ? { ...ctx, agent } : ctx
    } catch {
      return ctx
    }
  }

  /** Описание слоёв запроса. Нет сущности слоя — `present: false`. */
  async function layersOf(rq: Resolved): Promise<Partial<Record<SettingsLayer, LayerHandle>>> {
    const { ctx, who } = rq
    const owner = isOwner(who)
    const out: Partial<Record<SettingsLayer, LayerHandle>> = {}

    if (ctx.session && opts.meta) {
      const sid = ctx.session
      out.session = {
        info: { present: true, file: `session:${sid}`, writable: true, values: {} },
        read: async () => settingsOfMeta(await opts.meta!.get(sid).catch(() => ({}))),
      }
    }

    if (ctx.session && opts.personas) {
      const sid = ctx.session
      out.persona = {
        info: { present: true, file: `persona:${sid}`, writable: opts.personas.save !== undefined, values: {} },
        read: async () => {
          try {
            const doc = await opts.personas!.list(sid)
            const user = playerOf(doc)
            return user?.card === undefined ? {} : settingsOfCard(user.card)
          } catch {
            return {}
          }
        },
      }
    }

    if (ctx.session && opts.personas && ctx.noBot !== true) {
      const sid = ctx.session
      const name = ctx.bot
      out.bot = {
        info: { present: true, file: `bot:${sid}`, writable: opts.personas.save !== undefined, values: {} },
        read: async () => {
          try {
            const bot = botOf(await opts.personas!.list(sid), name)
            return bot?.card === undefined ? {} : settingsOfCard(bot.card)
          } catch {
            return {}
          }
        },
      }
    }

    if (ctx.agent) {
      const agent = ctx.agent
      const file = await agentPath(agent, ctx.space)
      if (file) {
        out.agent = {
          info: { present: true, file, writable: owner, values: {} },
          read: async () => settingsOfMeta(splitMeta(readText(file)).meta),
        }
      }
    }

    if (ctx.project) {
      const dir = await opts.projectRoot?.(ctx.project, ctx.space)
      if (dir) {
        const file = join(dir, '.nr', 'settings.mdz')
        out.project = fileLayer(file, owner)
        watchDir(dirname(file))
      }
    }

    if (ctx.space) {
      const file = spaceFile(ctx.space)
      out.space = fileLayer(file, owner)
    }

    const ufile = userFile(who)
    out.user = fileLayer(ufile, true)
    out.stand = fileLayer(standFile, owner)
    return out
  }

  // ── сборка ──────────────────────────────────────────────────────────────

  async function get(o: SettingsGetOpts, who?: string): Promise<SettingsSnapshot> {
    const user = who ?? opts.owner
    const { scopes, ...raw } = o
    const ctx = await contextOf(raw)
    const layers = await layersOf({ ctx, who: user })

    const info: Partial<Record<SettingsLayer, SettingsLayerInfo>> = {}
    for (const layer of SERVER_SETTINGS_LAYERS) {
      const h = layers[layer]
      if (!h) continue
      info[layer] = { ...h.info, values: await h.read() }
    }

    const values: SettingsValues = {}
    const origin: Record<string, Record<string, SettingsLayer>> = {}
    for (const layer of SERVER_SETTINGS_LAYERS) {
      const l = info[layer]
      if (!l) continue
      for (const [plugin, block] of Object.entries(l.values)) {
        for (const [key, value] of Object.entries(block)) {
          if (values[plugin]?.[key] !== undefined) continue
          if (!scopesOf(scopes?.[plugin]?.[key] ?? scopes?.[plugin]?.['*']).includes(layer)) continue
          ;(values[plugin] ??= {})[key] = value
          ;(origin[plugin] ??= {})[key] = layer
        }
      }
    }

    const schema = (await opts.schemas?.(ctx)) ?? []
    const rev = createHash('sha1').update(JSON.stringify(info)).digest('hex').slice(0, 12)
    return { schema, values, origin, layers: info, rev }
  }

  // ── запись ──────────────────────────────────────────────────────────────

  function checkName(plugin: string, key: string): void {
    if (!SETTINGS_NAME.test(plugin)) throw bad(`settings: недопустимый плагин "${plugin}"`)
    if (!SETTINGS_KEY.test(key)) throw bad(`settings: недопустимый ключ "${key}"`)
  }

  /** Куда писать и как; `remove` — снять ключ. */
  async function write(layer: SettingsLayer, plugin: string, key: string, change: { value: unknown } | 'remove', ctx0: SettingsContext, who: string): Promise<SettingsWriteResult> {
    checkName(plugin, key)
    if (!isSettingsLayer(layer) || !(SERVER_SETTINGS_LAYERS as readonly string[]).includes(layer)) {
      throw bad(`settings: слой "${String(layer)}" хост не пишет`)
    }
    const ctx = await contextOf(ctx0)
    const layers = await layersOf({ ctx, who })
    const h = layers[layer]
    if (!h) throw bad(`settings: слоя ${layer} в этом контексте нет`)
    if (!h.info.writable) throw forbidden(`settings: слой ${layer} вам не принадлежит`)

    const apply = (text: string): string => (change === 'remove' ? removeSettingsText(text, plugin, key) : writeSettingsText(text, plugin, key, change.value))

    if (layer === 'session') {
      const sid = ctx.session!
      const cur = settingsOfMeta(await opts.meta!.get(sid))
      const block = { ...(cur[plugin] ?? {}) }
      if (change === 'remove') delete block[key]
      else block[key] = change.value
      const next: SettingsValues = { ...cur, [plugin]: block }
      if (Object.keys(block).length === 0) delete next[plugin]
      await opts.meta!.patch(sid, { settings: Object.keys(next).length ? next : null } as SessionMetaPatch)
      emit({ layer, target: sid })
    } else if (layer === 'persona' || layer === 'bot') {
      // Персона игрока и бот — экземпляры в сессии: правится карта персоны сессии
      // (`personas.save`), библиотечная карточка не трогается.
      const sid = ctx.session!
      const doc = await opts.personas!.list(sid)
      const target = layer === 'persona' ? playerOf(doc) : botOf(doc, ctx.bot)
      if (!target) throw bad(layer === 'persona' ? 'settings: у сессии нет персоны игрока' : 'settings: у сессии нет бота')
      const card = isRecord(target.card) ? structuredClone(target.card) : {}
      // У CCv3 настройки — в `data.extensions`, у плоской карты — в `extensions`.
      const holder: Record<string, unknown> = isRecord(card.data) ? (card.data as Record<string, unknown>) : card
      const cur = settingsOfCard(card)
      const block = { ...(cur[plugin] ?? {}) }
      if (change === 'remove') delete block[key]
      else block[key] = change.value
      const next: SettingsValues = { ...cur, [plugin]: block }
      if (Object.keys(block).length === 0) delete next[plugin]
      const ext = isRecord(holder.extensions) ? { ...holder.extensions } : {}
      const nr = isRecord(ext.nrchat) ? { ...ext.nrchat } : {}
      if (Object.keys(next).length) nr.settings = next
      else delete nr.settings
      ext.nrchat = nr
      holder.extensions = ext
      const personas = doc.personas.map((p) => (p === target ? { ...p, card } : p))
      await opts.personas!.save!(sid, personas, doc.userId)
      emit({ layer, target: sid })
    } else if (layer === 'agent') {
      const file = h.info.file!
      const { meta, body } = splitMeta(readText(file))
      const cur = settingsOfMeta(meta)
      const block = { ...(cur[plugin] ?? {}) }
      if (change === 'remove') delete block[key]
      else block[key] = change.value
      const next: SettingsValues = { ...cur, [plugin]: block }
      if (Object.keys(block).length === 0) delete next[plugin]
      if (Object.keys(next).length) meta.settings = next
      else delete meta.settings
      writeText(file, joinMeta(meta, body))
      emit({ layer, target: ctx.agent! })
    } else {
      const file = h.info.file!
      const before = readText(file)
      if (change === 'remove' && !existsSync(file)) return { ok: true, layer, rev: '' }
      const after = apply(before)
      if (after !== before) writeText(file, after)
      emit({ layer, target: layer === 'user' ? who : layer === 'space' ? ctx.space! : layer === 'project' ? ctx.project! : undefined } as SettingsChangedEvent)
    }
    const snap = await get({ ...ctx }, who)
    return { ok: true, layer, rev: snap.rev }
  }

  // ── watch ───────────────────────────────────────────────────────────────

  /** Какой слой у файла (по каталогу): для события изменения снаружи. */
  function layerOfFile(path: string): SettingsChangedEvent | undefined {
    const p = resolve(path)
    if (p === standFile) return { layer: 'stand' }
    if (p.startsWith(usersDir + '/') && p.endsWith('/settings.mdz')) return { layer: 'user', target: p.slice(usersDir.length + 1).split('/')[0]! }
    if (p.startsWith(spacesDir + '/') && p.endsWith('.mdz') && !p.slice(spacesDir.length + 1).includes('/')) return { layer: 'space', target: p.slice(spacesDir.length + 1, -'.mdz'.length) }
    if (p.endsWith('/.nr/settings.mdz')) return { layer: 'project', target: dirname(dirname(p)) }
    if (p.startsWith(agentsDir + '/') && p.endsWith('.mds')) return { layer: 'agent', target: p.slice(agentsDir.length + 1, -'.mds'.length) }
    return undefined
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  function onFsEvent(dir: string, name: string | null): void {
    if (!name) return
    const path = join(dir, name)
    const ev = layerOfFile(path)
    if (!ev) return
    // fs.watch шлёт пачку событий на одну запись: схлопываем.
    clearTimeout(pending.get(path))
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path)
        emit(ev)
      }, 60),
    )
  }

  function watchDir(dir: string): void {
    if (watchers.has(dir) || listeners.size === 0) return
    try {
      mkdirSync(dir, { recursive: true })
      const w = fsWatch(dir, { persistent: false }, (_t, name) => onFsEvent(dir, name))
      w.on('error', () => {
        watchers.delete(dir)
      })
      watchers.set(dir, w)
    } catch (e) {
      warn(`settings: watch ${dir} — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function watch(listener: (e: SettingsChangedEvent) => void): () => void {
    listeners.add(listener)
    for (const dir of [dirname(standFile), usersDir, spacesDir, agentsDir]) {
      if (existsSync(dir)) watchDir(dir)
    }
    // каталоги пользователей: файл `<usersDir>/<id>/settings.mdz`
    try {
      for (const d of readdirDirs(usersDir)) watchDir(join(usersDir, d))
    } catch {
      /* нет каталога — нет слоёв */
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        for (const w of watchers.values()) w.close()
        watchers.clear()
      }
    }
  }

  return {
    get,
    set: (o: SettingsSetOpts, who?: string) => write(o.layer, o.plugin, o.key, { value: o.value }, o.context, who ?? opts.owner),
    reset: (o: SettingsResetOpts, who?: string) => write(o.layer, o.plugin, o.key, 'remove', o.context, who ?? opts.owner),
    watch,
  }
}

function readdirDirs(dir: string): string[] {
  return readdirSync(dir).filter((n) => {
    try {
      return statSync(join(dir, n)).isDirectory()
    } catch {
      return false
    }
  })
}
