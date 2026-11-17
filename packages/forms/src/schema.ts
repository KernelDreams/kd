/**
 * Схема формы (forms-spec §2, §5.1; forms-2-spec §3) — без импортов и без DOM:
 * её читают и сервис форм (Node, строит схему из `## $form`), и вьюшки
 * (`./react`). Один разбор полей на всех: свой парсер не пишется.
 *
 * Авторинг — короткий NRD: `$имя: тип[[]][?] [опции] // подпись` в блоках
 * `## $form [id]` (секции). Варианты `select`/`radio` — списком или ссылкой на
 * корневой список (`select $targets`). На проводе — JSON Schema 2020-12 входа шаблона с
 * `x-ui: { widget, order, section, glob?, own? }` у поля и `x-ui: { sections }`
 * у корня (канон форм данных, DECISIONS nr-system 03.07; forms — первый
 * интерпретатор `x-ui`). Дефолт поля — значение одноимённой корневой переменной
 * шаблона: своего синтаксиса нет, шаблон без формы запускается из CLI с теми же
 * значениями.
 */

/** Виджет поля — то, чем его рисует вьюшка. */
export type Widget = 'image' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'input' | 'number' | 'model' | 'file'

/** Тип поля в `## $form` (закрытый набор) → виджет. */
const WIDGETS: Record<string, Widget> = {
  image: 'image',
  text: 'textarea',
  select: 'select',
  radio: 'radio',
  checkbox: 'checkbox',
  string: 'input',
  number: 'number',
  model: 'model',
  file: 'file',
  // Профиль: select из файлов по маске; атрибуты выбранного — поверх рецепта.
  preset: 'select',
}

/** Типы, у которых бывает список `[]` (forms-2-spec §3.2; `image[]` — картинки виджета). */
const LIST_TYPES = new Set(['string', 'model', 'file', 'image'])

export interface FieldUi {
  widget: Widget
  order: number
  /** id секции (`## $form <id>`); `''` — безымянная. */
  section: string
  /** Маска файлов поля `file`. */
  glob?: string
  /** Корневой атрибут с этим именем написан в самом открытом файле, а не пришёл из инклуда. */
  own?: boolean
  /**
   * Подписи вариантов `select`/`radio`: `help (Справка)` — значение
   * `help`, подпись «Справка». В рецепт уходит значение.
   */
  labels?: Record<string, string>
  /**
   * Значение уровнем ниже (происхождение значения): у поля, написанного
   * в тонком файле над базой, — что даёт база. «↶ вернуть» ставит его, «Сохранить»
   * тогда убирает строку из файла.
   */
  inherited?: FormValue
  /**
   * Поле-профиль (`preset <маска>`): маска файлов от папки формы.
   * Варианты — файлы, подпись — их `$title`; выбор подмешивает атрибуты файла
   * поверх рецепта (сервис `preset`, в запуске — nrd presets).
   */
  preset?: string
  /** Подсказки вариантов (`$description` профиля) по значению. */
  hints?: Record<string, string>
  /** Объявление тула (kd-cli-spec §2): какой по счёту аргумент без `--` (с 1). */
  pos?: number
  /** Вид значения (словарь `$kind` правил ссылок): `url`, `file`, `model`, `host`, `bot`, `task`… */
  kind?: string
  /** К каким действиям тула относится поле; нет — ко всем. */
  for?: string[]
  /** Поле забирает весь оставшийся свободный текст. */
  rest?: boolean
}

/** Пометки объявления тула в строке поля: `$pos=1 $kind=url $for=play,publish $rest`. */
export interface ToolMarks {
  pos?: number
  kind?: string
  for?: string[]
  rest?: boolean
}

const MARK_RE = /(^|\s)\$(pos|kind|for|rest)(?:=(\S+))?(?=\s|$)/g

/**
 * Снять пометки объявления тула со строки поля (kd-cli-spec §2) — форма их не рисует,
 * разбор командной строки и `ToolDef` читают из `x-ui`. Битая пометка — throw.
 */
