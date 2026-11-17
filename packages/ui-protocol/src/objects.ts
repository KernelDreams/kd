/**
 * Объекты и виды (v1.49; состояния, `waiting`, оглавление — v1.51; редакторы типа — v1.52; источники
 * service/protocol, `$parent`/`$discuss`, группы связей, объекты сессии — v1.53;
 * nrchat.dev/specs/objects-spec.md §1–3): сервис ядра
 * `objects` хаба — типы данными (`envs/types/<id>.mdz`), записи источников, документ.
 *
 * Провод — слой сервисов (`services.call('objects', …)`, `services.subscribe`): сервис
 * живёт на хабе и одинаков в любом движке и сессии. Capability — сервис `objects` в
 * `capabilities.services` (гейт {@link canObjects}). Строки списка считает бэкенд
 * (`title`/`subtitle`/`avatar`/`badges` по шаблонам типа), фронт рисует только виды.
 *
 *   types                         → ObjectTypesResult (типы + ошибки загрузки)
 *   list    ObjectQuery           → ObjectListResult
 *   get     {type, id, rev?}      → ObjectDoc
 *   create  {type, data}          → ObjectSaveResult     (дубль id, пустое обязательное — `invalid`)
 *   save    {type, id, data?, raw?, hash?} → ObjectSaveResult (hash чужой — `conflict`)
 *   remove  {type, ids}           → {removed}            (в `.nr-trash` источника)
 *   action  {type, id?, action, input?} → unknown        (import / export / duplicate / свои)
 *   links   {type, id}            → ObjectLink[]
 *   history {type, id}            → ObjectRevision[]     (файл в git)
 *   render  {type, id, view}      → {html}               (вид-шаблон `views/<id>.ntpl`)
 *   watch   (subscribe)           → кадры ObjectEvent
 */

import type { Capabilities } from './types.js'

/** Имя сервиса ядра на проводе сервисов. */
export const OBJECTS_SERVICE = 'objects'

/** Источник записей типа (§3): файлы, сервис плагина, протокол хаба. */
export type ObjectSource = 'files' | 'service' | 'protocol'

/** Вид-шаблон типа (`views/<id>.ntpl` рядом с типом): рендерит бэкенд (`render`). */
export interface ObjectTemplateView {
  id: string
  title: string
}

/** Тип объекта глазами фронта: разобранный `object-type` без путей диска. */
export interface ObjectTypeInfo {
  id: string
  title: string
  /** lucide-имя. */
  icon?: string
  source: ObjectSource
  /** Кодек файлового источника: `ccv3`, `json`, `md`, `mdz`, `mds`. */
  format?: string
  ext?: string
  /** JSON Schema с `x-ui` — инспектор и форма создания (`$schema`, уже прочитана). */
  schema?: Record<string, unknown>
  /** Поле системного имени (имя файла, ссылки). */
  idField: string
  titleField: string
  /** Поля корпуса поиска и веса (`name^3`). */
  search: Array<{ field: string; weight: number }>
  /** Фасеты. */
  filters: string[]
  sort: string[]
  /** Действия типа: `create`, `duplicate`, `delete`, `import`, `export` и свои. */
  actions: string[]
  /** Откуда ссылки (`sessions.personas`, …). */
  links: string[]
  /** Дефолтный порядок видов (дистрибутив перебивает); `sheet=fate-condensed` в `$views` — здесь `sheet`. */
  views: string[]
  /**
   * Редакторы типа (v1.52, universal-editor-spec §2, §9): виды из `$views: <вид>=<редактор>`, текст —
   * `editors/<редактор>.editor.mdz` (или `.editor.json`) рядом с типом. Первый — по умолчанию: из него
   * выводится схема, если `$schema` нет. Разбирает и проверяет фронт (`@kerneldreams/forms`).
   */
  editors?: ObjectEditorInfo[]
  /** Ошибки загрузки редакторов типа (нет файла, не читается) — строкой в документе, тип жив. */
  editorErrors?: string[]
  templates: ObjectTemplateView[]
  /** Поля, которые показывает колонками вид Far (`$columns`; нет — `$badges`). */
  columns: string[]
  version?: number
  /** Где лежит файл типа (для «Как текст» типа и ошибок). */
  file?: string
  /** Состояния и переходы (`$states`, v1.51): действие `action {type, id, action: <состояние>, input}`. */
  states?: ObjectStates
  /** Что «ждёт тебя» (`$waiting: state=ready`): фильтр `list`; строка «<тип>: N» в «Ждёт тебя». */
  waiting?: Record<string, string[]>
  /** Оглавление коллекции (`$index: INDEX.md`): действие `index` пересобирает его из полей. */
  index?: string
  /**
   * Источник записей не-файлового типа (v1.53, `$service`): id источника, который держит плагин
   * фронта (`objectSources` Plugin API — `agents`, `live-session`, `tasks`…). Сервис `objects`
   * отдаёт такой тип в `types`, а `list`/`get` для него идут к источнику плагина.
   */
  service?: string
  /** Родитель объекта (`$parent: slot → slot`, v1.53): поле со ссылкой и тип родителя — цепочка «Обсудить». */
  parent?: { field: string; type: string }
  /**
   * Кто разбирается в объекте (`$discuss.<ключ>.agent/skills/space/scope`, v1.53, objects-spec §15):
   * ключ — значение поля `customer` (или `*` — любое). «Обсудить» берёт ближайшее заданное по цепочке.
   */
  discuss?: Record<string, ObjectDiscuss>
  /**
   * Цвет записи (v1.56, objects-spec §19.1): `hash` — оттенок по хэшу id (по умолчанию), `field` — по полю
   * через `$palette`, `off` — без цвета. Сам оттенок строки — {@link ObjectRow.hue}.
   */
  color?: ObjectColorRule
  /** Обложка и иконка генерацией (`## $cover`, v1.56, §19.2): есть — тип открывается эскизами. */
  cover?: ObjectCoverInfo
  /**
   * Срезы списка (`## $slice <id>`, v1.58): сохранённые фильтры типа — «Слоты Erin», «Наши слоты»,
   * «Боты» у типа `book`. Закрепляются иконкой в полосе как тип; свои срезы фронт хранит сам.
   */
  slices?: ObjectSlice[]
  /**
   * Хранилища записей типа (v1.66, rp-build-spec §13.1): блоки `## $<макрос $paths> <id>` цепочки — папка
   * (`$path`), папка на другой машине (`$host`), сервис плагина (`$source: service:<id>`), в своём виде (`$layout`).
   * Тип один, хранилище — полка: `list {store}`. Нет — у типа одна безымянная коллекция.
   */
  stores?: ObjectStoreInfo[]
}

