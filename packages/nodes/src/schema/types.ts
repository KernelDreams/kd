// Модель схемы (node-canvas-spec §3): одна структура хранения на все виды — граф, блоки, дерево,
// доска, таймлайн. Без UI и без формата файла: файл читает и пишет адаптер формата, модель — его
// проекция. Правка модели — команды документа ядра `@kerneldreams/forms/editor` (см. document.ts).
//
// Строки массивов (сущности, отношения, строки композита, части строки, переменные) несут `_id` —
// его ставит документ; адрес строки в команде — `space.entities[<_id>]`.

/** Род отношения. `visual` (стрелка между заметками) никогда не исполняется. */
export type RelationKind = 'data' | 'control' | 'transition' | 'choice' | 'hierarchy' | 'reference' | 'visual'

export const RELATION_KINDS: readonly RelationKind[] = ['data', 'control', 'transition', 'choice', 'hierarchy', 'reference', 'visual']

/** Что за сущность на полотне. Исполняется только `node`. */
export type EntityRole = 'node' | 'group' | 'frame' | 'note' | 'file' | 'link' | 'shape' | 'stroke'

/** Как раскладывается пространство. */
export type SpaceMode = 'graph' | 'tree' | 'board' | 'timeline'

/** Конец отношения: сущность и (необязательно — доска, майнд-карта) порт. */
export interface RelationEnd {
  entity: string
  port?: string
}

export interface Relation {
  _id?: string
  kind: RelationKind
  from: RelationEnd
  to: RelationEnd
  label?: string
}

/** Выражение: дерево, у каждого узла `id`. Живёт внутри сущности (тело, условие, фильтр), не отношениями. */
export type Expression =
  | { id: string; kind: 'literal'; value: unknown }
  | { id: string; kind: 'variable'; name: string }
  | { id: string; kind: 'call'; fn: string; args: Expression[] }
  | { id: string; kind: 'concat'; parts: Expression[] }
  | { id: string; kind: 'conditional'; test: Expression; then: Expression; else?: Expression }

/** Привязка значения поля: литерал, переменная схемы (с областью), выражение или авто по имени. */
export type ValueBinding =
  | { kind: 'literal'; value: unknown }
  | { kind: 'variable'; name: string; scope?: 'local' | 'parent' | 'global' }
  | { kind: 'expression'; expr: Expression }
  /** Параметр подсхемы без привязки берёт одноимённую переменную вызывающей. */
  | { kind: 'auto' }

/** Привязка к исходнику: адрес символа + структурный путь; диапазон — только кэш разбора. */
export interface SourceBinding {
  /** Блок или символ: `composite:person`, `class Foo`. */
  symbol: string
  path?: string[]
  /** [начало, конец) в тексте — пересчитывается после каждого разбора. */
  range?: [number, number]
}

// ---------- композит (макет D) ----------

/** Род в мете: м, ж, с, мн (в тексте ntpl — те же буквы). */
export type PillRod = 'м' | 'ж' | 'с' | 'мн'

/** Мета пилюли и строки: преобразование значения, а не вложенный блок. Мета строки наследуется пилюлями. */
export interface PillMeta {
  rod?: PillRod
  /** Падеж: и р д в т п. */
  padej?: 'и' | 'р' | 'д' | 'в' | 'т' | 'п'
  /** Значение — имя отца, показать отчеством (род — из меты). */
  patronymic?: boolean
  /** Согласовать слово (фамилия, прилагательное) с родом. */
  agree?: boolean
  /** Регистр. */
  case?: 'title' | 'upper' | 'lower'
}

export type RowPart =
  | { _id?: string; kind: 'text'; text: string }
  | { _id?: string; kind: 'pill'; var: string; meta?: PillMeta }

/** Строка-вариант композита: плоская последовательность пилюль и литералов. */
export interface CompositeRow {
  _id?: string
  /** Метка строки (`м`, `ж`). */
  label?: string
  /** Вес выбора; по умолчанию 1. */
  weight?: number
  /** Условие (выражение ntpl над переменными); пусто — всегда. */
  when?: string
  meta?: PillMeta
  parts: RowPart[]
}

/** Переменная композита: вход со своим выбором. Провод из справочника приходит на порт `var:<name>`. */
export interface CompositeVar {
  _id?: string
  name: string
  /** Номер цвета типа (1…8) — пилюля и провод одного цвета. */
  color?: number
  type?: string
}

export interface Composite {
  variables: CompositeVar[]
  rows: CompositeRow[]
}

/** Порт переменной композита. */
export const varPort = (name: string): string => `var:${name}`
export const portVar = (port: string | undefined): string | undefined => (port?.startsWith('var:') ? port.slice(4) : undefined)

// ---------- сущности и пространства ----------

export interface Entity {
  _id?: string
  role: EntityRole
  /** Тип узла из вида схемы (`namegen:list`). */
  typeId?: string
  name?: string
  properties?: Record<string, unknown>
  /** Входы, задаваемые не проводом. */
  bindings?: Record<string, ValueBinding>
  composite?: Composite
  /** Вызов подсхемы: ссылка на определение, не копия. */
  call?: { space: string }
  source?: SourceBinding
}

export interface PortSpec {
  name: string
  type?: string
}

export interface Variable {
  _id?: string
  name: string
  type?: string
  value?: unknown
}

export interface Space {
  _id?: string
  name?: string
  mode: SpaceMode
  entities: Entity[]
  relations: Relation[]
  variables?: Variable[]
  interface?: { inputs: PortSpec[]; outputs: PortSpec[] }
  /** Вложенные пространства — определения подсхем. */
  spaces?: Space[]
}

/** Документ схемы: вид схемы + корневое пространство + типы. */
export interface SchemaModel {
  /** Вид схемы (`namegen`, `comfy`). */
  kind: string
  name?: string
  space: Space
  types?: TypeDefinition[]
}

// ---------- типы ----------

export interface FieldDefinition {
  name: string
  type: string
  required?: boolean
  description?: string
  /** Ограничения (min, max, pattern, enum…) — как в JSON Schema. */
  constraints?: Record<string, unknown>
  attributes?: Record<string, unknown>
}

/** Тип пина, поля формы или сообщения протокола — проекция схемы форм (JSON Schema), не вторая система типов. */
export interface TypeDefinition {
  id: string
  kind: 'object' | 'enum' | 'union' | 'message' | 'scalar'
  title?: string
  fields?: FieldDefinition[]
  values?: unknown[]
  of?: string[]
}

/** Адрес состояния прогона: сущность + порт + путь экземпляра (одно дерево у ста NPC). Не часть документа. */
export interface RunAddress {
  entity: string
  port?: string
  instance?: string[]
}