export function splitToolMarks(name: string, spec: string): { spec: string; marks: ToolMarks } {
  const cut = spec.indexOf('//')
  const head = cut < 0 ? spec : spec.slice(0, cut)
  const tail = cut < 0 ? '' : spec.slice(cut)
  const marks: ToolMarks = {}
  const clean = head.replace(MARK_RE, (_all, lead: string, key: string, val: string | undefined) => {
    if (key === 'rest') {
      if (val !== undefined) throw new Error(`поле "${name}": $rest без значения`)
      marks.rest = true
    } else if (val === undefined || val === '') throw new Error(`поле "${name}": у $${key} нужно значение ($${key}=…)`)
    else if (key === 'pos') {
      const n = Number(val)
      if (!Number.isInteger(n) || n < 1) throw new Error(`поле "${name}": $pos — целое от 1, а не "${val}"`)
      marks.pos = n
    } else if (key === 'kind') marks.kind = val
    else marks.for = val.split(',').map((x) => x.trim()).filter(Boolean)
    return lead
  })
  return { spec: (clean.replace(/\s+$/, '') + (tail ? ' ' + tail : '')).trim(), marks }
}

export interface FieldSchema {
  type: 'string' | 'boolean' | 'number' | 'array'
  title?: string
  enum?: string[]
  default?: FormValue
  minimum?: number
  maximum?: number
  items?: { type: 'string' }
  minItems?: 1
  'x-ui': FieldUi
}

export interface FormSection {
  id: string
  /** `$nr-title` блока; нет — id; у безымянной — `''`. */
  title: string
  /**
   * Свёрнута, пока её не развернули: `$nr-collapsed: true` (виджет: «Ещё»); у
   * формы рецепта секции шагов свёрнуты и без него, `false` — раскрыта.
   */
  collapsed?: boolean
  /**
   * `$nr-show-if: {run: ["greet", "run"]}`: секция видна, если значение
   * каждого поля — в своём списке; поле не задано — скрыта. Данные не трогает.
   */
  showIf?: Record<string, string[]>
}

export interface FormSchema {
  $schema: 'https://json-schema.org/draft/2020-12/schema'
  type: 'object'
  properties: Record<string, FieldSchema>
  required: string[]
  'x-ui'?: {
    sections: FormSection[]
    /** Файл — тонкий вариант над базой (первый `$[[…]]`): имя базы. Поля `own` — уровень «вариант». */
    base?: string
  }
}

/**
 * Значение поля формы: строка (image, text, select, radio, string, model, file),
 * флаг (checkbox), число (number; пустое — `''`), список строк (`[]`).
 */
export type FormValue = string | boolean | number | string[]

/** Вариант поля-профиля: значение — путь от папки формы, подпись — `$title`, подсказка — `$description`. */
export interface PresetChoice {
  value: string
  label: string
  hint?: string
  /** Абсолютный путь — дефолт поля может быть написан им. */
  file?: string
}

/** Профили по маске поля (сервис: файлы от папки формы); нет — у поля нет вариантов. */
export type PresetResolver = (glob: string) => PresetChoice[]

/** Значение корневой переменной шаблона: сырой текст скаляра или элементы списка. */
export type VarValue = string | string[]

/** Имя поля = имя переменной шаблона; точка разрешена — в NRD она часть ключа. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** Варианты `select`/`radio` из корневого списка шаблона: `select $targets` (виджет). */
const LIST_REF_RE = /^\$([A-Za-z_][A-Za-z0-9_.-]*)$/

/** Вариант с подписью: `help (Справка)`. */
const LABELED_RE = /^(.*?\S)\s*\(([^()]+)\)$/

/** Вариант `select`/`radio` (и элемент `$targets`) → значение и подпись; подписи нет — `label` undefined. */
export function splitOption(raw: string): { value: string; label?: string } {
  const s = raw.trim()
  const m = LABELED_RE.exec(s)
  return m ? { value: m[1]!.trim(), label: m[2]!.trim() } : { value: s }
}

/** Диапазон `min..max`, любая сторона может отсутствовать. */
const RANGE_RE = /^(-?\d+(?:\.\d+)?)?\.\.(-?\d+(?:\.\d+)?)?$/

