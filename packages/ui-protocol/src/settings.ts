/**
 * Настройки по слоям (v1.40, settings-spec §1–3): capability `settings`
 * на хабе `backend-http` — одна на все движки (nr, pi, ACP, гейт), движки о
 * настройках не знают.
 *
 * Значение ключа — первое заданное в цепочке слоёв (сверху вниз). Слои, что живут
 * в файлах стенда (сессия … стенд), собирает хост и отдаёт `get`; слои устройства,
 * дистрибутива и кода — на клиенте (у хоста их нет). Ключ — пара `плагин → ключ`
 * (`## $settings <плагин>` в файле слоя): `size` голоса и `size` темы не конфликтуют.
 *
 * Провод (`serveBackend({settings})`, сам по себе — `createFsSettings` в backend-http):
 *   GET    /settings?session=&space=&project=&bot=&agent=&scopes=<json>  → SettingsSnapshot
 *   PUT    /settings {plugin, key, value, layer, context}                → SettingsWriteResult
 *   DELETE /settings {plugin, key, layer, context}                       → SettingsWriteResult
 *
 * Изменения файла слоя снаружи (рука в редакторе, другое устройство) доходят до
 * открытого фронта через пул `services.subscribe` — сервис `settings`, стрим
 * `changes`; нового потока нет.
 */

import type { Capabilities } from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Слои
// ────────────────────────────────────────────────────────────────────────────

/**
 * Слой настроек. Порядок — {@link SETTINGS_LAYERS}: сверху побеждает. `persona` (v1.47,
 * cyoa-spec §5) — персона игрока сессии: `card.extensions.nrchat.settings` user-персоны,
 * между сессией и ботом; только ключи с `persona` в `x-ui.scopes`. `bot` (v1.65) —
 * карта char-персоны сессии, запись — в экземпляр сессии, библиотечная карточка не меняется.
 */
export type SettingsLayer =
  | 'device'
  | 'session'
  | 'persona'
  | 'bot'
  | 'agent'
  | 'project'
  | 'space'
  | 'user'
  | 'stand'
  | 'distribution'
  | 'code'

/** Приоритет слоёв, высший первым (settings-spec §1). */
export const SETTINGS_LAYERS: readonly SettingsLayer[] = [
  'device',
  'session',
  'persona',
  'bot',
  'agent',
  'project',
  'space',
  'user',
  'stand',
  'distribution',
  'code',
]

/** Слои, которые собирает хост (файлы стенда); остальные — клиент. */
export const SERVER_SETTINGS_LAYERS: readonly SettingsLayer[] = ['session', 'persona', 'bot', 'agent', 'project', 'space', 'user', 'stand']

/**
 * Слои, разрешённые ключу без пометки `x-ui.scopes` (settings-spec §1): человек,
 * админ и продукт. Устройство — только по явной пометке.
 */
export const DEFAULT_SETTINGS_SCOPES: readonly SettingsLayer[] = ['user', 'stand', 'distribution']

/** Слой — в нашем наборе? */
export function isSettingsLayer(v: unknown): v is SettingsLayer {
  return typeof v === 'string' && (SETTINGS_LAYERS as readonly string[]).includes(v)
}

/** Слои ключа: пометка схемы или умолчание; `code` разрешён всегда (это `default` схемы). */
export function scopesOf(scopes: readonly SettingsLayer[] | undefined): readonly SettingsLayer[] {
  return scopes && scopes.length > 0 ? scopes : DEFAULT_SETTINGS_SCOPES
}

// ────────────────────────────────────────────────────────────────────────────
// Контекст и схема
// ────────────────────────────────────────────────────────────────────────────

/**
 * Контекст запроса — явный: вкладки живут каждая со своим пространством, «текущей
 * сессии» у бэкенда нет. Пользователь — тот, кто пришёл (гейт пользователей).
 */
export interface SettingsContext {
  /** Сессия: слой `session` (`%meta.settings`) и источник `agent`/`bot`/пространства, если они не заданы. */
  session?: string
  /** Пространство (`ProjectInfo.id` реестра `envs/projects/<id>.mdz`). */
  space?: string
  /** Проект пространства (репа): `<корень>/.nr/settings.mdz`. */
  project?: string
  /** Агент (`envs/agents/<id>.mds`). */
  agent?: string
  /** Бот — имя char-персоны сессии; нет — первая char-персона с картой (та, с которой началась сессия). */
  bot?: string
  /** Не брать слой «бот» (выключатель «без темы бота» пользователя, settings-spec §1a). */
  noBot?: boolean
}

