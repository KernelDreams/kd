/**
 * Объявление тула (kd-cli-spec §2) — одно на разбор командной строки, справку, Tab, форму,
 * `ToolDef` и палитры. Формат — расширение `## $form`: к полю добавляются пометки `$pos`,
 * `$kind`, `$for`, `$rest` (разбирает `@kerneldreams/forms`), к тулу — блоки `## $action <имя>`
 * и корневые `$needs`, `$examples`, `$effects`, `$repeatable`, `$dry`, `$action_arg`.
 * Умолчание поля — одноимённая корневая переменная (правило форм).
 *
 * Без ввода-вывода: текст документа и nrd приходят снаружи.
 */

import { buildSchema, type FieldSchema, type FormField, type FormSchema, type FormSection, type VarValue } from '@kerneldreams/forms'

export interface ToolAction {
  name: string
  title?: string
  default?: boolean
  /** Шаг с побочным действием повторяется сам после обрыва (§8). */
  repeatable?: boolean
  /** Исполнение всухую заявлено (`--dry` исполняет). */
  dry?: boolean
  /** Что меняет действие (`fs`, `net`, `remote`…): для выбора среды. */
  effects?: string[]
  examples?: string[]
}

export interface ToolField {
  name: string
  schema: FieldSchema
  required: boolean
}

export interface ToolDecl {
  name: string
  description: string
  /** Поля по порядку объявления. */
  fields: ToolField[]
  /** Закрытый список действий; пусто — тул без действий. */
  actions: ToolAction[]
  /** Имя аргумента, в котором тул ждёт действие (`action`; у forge — `cmd`). */
  actionArg: string
  needs: string[]
  examples: string[]
  repeatable: boolean
  dry: boolean
  effects: string[]
  /** Объявление без типов (`export const flags`, `$flags`) или его нет вовсе: слова — в `$_`, флаги как есть. */
  legacy: boolean
  /** Короткие имена флагов: `c` → `continue` (`-c`). */
  aliases?: Record<string, string>
  /** Схема формы (для `FormView`): та же, из которой поля. */
  form?: FormSchema
  /** Файл, где объявлено. */
  source?: string
}

/** Минимум от nrd (`@kerneldreams/nrd`): модуль целиком подходит. */
export interface DeclNrd {
  parseDocument(text: string, opts: { sigil: "$" }): unknown
  asText(v: unknown): string | undefined
  isContext(v: unknown): boolean
}

interface Ctx {
  get(p: string[]): unknown
  cast<T>(p: string): T | undefined
}
interface Arr {
  iterate(): Iterable<unknown>
}
const isArr = (v: unknown): v is Arr => !!v && typeof v === 'object' && typeof (v as Arr).iterate === 'function'

function textOf(nrd: DeclNrd, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isArr(v) && !nrd.isContext(v)) return [...v.iterate()].map((x) => textOf(nrd, x)).join(', ')
  const t = nrd.asText(v)
  if (t !== undefined) return t
  if (nrd.isContext(v)) return String((v as Ctx).get(['raw']) ?? '')
  return ''
}

/** Корневые атрибуты (last-wins): скаляр — сырым текстом, список — элементами. */
function attrsOf(nrd: DeclNrd, ctx: Ctx): Record<string, VarValue> {
  const out: Record<string, VarValue> = {}
  const attrs = ctx.cast<Arr>('attrs')
  if (!attrs) return out
  for (const attr of attrs.iterate()) {
    if (!nrd.isContext(attr)) continue
    const a = attr as Ctx
    const key = a.get(['key'])
    if (typeof key !== 'string') continue
    const value = a.get(['value'])
    out[key] = isArr(value) && !nrd.isContext(value) ? [...value.iterate()].map((x) => textOf(nrd, x)) : textOf(nrd, value)
  }
  return out
}

