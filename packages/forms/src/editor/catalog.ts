// Каталог виджетов (spec §4): описание виджета для проверки и для промпта агенту.
// Ядро без DOM: `component` (React) и `frame` (виджет-артефакт) лежат здесь как данные,
// рисует их `./react`.

import { exprFilters } from './expr.js'
import type { JSONSchema } from './types.js'

/** Что виджет знает о поле при выборе по умолчанию. */
export interface FieldInfo {
  /** Тип строкой описания (`string`, `integer`, `string[]`…). */
  type: string
  enum?: unknown[]
  format?: string
  path: string
  schema: JSONSchema
}

export interface WidgetDef {
  /** `fate.stress-track` */
  id: string
  /** Типы данных, которые виджет правит. `number` принимает и `integer`. */
  types: string[]
  /** Нужен `enum` у поля (select, radio). */
  enum?: boolean
  /** Однострочный виджет: в инспекторе подпись слева в строку (правило 2 пульта). */
  inline?: boolean
  /** Схема props: проверка и промпт. `format: "path"` у свойства — путь поля от корня. */
  props?: JSONSchema
  /** Одна строка в промпт агенту. */
  description: string
  /** Пример поля (mdz) — в промпт. */
  example?: string
  /** Тестер: ранг виджета по умолчанию для поля без `$widget` (0 / нет — не подходит). */
  rank?(field: FieldInfo): number
  /** React-компонент (`./react`); ядро его не трогает. */
  component?: unknown
  /** Виджет-iframe (артефакт). */
  frame?: { src?: string; srcdoc?: string }
  /** Печать и поля PDF (E7). */
  print?(value: unknown, props: Record<string, unknown>): unknown[]
}

export interface Catalog {
  get(id: string): WidgetDef | undefined
  list(): WidgetDef[]
  /** Добавить или заменить виджет (виджет-артефакт появляется в каталоге сразу). */
  register(w: WidgetDef): void
  /** Виджет по умолчанию: наибольший `rank`; никто не подходит — `undefined`. */
  pick(field: FieldInfo): WidgetDef | undefined
  /** Подходит ли виджет полю; нет — причина строкой. */
  accepts(w: WidgetDef, field: FieldInfo): string | undefined
  /** Текст для агента: формат описания, узлы, типы, выражения, виджеты с props и примерами, ошибки. */
  prompt(opts?: { title?: string }): string
}

export function typeMatches(accepted: string[], type: string): boolean {
  return accepted.includes(type) || (type === 'integer' && accepted.includes('number'))
}

export function createCatalog(widgets: WidgetDef[] = []): Catalog {
  const map = new Map<string, WidgetDef>()
  for (const w of widgets) map.set(w.id, w)
  const accepts = (w: WidgetDef, f: FieldInfo): string | undefined => {
    if (!typeMatches(w.types, f.type)) return `виджет ${w.id} ждёт ${w.types.join(' | ')}, а тип ${f.type}`
    if (w.enum && !(Array.isArray(f.enum) && f.enum.length)) return `виджет ${w.id} ждёт поле с $enum`
    return undefined
  }
  const cat: Catalog = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
    register(w) {
      map.set(w.id, w)
    },
    pick(f) {
      let best: WidgetDef | undefined
      let score = 0
      for (const w of map.values()) {
        const r = w.rank?.(f) ?? 0
        if (r > score && !accepts(w, f)) (best = w), (score = r)
      }
      return best
    },
    accepts,
    prompt: (opts) => prompt(cat, opts?.title),
  }
  return cat
}

// ---------- базовые и наборы ----------

const rankType = (types: string[], score = 1, needEnum?: boolean) => (f: FieldInfo): number =>
  typeMatches(types, f.type) && (needEnum === undefined || needEnum === Boolean(f.enum?.length)) ? score : 0

const labels: JSONSchema = { type: 'object', description: 'значение → подпись' }