/** Число из текста; не число — undefined. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : undefined
}

function checkGlob(name: string, glob: string): void {
  if (glob === '') throw new Error(`поле "${name}": у file нужна маска файлов (*-prompt.md)`)
  if (glob.includes('**')) throw new Error(`поле "${name}": маска "${glob}" — ** не поддерживается, только * и ?`)
  if (/[[\]{}\s]/.test(glob)) throw new Error(`поле "${name}": маска "${glob}" — только * и ?`)
}

/** Дефолт поля из корневой переменной — по типу поля. */
export function defaultOf(field: FieldSchema, def: VarValue | undefined): FormValue | undefined {
  if (field.type === 'array') {
    if (Array.isArray(def)) return def
    return def === undefined || def === '' ? [] : [def]
  }
  const text = Array.isArray(def) ? def.join(', ') : def
  if (field.type === 'boolean') return (text ?? '').trim() === 'true'
  if (field.type === 'number') return toNumber(text)
  return text === undefined || text === '' ? undefined : text
}

/**
 * Одна строка `## $form` → схема поля. Бросает с понятной причиной: шаблон с
 * битой формой остаётся в списке с `error`, а не выкидывается молча.
 */
export function parseField(
  name: string,
  spec: string,
  order: number,
  def: VarValue | undefined,
  section = '',
  vars: Record<string, VarValue> = {},
  presets?: PresetResolver,
): FieldSchema {
  if (!NAME_RE.test(name)) throw new Error(`поле "${name}": имя не годится для переменной шаблона`)
  const split = splitToolMarks(name, spec)
  spec = split.spec
  const cut = spec.indexOf('//')
  const head = (cut < 0 ? spec : spec.slice(0, cut)).trim()
  const title = cut < 0 ? '' : spec.slice(cut + 2).trim()
  const m = /^([a-z]+)(\[\])?(\?)?(?:\s+(.*))?$/.exec(head)
  const widget = m ? WIDGETS[m[1]!] : undefined
  if (!m || !widget) {
    throw new Error(
      `поле "${name}": тип "${head.split(/[\s[?]/)[0] ?? ''}" — ожидается image, text, select, radio, checkbox, string, number, model, file или preset`,
    )
  }
  const kind = m[1]!
  const list = m[2] !== undefined
  if (list && !LIST_TYPES.has(kind)) throw new Error(`поле "${name}": список [] бывает только у string, model, file и image`)
  const rest = (m[4] ?? '').trim()
  const ui: FieldUi = { widget, order, section, ...split.marks }
  const field: FieldSchema = list
    ? { type: 'array', items: { type: 'string' }, 'x-ui': ui }
    : { type: widget === 'checkbox' ? 'boolean' : widget === 'number' ? 'number' : 'string', 'x-ui': ui }
  if (title) field.title = title

  if (kind === 'preset') {
    checkGlob(name, rest)
    ui.preset = rest
    const choices = presets?.(rest) ?? []
    field.enum = choices.map((c) => c.value)
    const labels = Object.fromEntries(choices.map((c) => [c.value, c.label]))
    if (choices.length > 0) ui.labels = labels
    const hints = Object.fromEntries(choices.filter((c) => c.hint).map((c) => [c.value, c.hint!]))
    if (Object.keys(hints).length > 0) ui.hints = hints
    // Дефолт написан коротким именем или абсолютным путём — к значению варианта.
    const d = typeof def === 'string' ? def.trim().replace(/^"(.*)"$/, '$1') : ''
    const hit = d === '' ? undefined : choices.find((c) => c.value === d || c.file === d || c.value.replace(/^.*\//, '').replace(/\.[^.]+$/, '') === d)
    if (hit) def = hit.value
  } else if (widget === 'select' || widget === 'radio') {
    const ref = LIST_REF_RE.exec(rest)
    const from = ref ? vars[ref[1]!] : undefined
    if (ref && from === undefined) throw new Error(`поле "${name}": варианты ${rest} — нет такого корневого списка`)
    const raw = (from === undefined ? rest.split(',') : Array.isArray(from) ? from : [from]).map((s) => s.trim()).filter(Boolean)
    if (raw.length === 0) throw new Error(`поле "${name}": у ${kind} нет вариантов`)
    const options = raw.map(splitOption)
    field.enum = options.map((o) => o.value)
    const labels = Object.fromEntries(options.filter((o) => o.label !== undefined).map((o) => [o.value, o.label!]))
    if (Object.keys(labels).length > 0) ui.labels = labels
  } else if (widget === 'number') {
    if (rest !== '') {
      const r = RANGE_RE.exec(rest)
      if (!r) throw new Error(`поле "${name}": у number диапазон min..max, а не "${rest}"`)
      if (r[1] !== undefined) field.minimum = Number(r[1])
      if (r[2] !== undefined) field.maximum = Number(r[2])
    }
  } else if (widget === 'file') {
    checkGlob(name, rest)
    ui.glob = rest
  } else if (rest !== '') {
    throw new Error(`поле "${name}": у ${kind} вариантов не бывает`)
  }

  const value = defaultOf(field, def)
  if (value !== undefined) field.default = value
  return field
}

/** Обязательность: `?` после типа (и `[]`) снимает её; у `checkbox` пусто не бывает. */
function isOptional(spec: string): boolean {
  spec = spec.replace(MARK_RE, '$1')
  return /^\s*[a-z]+(?:\[\])?\?/.test(spec)
}

export interface FormField {
  name: string
  spec: string
  /** id секции; нет — безымянная. */
  section?: string
}

export interface BuildOpts {
  /** Секции в порядке показа; нет — одна безымянная (форма прежнего вида). */
  sections?: FormSection[]
  /** Корневые атрибуты, написанные в самом открытом файле. */
  own?: ReadonlySet<string>
  /**
   * Файл — вариант над базой: имя базы и её корневые переменные —
   * у полей `own` появляется `inherited` (значение базы).
   */
  base?: { name: string; vars: Record<string, VarValue> }
  /** Варианты полей-профилей (`preset`) — у сервиса, он видит файлы. */
  presets?: PresetResolver
}

/**
 * Поля `## $form` по порядку + корневые переменные шаблона (last-wins уже
 * применён) → схема. Первая битая строка — throw.
 */
export function buildSchema(fields: FormField[], vars: Record<string, VarValue>, opts: BuildOpts = {}): FormSchema {
  if (fields.length === 0) throw new Error('## $form без полей')
  const properties: Record<string, FieldSchema> = {}
  const required: string[] = []
  fields.forEach(({ name, spec, section }, order) => {
    if (name in properties) throw new Error(`поле "${name}" объявлено дважды`)
    const field = parseField(name, spec, order, vars[name], section ?? '', vars, opts.presets)
    if (opts.own?.has(name)) {
      field['x-ui'].own = true
      if (opts.base) field['x-ui'].inherited = defaultOf(field, opts.base.vars[name]) ?? emptyOf(field)
    }
    properties[name] = field
    if (field['x-ui'].widget !== 'checkbox' && !isOptional(spec)) {
      required.push(name)
      if (field.type === 'array') field.minItems = 1
    }
  })
  const schema: FormSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, required }
  if (opts.sections) schema['x-ui'] = { sections: opts.sections }
  if (opts.base) schema['x-ui'] = { sections: opts.sections ?? [{ id: '', title: '' }], base: opts.base.name }
  return schema
}

/** Поля схемы в порядке `x-ui.order`. */
export function orderedFields(schema: FormSchema): [string, FieldSchema][] {
  return Object.entries(schema.properties).sort((a, b) => a[1]['x-ui'].order - b[1]['x-ui'].order)
}

/** Секции схемы; у формы без них — одна безымянная. */
export function sectionsOf(schema: FormSchema): FormSection[] {
  return schema['x-ui']?.sections ?? [{ id: '', title: '' }]
}

/** Пустое значение поля по типу. */
function emptyOf(field: FieldSchema): FormValue {
  if (field.type === 'boolean') return false
  if (field.type === 'array') return []
  return ''
}

/** Дефолт поля — значение файла; нет — пустое. */
export function fieldDefault(field: FieldSchema): FormValue {
  return field.default ?? emptyOf(field)
}

/** Стартовые значения формы: дефолты схемы поверх пустых. */
export function defaultValues(schema: FormSchema): Record<string, FormValue> {
  const out: Record<string, FormValue> = {}
  for (const [name, field] of orderedFields(schema)) out[name] = fieldDefault(field)
  return out
}

/** Пусто ли значение поля (для обязательности). */
function isEmpty(field: FieldSchema | undefined, v: FormValue | undefined): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  if (field?.type === 'number') return toNumber(v) === undefined
  return typeof v === 'string' && v.trim() === ''
}