/** Список из значения: `$[a, b]`, `[a, b]`, `a, b`. */
export function listOf(v: VarValue | undefined): string[] {
  if (v === undefined) return []
  const items = Array.isArray(v) ? v : v.replace(/^\$?\[|\]$/g, '').split(',')
  return items.map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

const truthy = (v: VarValue | undefined): boolean => typeof v === 'string' && v.trim() === 'true'
const isMetaKey = (k: string): boolean => k.startsWith('nr-') || k.startsWith('nr.')

function finish(name: string, fields: FormField[], vars: Record<string, VarValue>, sections: FormSection[] | undefined, rest: Omit<ToolDecl, 'name' | 'fields' | 'form' | 'legacy'>): ToolDecl {
  let form: FormSchema | undefined
  const out: ToolField[] = []
  if (fields.length > 0) {
    form = buildSchema(fields, vars, sections ? { sections } : {})
    for (const f of fields) out.push({ name: f.name, schema: form.properties[f.name]!, required: form.required.includes(f.name) })
  }
  const decl: ToolDecl = { name, fields: out, legacy: false, ...rest }
  if (form) decl.form = form
  checkDecl(decl)
  return decl
}

/** Проверка объявления: действия, `$for`, `$default`, `$rest` — громко. */
export function checkDecl(d: ToolDecl): void {
  const names = new Set<string>()
  for (const a of d.actions) {
    if (names.has(a.name)) throw new Error(`${d.name}: действие «${a.name}» объявлено дважды`)
    names.add(a.name)
  }
  const defaults = d.actions.filter((a) => a.default)
  if (defaults.length > 1) throw new Error(`${d.name}: $default у нескольких действий (${defaults.map((a) => a.name).join(', ')})`)
  for (const f of d.fields) {
    for (const a of f.schema['x-ui'].for ?? []) if (!names.has(a)) throw new Error(`${d.name}: поле ${f.name} — $for=${a}, а такого действия нет`)
  }
  for (const a of d.actions.length ? d.actions : [{ name: '' }]) {
    const rests = d.fields.filter((f) => f.schema['x-ui'].rest && appliesTo(f, a.name || undefined))
    if (rests.length > 1) throw new Error(`${d.name}: $rest у нескольких полей одного действия (${rests.map((f) => f.name).join(', ')})`)
  }
}

/** Поле относится к действию (`$for` нет — ко всем). */
export function appliesTo(f: ToolField, action: string | undefined): boolean {
  const list = f.schema['x-ui'].for
  return !list || list.length === 0 || (action !== undefined && list.includes(action))
}

/** Id блоков `## $<name> <id>` с кодом (фенс в теле) — исполняемые блоки рантайма, не объявления. */
export function codedBlocks(text: string, name: string): Set<string> {
  const out = new Set<string>()
  let cur: string | null = null
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const tick = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (line.trim() === fence) fence = null
      continue
    }
    if (tick) {
      fence = tick
      if (cur) out.add(cur)
      continue
    }
    const h = /^##\s+\$([\w.-]+)(?:\s+(\S+))?/.exec(line)
    if (h) {
      cur = h[1] === name && h[2] ? h[2] : null
      continue
    }
    // Код без фенса (старые рецепты runz: `## $action go` + `return 1`): строка тела — не атрибут,
    // не комментарий, не продолжение списка — блок исполняемый.
    if (cur && line.trim() !== '' && !/^\s*(\$[\w.-]+\s*:|\/\/|#|[-*]\s|\]|\})/.test(line) && !/^\s+\S/.test(line)) out.add(cur)
  }
  return out
}

/** Документ mdz → объявление. Нет `## $form` и `## $action` — `null` (тул без объявления). */
export function declFromMdz(nrd: DeclNrd, name: string, text: string, source?: string): ToolDecl | null {
  const doc = nrd.parseDocument(text, { sigil: '$' as const }) as Ctx
  const coded = codedBlocks(text, 'action')
  const vars = attrsOf(nrd, doc)
  const records = doc.cast<Arr>('records')
  const forms = new Map<string, Ctx>()
  const actions: ToolAction[] = []
  if (records) {
    for (const rec of records.iterate()) {
      if (!nrd.isContext(rec)) continue
      const r = rec as Ctx
      const kind = r.cast<string>('name')
      const id = r.cast<string>('id')
      if (kind === 'form') forms.set(typeof id === 'string' ? id : '', r)
      else if (kind === 'action' && typeof id === 'string' && !coded.has(id)) {
        const a = attrsOf(nrd, r)
        const act: ToolAction = { name: id }
        if (typeof a.title === 'string' && a.title.trim()) act.title = a.title.trim()
        if (truthy(a.default)) act.default = true
        if (truthy(a.repeatable)) act.repeatable = true
        if (truthy(a.dry)) act.dry = true
        if (a.effects !== undefined) act.effects = listOf(a.effects)
        if (a.examples !== undefined) act.examples = listOf(a.examples)
        actions.push(act)
      }
    }
  }
  // Документ — объявление kd, только если в нём есть действия-объявления или поля с пометками kd;
  // пульты рецептов (`## $form` без пометок) и блоки кода `## $action` идут по-старому.
  const marked = [...forms.values()].some((rec) => Object.values(attrsOf(nrd, rec)).some((v) => typeof v === 'string' && /(^|\s)\$(pos|kind|for|rest)\b/.test(v)))
  if (actions.length === 0 && !marked) return null
  const fields: FormField[] = []
  const sections: FormSection[] = []
  for (const [id, rec] of forms) {
    const fv = attrsOf(nrd, rec)
    const title = fv['nr-title']
    sections.push({ id, title: typeof title === 'string' && title.trim() ? title.trim() : id })
    for (const [k, spec] of Object.entries(fv)) if (!isMetaKey(k)) fields.push({ name: k, spec: Array.isArray(spec) ? spec.join(', ') : spec, section: id })
  }
  const desc = typeof vars.description === 'string' ? vars.description.trim() : ''
  return finish(name, fields, vars, sections.length > 1 ? sections : undefined, {
    description: desc,
    actions,
    actionArg: typeof vars.action_arg === 'string' && vars.action_arg.trim() ? vars.action_arg.trim() : 'action',
    needs: listOf(vars.needs),
    examples: listOf(vars.examples),
    repeatable: truthy(vars.repeatable),
    dry: truthy(vars.dry),
    effects: listOf(vars.effects),
    ...(source ? { source } : {}),
  })
}

/** Объявление `.ts`-тула: `export const tool = {…}`. */
export interface ToolObject {
  description?: string
  /** Поле → строка `## $form` (`string $pos=1 $kind=url // Адрес`). */
  fields?: Record<string, string>
  /** Умолчания полей (как корневые переменные документа). */
  defaults?: Record<string, string | number | boolean | string[]>
  actions?: Record<string, Omit<ToolAction, 'name'> | string>
  actionArg?: string
  needs?: string[]
  examples?: string[]
  repeatable?: boolean
  dry?: boolean
  effects?: string[]
  aliases?: Record<string, string>
}

export function declFromObject(name: string, obj: ToolObject, source?: string): ToolDecl {
  const vars: Record<string, VarValue> = {}
  for (const [k, v] of Object.entries(obj.defaults ?? {})) vars[k] = Array.isArray(v) ? v.map(String) : String(v)
  const fields: FormField[] = Object.entries(obj.fields ?? {}).map(([n, spec]) => ({ name: n, spec }))
  const actions: ToolAction[] = Object.entries(obj.actions ?? {}).map(([n, a]) => (typeof a === 'string' ? { name: n, title: a } : { name: n, ...a }))
  const d = finish(name, fields, vars, undefined, {
    description: obj.description ?? '',
    actions,
    actionArg: obj.actionArg ?? 'action',
    needs: obj.needs ?? [],
    examples: obj.examples ?? [],
    repeatable: obj.repeatable === true,
    dry: obj.dry === true,
    effects: obj.effects ?? [],
    ...(source ? { source } : {}),
  })
  if (obj.aliases) d.aliases = obj.aliases
  return d
}

/** Тул без объявления или с `flags` без типов: работает по-старому. */
export function legacyDecl(name: string, description: string, flags?: Map<string, string> | null, source?: string): ToolDecl {
  const fields: ToolField[] = []
  let order = 0
  for (const [k, d] of flags ?? []) {
    fields.push({ name: k, required: false, schema: { type: 'string', ...(d ? { title: d } : {}), 'x-ui': { widget: 'input', order: order++, section: '' } } })
  }
  return { name, description, fields, actions: [], actionArg: 'action', needs: [], examples: [], repeatable: false, dry: false, effects: [], legacy: true, ...(source ? { source } : {}) }
}

/** Действие по умолчанию. */
export function defaultAction(d: ToolDecl): string | undefined {
  return d.actions.find((a) => a.default)?.name
}