/** Базовые виджеты пакета. `color`, `chips` — к переводу SettingsForm. */
export const baseWidgets: WidgetDef[] = [
  { id: 'text', types: ['string'], props: { type: 'object', properties: { placeholder: { type: 'string' } } }, description: 'строка', rank: rankType(['string'], 1, false) },
  { id: 'textarea', types: ['string'], props: { type: 'object', properties: { rows: { type: 'integer' } } }, description: 'многострочный текст' },
  { id: 'markdown', types: ['string'], description: 'текст с разметкой и превью' },
  { id: 'number', types: ['number'], props: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' } } }, description: 'число', rank: rankType(['number']) },
  { id: 'slider', types: ['number'], props: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' } } }, description: 'ползунок (min/max — props или $min/$max поля)' },
  { id: 'checkbox', types: ['boolean'], description: 'флаг', rank: rankType(['boolean']) },
  { id: 'select', types: ['string', 'number'], enum: true, props: { type: 'object', properties: { labels } }, description: 'выпадающий список по $enum', rank: rankType(['string', 'number'], 2, true) },
  { id: 'radio', types: ['string', 'number'], enum: true, props: { type: 'object', properties: { labels } }, description: 'кнопки выбора по $enum' },
  { id: 'tags', types: ['string[]'], description: 'чипы', rank: rankType(['string[]']) },
  { id: 'list', types: ['string[]'], props: { type: 'object', properties: { itemLabel: { type: 'string' } } }, description: 'упорядоченный список строк (каждая — многострочная)' },
  { id: 'image', types: ['string'], props: { type: 'object', properties: { aspect: { type: 'string', description: '"1:1", "2:3"' } } }, description: 'картинка (URL / data-URL) с загрузкой и кадрированием' },
  { id: 'date', types: ['string'], description: 'дата YYYY-MM-DD', rank: (f) => (f.type === 'string' && f.format === 'date' ? 2 : 0) },
  { id: 'ref', types: ['string'], props: { type: 'object', properties: { type: { type: 'string', description: 'тип объекта' } } }, description: 'ссылка на другой объект по id' },
  { id: 'json', types: ['object', 'object[]', 'string[]', 'boolean[]', 'number[]', 'integer[]', 'array'], description: 'сырой JSON (extensions и прочее «как есть»); вложенные поля, описанные отдельно, исключаются' },
  { id: 'color', types: ['string'], description: 'цвет #rrggbb', rank: (f) => (f.type === 'string' && f.format === 'color' ? 2 : 0) },
  { id: 'chips', types: ['string', 'number'], enum: true, props: { type: 'object', properties: { labels } }, description: 'чипы выбора одного значения по $enum' },
]

/** Набор Fate Condensed. */
export const fateWidgets: WidgetDef[] = [
  { id: 'fate.ladder', types: ['integer'], description: 'лестница Fate: −2…+8 с подписями (Ужасно … Легендарно)' },
  {
    id: 'fate.aspect',
    types: ['string'],
    props: { type: 'object', properties: { kind: { type: 'string', enum: ['high-concept', 'trouble', 'other'] } } },
    description: 'аспект Fate (строка с меткой вида)',
  },
  {
    id: 'fate.stress-track',
    types: ['boolean[]'],
    props: { type: 'object', properties: { boxes: { type: ['integer', 'number'], description: 'число ячеек или "=<id computed>"' } }, required: ['boxes'] },
    description: 'ряд ячеек стресса',
    example: '### $field physical\n$path: stress.physical\n$type: boolean[]\n$widget: fate.stress-track\n$props: {boxes: "=physicalBoxes"}',
  },
  {
    id: 'fate.consequence',
    types: ['string'],
    props: { type: 'object', properties: { severity: { type: 'string', enum: ['mild', 'moderate', 'severe'] }, value: { type: 'integer', enum: [2, 4, 6] } } },
    description: 'последствие',
  },
  {
    id: 'fate.fate-points',
    types: ['integer'],
    props: { type: 'object', properties: { refreshFrom: { type: 'string', format: 'path', description: 'путь поля восстановления' } } },
    description: 'жетоны судьбы',
  },
]

/** Набор Character Card V3. */
export const ccv3Widgets: WidgetDef[] = [
  { id: 'ccv3.greetings', types: ['string[]'], description: 'гритинги-свайпы (первый, альтернативные)' },
  { id: 'ccv3.lorebook-keys', types: ['string[]'], description: 'ключи записи лорбука (чипы с подсветкой)' },
]

// ---------- промпт ----------

function propsLine(s: JSONSchema | undefined): string {
  const props = s?.properties
  if (!props || !Object.keys(props).length) return '—'
  const req = new Set(s?.required ?? [])
  return Object.entries(props)
    .map(([k, v]) => {
      const t = Array.isArray(v.enum) ? v.enum.map((x) => JSON.stringify(x)).join('|') : Array.isArray(v.type) ? v.type.join('|') : v.type ?? ''
      return `\`${k}${req.has(k) ? '' : '?'}\`${t ? ` (${t})` : ''}${v.description ? ` — ${v.description}` : ''}`
    })
    .join(', ')
}

function prompt(cat: Catalog, title = 'Описание редактора объекта'): string {
  const widgets = cat
    .list()
    .map((w) => `| \`${w.id}\` | ${w.types.join(', ')}${w.enum ? ' с $enum' : ''} | ${propsLine(w.props)} | ${w.description} |`)
    .join('\n')
  const examples = cat
    .list()
    .filter((w) => w.example)
    .map((w) => `\`${w.id}\`:\n\n\`\`\`mdz\n${w.example}\n\`\`\``)
    .join('\n\n')
  return `# ${title}

Файл \`<id>.editor.mdz\`: атрибуты \`$ключ: значение\`, блоки \`## $узел id\`; вложенность — числом решёток (\`##\` → \`###\` → … до \`######\`). Вывод — чистый mdz, без markdown-обёртки.

\`\`\`mdz
$editor: 1
$id: <id редактора>
$title: <заголовок>
$version: 1

## $section <id>
$title: …
$collapsed: true
$tab: <id вкладки>
$show-if: {kind: ["bot"]}

### $field <имя>
$type: string
$label: …
$widget: textarea
$enum: $[a, b, c]
$min: 0
$max: 4
$default: …
$required: true
$props: {rows: 6}
$path: data.name
$row: <имя строки>

### $repeat <имя>
$label: …
$item-title: name

### $group <имя>

### $computed <id>
$type: number
$expr: "<< 3 + (1 if skills.physique >= 1 else 0) >>"

### $text
$text: …
\`\`\`

## Узлы

| узел | атрибуты | что |
|---|---|---|
| \`section\` | id (уникален), \`$title\`, \`$collapsed\`, \`$tab\`, \`$show-if\` | секция; на верхнем уровне — только секции; порядок = порядок на экране |
| \`field\` | \`$type\` (обяз.), \`$label\`, \`$widget\`, \`$enum\`, \`$min\`, \`$max\`, \`$default\`, \`$required\`, \`$props\`, \`$path\`, \`$row\`, \`$show-if\` | поле данных |
| \`repeat\` | \`$label\`, \`$item-title\`, \`$path\`, \`$row\`, \`$show-if\` | массив объектов; дети — поля одного элемента, их пути — от элемента; добавить/удалить/переставить строку — встроено |
| \`group\` | \`$label\`, \`$path\` | вложенный объект без рамки: \`### $group skills\` → \`#### $field physique\` = путь \`skills.physique\` |
| \`computed\` | \`$expr\` (обяз.), \`$type\` (number / string / boolean), \`$label\`, \`$row\` | вычисляемое значение, только чтение, не хранится |
| \`text\` | \`$text\` | статичный текст |

- **Типы полей:** \`string\`, \`integer\`, \`number\`, \`boolean\`, \`string[]\`, \`boolean[]\`, \`object\`, \`object[]\`. Схема данных выводится из полей.
- **Пути:** путь поля = путь групп-предков + имя; внутри \`repeat\` — от элемента. \`$path\` перекрывает имя (\`$path: stress.physical\`). \`section\` в путь не входит.
- **Строки и вкладки — атрибутами:** соседние поля с одним \`$row: <имя>\` — в одну строку; секции с одним \`$tab: <id>\` — одна вкладка. Блоков \`row\`/\`tabs\` нет.
- **\`_id\`** строк массивов ставит движок; в описании его нет.
- **\`$show-if: {путь: ["значение", …]}\`** — по ключам И, внутри списка ИЛИ; значения нет — узел скрыт; данные не трогает. Путь — как у полей (в повторителе — от элемента). Строковые значения — в кавычках, ключ с точками — в кавычках (\`{"data.kind": ["bot"]}\`), флаг — без (\`{enabled: [true]}\`). \`$hide-if\` — то же с отрицанием.
- **JSON5 в одну строку:** \`$props: {kind: "other"}\` — строковые значения внутри объекта в кавычках.

## Выражения

ntpl (Nunjucks с разделителями): значения — \`<< … >>\`, блоки — \`<{ … }>\` (не \`{% %}\`). Переменные — поля от корня (\`skills.physique\`), в повторителе текущий элемент — \`item\`, другие вычисления — \`calc.<id>\`. Результат приводится к \`$type\`. Значение вычисления в props — строкой \`"=<id>"\` (\`$props: {boxes: "=physicalBoxes"}\`). Циклы между вычислениями — ошибка.

Фильтры: ${exprFilters().map((f) => `\`${f}\``).join(', ')}.

Вложенный подсчёт — \`pluck\` + \`flatten\`: \`<< item.scenes | pluck("clues") | flatten | selectattr("found") | length >>\`.

## Виджеты

Без \`$widget\` — по типу: \`string\` → \`text\`, \`string\` с \`$enum\` → \`select\`, \`number\`/\`integer\` → \`number\`, \`boolean\` → \`checkbox\`, \`string[]\` → \`tags\`; у \`object\`, \`object[]\`, \`boolean[]\` виджет пишется явно (или \`repeat\`/\`group\`).

| виджет | тип | props | что |
|---|---|---|---|
${widgets}
${examples ? `\n${examples}\n` : ''}
## Частые ошибки

- путь в повторителе от корня (\`stunts.name\` вместо \`name\`);
- виджет не к типу (\`fate.stress-track\` на \`integer\`), \`select\` без \`$enum\`;
- \`$show-if\` по пути мимо схемы или со значением не из \`$enum\`;
- \`"=<id>"\` в props на несуществующее вычисление;
- \`{% … %}\` в выражении вместо \`<{ … }>\`, неизвестный фильтр (\`map\`);
- блоки \`$row\`/\`$tabs\` вместо атрибутов \`$row\`/\`$tab\`.
`
}