/** Обязательные поля без значения — пока список не пуст, Generate неактивна. */
export function missingRequired(schema: FormSchema, values: Record<string, FormValue | undefined>): string[] {
  return schema.required.filter((name) => isEmpty(schema.properties[name], values[name]))
}

/** Значение к типу поля: лишнее с провода не проходит. */
function coerceOne(field: FieldSchema, v: unknown): FormValue {
  if (field.type === 'boolean') return v === true || v === 'true'
  if (field.type === 'array') {
    if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(String)
    return typeof v === 'string' && v !== '' ? [v] : []
  }
  if (field.type === 'number') return toNumber(v) ?? ''
  return v === undefined || v === null ? '' : String(v)
}

/**
 * Значения для запуска: только поля схемы, приведённые к типу поля. Лишнее с
 * провода отбрасывается — в документ запуска попадает ровно форма.
 */
export function coerceValues(schema: FormSchema, values: unknown): Record<string, FormValue> {
  const src = values && typeof values === 'object' ? (values as Record<string, unknown>) : {}
  const out: Record<string, FormValue> = {}
  for (const [name, field] of orderedFields(schema)) out[name] = coerceOne(field, src[name] ?? fieldDefault(field))
  return out
}

/** Два значения поля равны (списки — поэлементно, числа — как числа). */
export function sameValue(a: FormValue | undefined, b: FormValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  }
  if (typeof a === 'number' || typeof b === 'number') return toNumber(a) === toNumber(b)
  return a === b
}

