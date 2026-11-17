// Описание редактора объекта (universal-editor-spec §2): каноническая модель в памяти.
// mdz (`*.editor.mdz`) и JSON (`*.editor.json`, провод и тулы) разбираются в неё же.

/** Типы полей описания. Массивы прочих скаляров (`number[]`) схема может нести — виджеты их не ждут. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'string[]' | 'boolean[]' | 'object' | 'object[]'

export const FIELD_TYPES: readonly FieldType[] = ['string', 'integer', 'number', 'boolean', 'string[]', 'boolean[]', 'object', 'object[]']

/** Тип результата вычисления. */
export type ComputedType = 'number' | 'string' | 'boolean'

/** JSON Schema (2020-12) — то подмножество, что читает пакет; прочие ключи проходят как есть. */
export interface JSONSchema {
  type?: string | string[]
  properties?: Record<string, JSONSchema>
  items?: JSONSchema
  required?: string[]
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
  title?: string
  description?: string
  format?: string
  [key: string]: unknown
}

/**
 * `{путь: [значения]}`: по ключам И, внутри списка ИЛИ; значения нет — скрыто. Путь — от корня,
 * внутри повторителя — от элемента. Данные не трогает.
 */
export type ShowIf = Record<string, unknown[]>

interface NodeBase {
  showIf?: ShowIf
  /** То же с отрицанием: скрыто, если условие выполнено. */
  hideIf?: ShowIf
  /** Строка источника (mdz) — для сообщений. */
  line?: number
}

export interface SectionNode extends NodeBase {
  kind: 'section'
  id: string
  title?: string
  collapsed?: boolean
  /** Вкладка: секции с одним `tab` — одна вкладка, порядок вкладок — по первому появлению. */
  tab?: string
  children: EditorNode[]
}

export interface FieldNode extends NodeBase {
  kind: 'field'
  /** Имя из заголовка mdz (`### $field physical`) — для сообщений; путь — `path`. */
  id?: string
  /** Путь от корня, внутри повторителя — от элемента. С учётом групп-предков. */
  path: string
  /** Тип поля в описании (mdz). Нет — берётся из схемы (JSON-описание со своей схемой). */
  type?: FieldType
  label?: string
  description?: string
  widget?: string
  enum?: unknown[]
  min?: number
  max?: number
  default?: unknown
  required?: boolean
  /** props виджета; строка `"=<id>"` — значение вычисления. */
  props?: Record<string, unknown>
  /** Поля одной строки — одно имя `row` у соседей. */
  row?: string
  /**
   * Генераторы поля (bot-assembly-spec §10): id рецептов, что пишут кандидат в поле
   * (`$generators: $[greeting-write, greeting-adapt]`). Запуск и подписи — у хозяина
   * (`ObjectEditorProps.generators`); id, которого хозяин не знает, не рисуется.
   */
  generators?: string[]
}

export interface RepeatNode extends NodeBase {
  kind: 'repeat'
  id?: string
  /** Путь массива объектов; пути детей — от элемента. */
  path: string
  label?: string
  itemTitle?: string
  row?: string
  children: EditorNode[]
}

export interface GroupNode extends NodeBase {
  kind: 'group'
  id?: string
  /** Путь вложенного объекта; пути детей уже содержат его (`skills.physique`). */
  path: string
  label?: string
  children: EditorNode[]
}

export interface ComputedNode extends NodeBase {
  kind: 'computed'
  id: string
  /** Выражение ntpl: `<< 3 + (1 if skills.physique >= 1 else 0) >>`. */
  expr: string
  type: ComputedType
  label?: string
  row?: string
}

export interface TextNode extends NodeBase {
  kind: 'text'
  text: string
}

/** Узел, которого пакет не знает (`row`, `tabs`, опечатка): разбирается, `check` сообщает. */
export interface UnknownNode extends NodeBase {
  kind: string
  id?: string
  children: EditorNode[]
}

export type EditorNode = SectionNode | FieldNode | RepeatNode | GroupNode | ComputedNode | TextNode

/** Узел дерева как его отдал разбор: известный или нет. */
export type AnyNode = EditorNode | UnknownNode

export interface EditorDef {
  editor: 1
  id: string
  title?: string
  /** Версия описания = `$version` типа. */
  version?: number
  /** Готовая схема данных (JSON-описание её несёт; mdz выводит схему из полей). */
  schema?: JSONSchema
  /**
   * Каким объектам описание годится (вид-редактор типа виден только им;: «Бот nr» —
   * у ботов `extensions.nrchat.type: nr`). Путь — от корня данных объекта.
   */
  showIf?: ShowIf
  nodes: AnyNode[]
}

/** Ошибка или предупреждение разбора и проверки: где (путь узла), что, как починить. */
export interface Issue {
  code: string
  /** `section stress / field physical` */
  where: string
  message: string
  hint?: string
  line?: number
}

/** Строка сообщения: `where: message — hint (строка N)`. */
export function formatIssue(i: Issue): string {
  return `${i.where ? `${i.where}: ` : ''}${i.message}${i.hint ? ` — ${i.hint}` : ''}${i.line ? ` (строка ${i.line})` : ''}`
}

export function isKnown(n: AnyNode): n is EditorNode {
  return n.kind === 'section' || n.kind === 'field' || n.kind === 'repeat' || n.kind === 'group' || n.kind === 'computed' || n.kind === 'text'
}

/** Подпись узла в пути сообщения: `field physical`, `repeat aspects`. */
export function nodeLabel(n: AnyNode): string {
  const r = n as { id?: string; path?: string }
  const name = r.id ?? r.path
  return name ? `${n.kind} ${name}` : n.kind
}