/**
 * Какие слои разрешены каждому ключу: `плагин → ключ → слои`. Схемы объявляют
 * плагины фронта, хост их не знает — клиент присылает таблицу (`x-ui.scopes`),
 * без записи ключ живёт в {@link DEFAULT_SETTINGS_SCOPES}. Ключ `*` — слои всех ключей плагина без своей
 * записи (у скина Obsidian Minimal ~200 ручек с одинаковыми слоями — таблица целиком не лезла в адрес
 * `GET /settings`).
 */
export type SettingsScopes = Record<string, Record<string, SettingsLayer[]>>

/** Схема секции: JSON Schema 2020-12 + `x-ui` (settings-spec §2). */
export interface SettingsSection {
  /** Id плагина (имя блока `## $settings <id>`). */
  id: string
  title: string
  schema: Record<string, unknown>
}

/** Значения: `плагин → ключ → значение`. */
export type SettingsValues = Record<string, Record<string, unknown>>

export interface SettingsGetOpts extends SettingsContext {
  scopes?: SettingsScopes
}

/** Слой, как он лежит у хоста. */
export interface SettingsLayerInfo {
  /** Есть ли слой в этом контексте (нет репы, нет пространства — слоя нет). */
  present: boolean
  /** Файл слоя (подпись «где лежит»); у `session`/`agent`/`bot` — адрес сущности. */
  file?: string
  /** Можно ли писать (бот и персона — экземпляры в сессии, v1.65; гость — только свою сессию). */
  writable: boolean
  /** Что записано в слое по ключам, без фильтра scopes. */
  values: SettingsValues
}

export interface SettingsSnapshot {
  /** Схемы, которые знает хост (ручки скина); схемы плагинов — на клиенте. */
  schema: SettingsSection[]
  /** Итог по серверным слоям: только ключи, заданные хотя бы в одном. */
  values: SettingsValues
  /** Слой-победитель ключа. */
  origin: Record<string, Record<string, SettingsLayer>>
  /** Серверные слои по отдельности — для «куда писать», «↶ вернуть», чипа слоя. */
  layers: Partial<Record<SettingsLayer, SettingsLayerInfo>>
  /** Ревизия: сменилась — слои поменялись (файл правили). */
  rev: string
}

export interface SettingsSetOpts {
  plugin: string
  key: string
  value: unknown
  layer: SettingsLayer
  context: SettingsContext
}

export interface SettingsResetOpts {
  plugin: string
  key: string
  layer: SettingsLayer
  context: SettingsContext
}

export interface SettingsWriteResult {
  ok: true
  layer: SettingsLayer
  rev: string
}

// ────────────────────────────────────────────────────────────────────────────
// Операции и capability
// ────────────────────────────────────────────────────────────────────────────

/**
 * Хост слоёв. Пользователь запроса — `who` (id из гейта; без гейта — владелец
 * стенда), его слой `user` и права на запись определяет он.
 */
export interface SettingsOps {
  get(opts: SettingsGetOpts, who?: string): Promise<SettingsSnapshot>
  set(opts: SettingsSetOpts, who?: string): Promise<SettingsWriteResult>
  reset(opts: SettingsResetOpts, who?: string): Promise<SettingsWriteResult>
  /** Подписка на правки файлов слоёв снаружи; возвращает «отписаться». */
  watch?(listener: (event: SettingsChangedEvent) => void): () => void
}

/** Файл слоя изменили (мы или рука): клиент перечитывает `get`. */
export interface SettingsChangedEvent {
  layer: SettingsLayer
  /** Что поменялось: id пространства, пользователя, сессии… — по возможности. */
  target?: string
}

/** Имя сервиса и стрима, которым идут изменения (пул `services.subscribe`). */
export const SETTINGS_SERVICE = 'settings'
export const SETTINGS_CHANGES_STREAM = 'changes'
export const SETTINGS_CHANGED_EVENT = 'changed'

export interface SettingsCapability {
  /** Слои, которые собирает этот хост. */
  layers: SettingsLayer[]
  /** Есть `watch`: правки файлов доходят потоком. */
  watch?: boolean
}

/** Capability `settings` заявлена? Без неё — слои «устройство» и «код», как раньше. */
export function canSettings(caps: Pick<Capabilities, 'settings'> | null | undefined): boolean {
  return Boolean(caps?.settings)
}

/** Дописать ключ в значения: `плагин → ключ`. */
export function putSetting(values: SettingsValues, plugin: string, key: string, value: unknown): void {
  const block = (values[plugin] ??= {})
  block[key] = value
}

/** Правила ключа плагина — безопасное имя блока и ключа (`## $settings <плагин>`, `$ключ`). */
export const SETTINGS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Ключ — допустимый атрибут mdz без точек (точка в mdz — вложенность). */
export const SETTINGS_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