/** Поле отличается от дефолта файла. */
export function isChanged(schema: FormSchema, name: string, value: FormValue | undefined): boolean {
  const field = schema.properties[name]
  if (!field || value === undefined) return false
  return !sameValue(coerceOne(field, value), fieldDefault(field))
}

/**
 * Только поля, значение которых отличается от дефолта файла (forms-2-spec §4):
 * неизменённое уже есть в документе, а его сырой текст с `${…}` материализация
 * превратила бы в литерал.
 */
export function changedValues(schema: FormSchema, values: Record<string, FormValue | undefined>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {}
  for (const [name, field] of orderedFields(schema)) {
    if (isChanged(schema, name, values[name])) out[name] = coerceOne(field, values[name])
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Пульт по-человечески (rp-lab specs/bot-fix-tool.md §7)
// ────────────────────────────────────────────────────────────────────────────

/** Обязательное поле пусто — звёздочка (у поля с дефолтом её нет). */
export function needsValue(schema: FormSchema, name: string, value: FormValue | undefined): boolean {
  return schema.required.includes(name) && isEmpty(schema.properties[name], value)
}

/**
 * Откуда значение поля (Unreal / VS Code): `recipe` — из рецепта (базы),
 * `variant` — написано в этом тонком файле над базой, `run` — изменено в форме
 * и не сохранено. Вернули поле варианта к базе — снова `recipe` (сохранение
 * уберёт строку из файла).
 */
export type Origin = 'recipe' | 'variant' | 'run'

export function originOf(schema: FormSchema, name: string, value: FormValue | undefined): Origin {
  const field = schema.properties[name]
  if (!field) return 'recipe'
  const ui = field['x-ui']
  const variant = schema['x-ui']?.base !== undefined && ui.own === true
  if (isChanged(schema, name, value)) {
    return variant && ui.inherited !== undefined && sameValue(coerceOne(field, value), ui.inherited) ? 'recipe' : 'run'
  }
  return variant ? 'variant' : 'recipe'
}

/** Значение «↶ вернуть»: снять запись текущего уровня — запуск → файл, вариант → база. */
export function revertValue(schema: FormSchema, name: string, value: FormValue | undefined): FormValue | undefined {
  const field = schema.properties[name]
  if (!field) return undefined
  const origin = originOf(schema, name, value)
  if (origin === 'run') return fieldDefault(field)
  if (origin === 'variant') return field['x-ui'].inherited ?? emptyOf(field)
  return undefined
}

/** `$nr-show-if` секции: каждое поле — в своём списке; не задано — скрыта. */
export function sectionVisible(section: FormSection, values: Record<string, FormValue | undefined>): boolean {
  if (!section.showIf) return true
  return Object.entries(section.showIf).every(([key, allowed]) => {
    const v = values[key]
    const text = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
    return text !== '' && allowed.includes(text)
  })
}

/** Хвосты id, которые в имени модели не нужны. */
const MODEL_NOISE = new Set(['preview', 'it', 'instruct', 'latest', 'chat'])
const MODEL_UPPER = new Set(['glm', 'gpt', 'qwq', 'llm', 'vl'])

/**
 * Имя модели из id для человека: `nano-gpt/google/gemini-3.1-pro-preview` →
 * «Gemini 3.1 Pro», `nano-gpt/z-ai/glm-5.3` → «GLM 5.3». Сырой id — в подсказке.
 */
export function prettyModel(id: string): string {
  const tail = id.trim().split('/').pop() ?? ''
  const words = tail
    .split(/[-_\s]+/)
    .filter((w) => w !== '' && !MODEL_NOISE.has(w.toLowerCase()))
    .map((w, i) => (MODEL_UPPER.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 || /^[a-z]{3,}$/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w))
  return words.join(' ') || id
}

/** Имя файла без пути и `.md`: `prompts/author-prompt-v6-fix.md` → `author-prompt-v6-fix`. */
export function fileLabel(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.mdz?$/i, '')
}

/** Подпись подсказки поля: «Источник форка: ссылка на площадку…» → подпись «Источник форка», подсказка — после «:». */
export function splitTitle(title: string | undefined, name: string): { label: string; hint: string } {
  const t = (title ?? '').trim()
  if (t === '') return { label: name, hint: '' }
  const at = t.indexOf(':')
  if (at <= 0) return { label: t, hint: '' }
  return { label: t.slice(0, at).trim(), hint: t.slice(at + 1).trim() }
}

/**
 * Единица числа в хвосте подписи: «Длинная сторона листа, px» → `{ label: 'Длинная сторона листа', unit: 'px' }` —
 * единица уезжает в поле справа. Хвост — одно короткое слово без пробела после последней запятой; иначе подпись как есть.
 */
export function unitOf(label: string): { label: string; unit?: string } {
  const m = /^(.+?),\s*([^\s,]{1,6})$/.exec(label)
  return m ? { label: m[1]!.trim(), unit: m[2]! } : { label }
}

/** Значение поля одной строкой для сводки свёрнутой секции; пусто — ''. */
export function valueSummary(field: FieldSchema, value: FormValue | undefined): string {
  const ui = field['x-ui']
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return ''
  if (ui.widget === 'model') return (Array.isArray(value) ? value : [String(value)]).map(prettyModel).join(', ')
  if (ui.widget === 'file') return (Array.isArray(value) ? value : [String(value)]).map(fileLabel).join(', ')
  if (ui.widget === 'select' || ui.widget === 'radio') return ui.labels?.[String(value)] ?? String(value)
  if (ui.widget === 'checkbox') return value === true ? splitTitle(field.title, '').label : ''
  if (ui.widget === 'number') return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value).length > 32 ? `${String(value).slice(0, 31)}…` : String(value)
}

/** Сводка значений секции: «Gemini 3.1 Pro · author-prompt-v6-fix» (Blender: видно, не раскрывая). */
export function sectionSummary(schema: FormSchema, section: string, values: Record<string, FormValue | undefined>, max = 3): string {
  const parts = orderedFields(schema)
    .filter(([, f]) => (f['x-ui'].section ?? '') === section)
    .map(([name, f]) => valueSummary(f, values[name]))
    .filter((s) => s !== '')
  const uniq = [...new Set(parts)]
  return uniq.length > max ? `${uniq.slice(0, max).join(' · ')} · …` : uniq.join(' · ')
}