/** Хранилище записей типа (полка): где лежат, в каком виде, что можно. */
export interface ObjectStoreInfo {
  id: string
  title: string
  /** Вид записей: `cards` (CCv3 json+png, по умолчанию), `storyforge` (папка с `bot.md`), `bot-fix`… */
  layout?: string
  /** Только чтение: правка, удаление и создание сюда — нельзя (запись берётся копией). */
  readonly?: boolean
  /** Машина хранилища (`$host`): папка читается там. */
  host?: string
  /** Записи держит сервис плагина (`$source: service:<id>`): `list` движка их не отдаёт, полку рисует плагин. */
  service?: string
  /** Группа полок в переключателе (`$group`: «лаборатория»). */
  group?: string
  /** Почему хранилище сейчас недоступно (нет папки, машина не отвечает): полка гаснет с этой подписью. */
  offline?: string
}

/** Срез списка (v1.58): параметры списка типа (`q`, `f.<поле>: a,b` — фасеты) под своим именем и иконкой. */
export interface ObjectSlice {
  id: string
  title: string
  /** lucide-имя. */
  icon?: string
  params: Record<string, string>
}

/** Правило цвета записи (§19.1). */
export interface ObjectColorRule {
  by: 'hash' | 'field' | 'off'
  /** Поле записи у `by: 'field'`. */
  field?: string
  /** Ступеней оттенка (`$color_steps`, по умолчанию 12). */
  steps: number
}

/** Правило обложки типа глазами фронта (§19.2). */
export interface ObjectCoverInfo {
  /** Поля-референсы (`$refs`): путь картинки или `поле → тип` — картинка другой записи. */
  refs: string[]
  /** Стиль по умолчанию и доступные (`envs/cover-styles/<id>.mdz`). */
  style?: string
  styles: string[]
  /** Пресеты моделей по порядку: первый — основной, дальше запасные. */
  preset: string[]
}

/** Состояние обложки записи (§19.2). */
export type ObjectCoverState = 'missing' | 'queued' | 'ready' | 'stale' | 'locked' | 'manual'

/** «Обсудить» (v1.53): агент, скиллы, пространство и рабочий каталог сессии разговора об объекте. */
export interface ObjectDiscuss {
  agent?: string
  skills?: string[]
  space?: string
  /** Каталог/репо — `cwd` сессии. */
  scope?: string
}

/** Редактор вида типа: описание текстом (`$editor: 1`, mdz или JSON). */
export interface ObjectEditorInfo {
  /** `$id` описания (имя файла без `.editor.mdz`). */
  id: string
  /** Вид типа, который он рисует (`sheet`, `card`; `inspector` — инспектор по нему). */
  view: string
  /** `$title` описания; нет — имя вида. */
  title?: string
  format: 'mdz' | 'json'
  text: string
  /** Файл описания (тулы агента, «Как текст»). */
  file?: string
}

/**
 * Состояния объекта данными (`$states`, objects-spec §15.1 п.3, v1.51): поле, переходы
 * (`ready → accepted | returned`), подписи кнопок (`$state_labels`), обязательные аргументы
 * перехода (`$state_args: returned=comment`). `postponed` с прошедшим `until` `list`/`get`
 * отдают как `ready`, файл не трогается.
 */
export interface ObjectStates {
  field: string
  transitions: Record<string, string[]>
  labels: Record<string, string>
  args: Record<string, string[]>
}

/** Переходы из текущего состояния объекта (пусто — действий нет). */
export function stateActions(states: ObjectStates | undefined, data: Record<string, unknown>): string[] {
  if (!states) return []
  const cur = data[states.field]
  return typeof cur === 'string' ? (states.transitions[cur] ?? []) : []
}

/** Ошибка загрузки типа: строка в разделе «Объекты», остальные типы живы. */
export interface ObjectTypeError {
  file: string
  id?: string
  message: string
}

export interface ObjectTypesResult {
  types: ObjectTypeInfo[]
  errors: ObjectTypeError[]
}

/** Метрика записи (§3.3): токены, CPU, бюджет. Заполняют источники монитора (T4). */
export interface ObjectMetric {
  name: string
  value: number
  unit?: string
  at?: number
  max?: number
}

/** Строка панели: уже посчитанное отображаемое. */
export interface ObjectRow {
  type: string
  id: string
  title: string
  subtitle?: string
  /**
 * Картинка (аватар, обложка): абсолютный URL / `data:` либо путь сервиса с ведущим `/`
 * (`/asset/<type>/<id>?v=`) — браузеру `services.url('objects', path)`.
 */
  avatar?: string
  badges?: string[]
  /** Значения колонок Far (`columns` типа). */
  fields?: Record<string, string>
  metrics?: ObjectMetric[]
  /** Время изменения, мс. */
  updatedAt?: number
  /** Ссылка на источник у копии (§6, форк). */
  source?: ObjectSourceRef
  /** Хранилище записи (v1.66, {@link ObjectTypeInfo.stores}). */
  store?: string
  /**
   * Группа строки (v1.53, T8): ключ и заголовок — список рисует заголовок при смене группы, порядок —
   * источника (у чатов — «Закреплённые» / «Сегодня» / «Раньше»).
   */
  group?: string
  groupTitle?: string
  /**
   * Оттенок записи в градусах OKLCH (v1.56, §19.1): строка красит полосу / подложку иконки / рамку эскиза
   * `oklch(from var(--nr-record-base|accent) l c <hue>)` — светлота и насыщенность от скина.
   */
  hue?: number
  /** Цвет из `$palette` токеном или CSS-цветом (вместо оттенка). */
  color?: string
  /** Обложка и квадратная иконка записи (v1.56, §19.2) — пути сервиса, как `avatar`. */
  cover?: string
  icon?: string
  coverState?: ObjectCoverState
  /** Последняя генерация упала на этих же входах — авто её не повторяет, «Перегенерировать» — да. */
  coverError?: string
}

/** Ссылка копии на оригинал: `extensions.nrchat.source` у CCv3, `source` у прочих. */
export interface ObjectSourceRef {
  /** Хранилище оригинала (v1.66, rp-build-spec §13.1): копия знает, откуда её взяли. */
  store?: string
  type: string
  id: string
  /** Хэш полей оригинала на момент взятия. */
  hash?: string
}

export interface ObjectQuery {
  type: string
  /** Поиск по корпусу `$search` (text-режим, без транслитерации: латиница — через id). */
  q?: string
  /** Фасеты: поле → допустимые значения (любое из). */
  filters?: Record<string, string[]>
  /** Только записи хранилища (v1.66, полка). */
  store?: string
  sort?: string
  desc?: boolean
  offset?: number
  limit?: number
}

export interface ObjectListResult {
  rows: ObjectRow[]
  total: number
  /** Значения фасетов по всей коллекции типа: поле → [значение, сколько]. */
  facets: Record<string, Array<[string, number]>>
}

/** Документ: объект целиком. */
export interface ObjectDoc {
  type: string
  id: string
  /** Поля объекта (у CCv3 — `data` карты). */
  data: Record<string, unknown>
  /** Сырой текст файла (вид «Как текст»). */
  raw?: string
  /** Хэш содержимого: `save` с чужим — `conflict` (правили снаружи). */
  hash: string
  /**
   * Хэш полей без служебного (`_id`, ссылка на источник) — тот же, что `ObjectSourceRef.hash`
   * копии (v1.50): копия с другим — «отстала от оригинала».
   */
  fieldsHash?: string
  row: ObjectRow
  /** Путь файла на хосте хаба. */
  path?: string
  /** Версия из истории (`get {rev}`) — только чтение. */
  rev?: string
}

/**
 * Итог `create`/`save`: документ; ошибки полей (`invalid`: поле → сообщение; дубль `id`,
 * пустое обязательное); `conflict` — файл правили снаружи после `get` (хэш разошёлся),
 * `doc` — то, что на диске сейчас.
 */
export type ObjectSaveResult =
  | { doc: ObjectDoc }
  | { invalid: Record<string, string>; message: string }
  | { conflict: true; doc: ObjectDoc }

/** Ссылка на объект (§6): кто ссылается и не отстала ли копия. */
export interface ObjectLink {
  /** `session`, `agent`, тип объекта копии… */
  kind: string
  id: string
  title: string
  /** Чем ссылается: `copy`, `personas`, `$personas`… */
  via: string
  /** Копия отстала от оригинала (хэш разошёлся). */
  stale?: boolean
  /** Где открыть: тип+id объекта либо сессия. */
  open?: { type: string; id: string } | { session: string }
  /**
   * Группа вида «Связи» (v1.53, objects-spec §15): `discuss` — сессии «Обсудить» (`meta.objects`),
   * `work` — сессии исполнителя/приёмщика задач объекта, `mention` — карточки чатов с упоминанием.
   * Нет — прочие ссылки (копии, `$links`).
   */
  group?: ObjectLinkGroup
  /** Упоминание найдено текстом — «возможно» (кнопки «не про это» / «привязать»). */
  maybe?: boolean
  /** Якорь в сессии (`#/s/<id>?m=<нода>`): id сообщения. */
  anchor?: string
}

export type ObjectLinkGroup = 'discuss' | 'work' | 'mention'

/**
 * Объект в контексте сессии (v1.53, objects-spec §15.1 п.5): `SessionCreateOpts.objects`, хранение —
 * `sessionMeta.objects`; подача движком — блок system источником `object:<type>/<id>` (nr) /
 * префикс тем же источником (ACP). `hash` — хэш полей на момент взятия (`ObjectDoc.fieldsHash`),
 * разошёлся с источником — «отстала», «обновить».
 */
export interface SessionObjectRef {
  type: string
  id: string
  hash?: string
  /** Заголовок объекта (строка в панели и в блоке). */
  title?: string
  /** Текст, который движок кладёт в контекст (карточка целиком); нет — движок читает сам. */
  text?: string
}

/** Источник блока объекта сессии в промпте: `object:slot/coin_dragon`. */
export const objectBlockSource = (o: { type: string; id: string }): string => `object:${o.type}/${o.id}`

/** Версия файла в git (вид «История»). */
export interface ObjectRevision {
  rev: string
  at: number
  author: string
  subject: string
}

/** Кадр `watch`: изменился объект, коллекция или набор типов (`id` пуст — перечитай всё). */
export type ObjectEvent =
  | { name: 'changed'; payload: { type: string; ids: string[] } }
  | { name: 'types'; payload: Record<string, never> }

/** Вид документа: где открыт (§5.4). */
export type ObjectViewHostKind = 'library' | 'session' | 'window' | 'mobile'

/** Сервис `objects` заявлен (типы, записи, документ). */
export function canObjects(caps: Capabilities | null | undefined): boolean {
  return Boolean(caps?.services && (caps.services as Record<string, unknown>)[OBJECTS_SERVICE])
}

/**
 * Оттенок записи по ключу (v1.56, objects-spec §19.1): FNV-1a 32 бит → ступень из `steps` → градусы.
 * Один расчёт у бэкенда (`row.hue`) и у фронта (источники без файлов): одинаковый id — одинаковый цвет.
 */
export function recordHue(key: string, steps = 12): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const n = Math.max(1, Math.floor(steps))
  // Сдвиг полступени: первая ступень — не ровно 0° (красный у всех скинов одинаково кричит).
  return Math.round((((h % n) + 0.5) * 360) / n) % 360
}

/** Цвет записи CSS: оттенок от эталона скина (`base` — фон/полоса, `accent` — плашка/иконка). */
export function recordColor(hue: number, which: 'base' | 'accent' = 'base'): string {
  return `oklch(from var(--nr-record-${which}) l c ${Math.round(hue)})`
}

/** Адрес объекта в hash-роутере: `#/t/object?type=&id=&view=` (короткий алиас — `#/o/<t>/<id>`). */
export function objectHash(type: string, id: string, view?: string): string {
  const q = new URLSearchParams({ type, id, ...(view ? { view } : {}) })
  return `#/t/object?${q.toString()}`
}
