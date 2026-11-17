// check(def, catalog): описание против схемы и каталога (spec §2–§4). Ошибки — с путём узла и
// подсказкой; документ с ошибкой всё равно открывается тем, что разобралось.

import type { Catalog, FieldInfo } from './catalog.js'
import { createExpressions, ExprError, type Expressions } from './expr.js'
import { derive, leaves, resolve, sample, typeOf } from './schema.js'
import { isKnown, nodeLabel, type AnyNode, type ComputedNode, type EditorDef, type FieldNode, type Issue, type JSONSchema, type ShowIf } from './types.js'

export interface CheckOptions {
  /**
   * Схема типа (`$schema` типа или вывод из редактора по умолчанию). Есть — описание проверяется
   * против неё: поле вне схемы или с другим типом — ошибка, а не новое поле.
   */
  schema?: JSONSchema
}

export interface CheckResult {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
  /** Схема, против которой проверялось: схема типа, своя описания или выведенная. */
  schema: JSONSchema
  expressions: Expressions
  /** Образец данных по схеме, на котором считались выражения. */
  sample: unknown
}

const ROOT_KINDS_HINT: Record<string, string> = {
  row: 'строки — атрибутом $row: <имя> у соседних полей',
  tabs: 'вкладки — атрибутом $tab: <id> у секций',
}

export function check(def: EditorDef, catalog: Catalog, opts: CheckOptions = {}): CheckResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (code: string, where: string, message: string, hint?: string, line?: number): void => {
    const i: Issue = { code, where, message }
    if (hint) i.hint = hint
    if (line) i.line = line
    errors.push(i)
  }
  const warn = (code: string, where: string, message: string, hint?: string): void => {
    warnings.push(hint ? { code, where, message, hint } : { code, where, message })
  }

  if (def.editor !== 1 && (def.editor as unknown) !== '1') err('E_META', '', '$editor: должно быть 1')
  if (!def.id) err('E_META', '', 'нет $id редактора')

  // ---------- схема ----------
  const derived = derive(def)
  for (const i of derived.issues) errors.push(i)
  const base = opts.schema ?? def.schema
  const schema = base ?? derived.schema
  if (typeOf(schema) !== 'object') err('E_SCHEMA', '', `корень схемы — не object (${typeOf(schema) ?? 'нет type'})`)

  const data = sample(schema)
  const exprs = createExpressions(def)
  const sectionIds = new Set<string>()
  const computedIds = new Map<string, number>()
  const bound = new Set<string>()

  const collect = (nodes: AnyNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'computed') {
        const id = (n as { id?: string }).id
        if (id) computedIds.set(id, (computedIds.get(id) ?? 0) + 1)
      }
      collect((n as { children?: AnyNode[] }).children ?? [])
    }
  }
  collect(def.nodes)

  const checkCond = (cond: ShowIf | undefined, key: string, scope: JSONSchema, where: string, line?: number): void => {
    if (cond === undefined) return
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return err('E_SHOW_IF', where, `$${key} — не объект`, `$${key}: {путь: ["значение"]}`, line)
    for (const [p, vals] of Object.entries(cond)) {
      const s = resolve(scope, p)
      if (!s) err('E_SHOW_IF', where, `$${key}: путь "${p}" мимо схемы`, scope === schema ? undefined : 'в повторителе путь — от элемента', line)
      if (!Array.isArray(vals)) {
        err('E_SHOW_IF', where, `$${key}.${p} — не список значений`, `{${p}: [${JSON.stringify(vals)}]}`, line)
        continue
      }
      if (!s) continue
      if (Array.isArray(s.enum)) {
        for (const v of vals) if (!s.enum.includes(v)) err('E_SHOW_IF', where, `$${key}.${p}: ${JSON.stringify(v)} нет в $enum`, `значения: ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`, line)
      } else {
        const t = typeOf(s)
        for (const v of vals) {
          const ok = t === 'boolean' ? typeof v === 'boolean' : t === 'number' || t === 'integer' ? typeof v === 'number' : t === 'string' ? typeof v === 'string' : true
          if (!ok) err('E_SHOW_IF', where, `$${key}.${p}: ${JSON.stringify(v)} не ${t}`, t === 'boolean' ? 'флаг — без кавычек: [true]' : undefined, line)
        }
      }
    }
  }

  const fieldInfo = (n: FieldNode, s: JSONSchema): FieldInfo => {
    const f: FieldInfo = { type: typeOf(s) ?? '?', path: n.path, schema: s }
    if (Array.isArray(s.enum)) f.enum = s.enum
    if (typeof s.format === 'string') f.format = s.format
    return f
  }

  const checkProps = (n: FieldNode, widgetId: string, where: string): void => {
    const w = catalog.get(widgetId)
    const ps = w?.props
    for (const [k, v] of Object.entries(n.props ?? {})) {
      const want = ps?.properties?.[k]
      if (typeof v === 'string' && v.startsWith('=')) {
        const id = v.slice(1)
        const c = exprs.computed.get(id)
        if (!c) {
          err('E_PROPS', where, `$props.${k} = "${v}" — нет вычисления ${id}`, computedIds.size ? `вычисления: ${[...computedIds.keys()].join(', ')}` : 'добавь ### $computed ' + id, n.line)
          continue
        }
        if (want && !typeAllows(want, c.node.type === 'number' ? 'number' : c.node.type)) err('E_PROPS', where, `$props.${k} → вычисление ${id} типа ${c.node.type}, а ждут ${typesOf(want).join(' | ')}`, undefined, n.line)
        continue
      }
      if (!want) continue
      const bad = valueProblem(v, want)
      if (bad) err('E_PROPS', where, `$props.${k}: ${bad}`, undefined, n.line)
      else if (want.format === 'path' && typeof v === 'string' && !resolve(schema, v)) err('E_PROPS', where, `$props.${k}: путь "${v}" мимо схемы`, undefined, n.line)
    }
    for (const r of ps?.required ?? []) if (!(r in (n.props ?? {}))) err('E_PROPS', where, `виджету ${widgetId} нужен $props.${r}`, ps?.properties?.[r]?.description, n.line)
  }

  const walk = (nodes: AnyNode[], scope: JSONSchema, prefix: string, where: string, top: boolean, inRepeat: string | undefined): void => {
    let lastRow: string | undefined
    const rowsSeen = new Set<string>()
    for (const n of nodes) {
      const here = `${where ? `${where} / ` : ''}${nodeLabel(n)}`
      const line = n.line
      if (!isKnown(n)) {
        err('E_NODE', here, `неизвестный узел "${n.kind}"`, ROOT_KINDS_HINT[n.kind] ?? 'узлы: section, field, repeat, group, computed, text', line)
        walk((n as { children?: AnyNode[] }).children ?? [], scope, prefix, here, false, inRepeat)
        continue
      }
      if (top && n.kind !== 'section') err('E_NODE', here, 'на верхнем уровне — только section', 'оберни в ## $section', line)
      if (!top && n.kind === 'section') err('E_NODE', here, 'section — только на верхнем уровне', undefined, line)
      checkCond(n.showIf, 'show-if', scope, here, line)
      checkCond(n.hideIf, 'hide-if', scope, here, line)

      const row = (n as { row?: string }).row
      if (row !== undefined) {
        if (rowsSeen.has(row) && lastRow !== row) warn('W_ROW', here, `строка "${row}" разорвана другими узлами`, 'поля одной строки — подряд')
        rowsSeen.add(row)
      }
      lastRow = row

      switch (n.kind) {
        case 'section':
          if (!n.id) err('E_ID', here, 'section без id', '## $section <id>', line)
          else if (sectionIds.has(n.id)) err('E_ID', here, `id секции "${n.id}" повторяется`, undefined, line)
          else sectionIds.add(n.id)
          walk(n.children, scope, prefix, here, false, inRepeat)
          break
        case 'group': {
          const s = resolve(scope, n.path)
          if (!n.path || !s) err('E_PATH', here, `путь "${n.path}" мимо схемы`, undefined, line)
          else if (typeOf(s) !== 'object') err('E_TYPE', here, `group не над объектом (${typeOf(s)})`, undefined, line)
          walk(n.children, scope, prefix, here, false, inRepeat)
          break
        }
        case 'field': {
          // Правила пульта (research/property-grid.md): подпись — имя поля; как заполнять — $description, значение по умолчанию — $default / placeholder.
          if (n.label && (/[()]/.test(n.label) || / — /.test(n.label) || n.label.length > 32))
            warn('W_LABEL', here, `подпись "${n.label}" несёт подсказку или длиннее 32 знаков`, 'подпись — имя поля; подсказку — в $description, умолчание — в $default или $props: {placeholder}')
          const s = resolve(scope, n.path)
          if (!s) {
            const hint = inRepeat && n.path.startsWith(inRepeat + '.') ? `в повторителе путь — от элемента: ${n.path.slice(inRepeat.length + 1)}` : base && n.type ? 'поле вне схемы типа: добавь его в редактор по умолчанию или в $schema типа' : undefined
            err(base && n.type ? 'E_SCHEMA' : 'E_PATH', here, n.path ? `путь "${n.path}" мимо схемы` : 'поле без пути', hint, line)
            break
          }
          const full = prefix ? `${prefix}[].${n.path}` : n.path
          bound.add(full)
          const t = typeOf(s) ?? '?'
          if (base && n.type && n.type !== t) err('E_TYPE', here, `тип в описании ${n.type}, в схеме ${t}`, 'одно поле — один тип у всех редакторов типа', line)
          const info = fieldInfo(n, s)
          let widget = n.widget
          if (widget) {
            const w = catalog.get(widget)
            if (!w) {
              err('E_WIDGET', here, `неизвестный виджет "${widget}"`, similar(widget, catalog.list().map((x) => x.id)), line)
              break
            }
            const bad = catalog.accepts(w, info)
            if (bad) err('E_WIDGET', here, bad, suggest(catalog, info), line)
          } else {
            const w = catalog.pick(info)
            if (!w) {
              err('E_WIDGET', here, `для типа ${t} нет виджета по умолчанию`, 'укажи $widget' + (t === 'object[]' ? ' или используй $repeat' : t === 'object' ? ' или используй $group' : ''), line)
              break
            }
            widget = w.id
          }
          checkProps(n, widget, here)
          break
        }
        case 'repeat': {
          const s = resolve(scope, n.path)
          if (!s) {
            err('E_PATH', here, n.path ? `путь "${n.path}" мимо схемы` : 'repeat без пути', undefined, line)
            break
          }
          if (typeOf(s) !== 'object[]') {
            err('E_TYPE', here, `repeat не над массивом объектов (${typeOf(s)})`, typeOf(s) === 'string[]' ? 'массив строк — виджет tags или list' : undefined, line)
            break
          }
          const full = prefix ? `${prefix}[].${n.path}` : n.path
          bound.add(full)
          if (n.itemTitle && !resolve(s.items, n.itemTitle)) warn('W_ITEM_TITLE', here, `$item-title "${n.itemTitle}" мимо элемента`)
          walk(n.children, s.items ?? {}, full, here, false, n.path)
          break
        }
        case 'computed':
          checkComputed(n, here, line, scope, inRepeat)
          break
        case 'text':
          break
      }
    }
  }

  // ---------- вычисления ----------
  const evaluated = exprs.evaluate(data)
  const firstError = (id: string): ExprError | undefined => {
    for (const [k, e] of Object.entries(evaluated.errors)) if (k === id || k.endsWith(`.${id}`)) return e
    return undefined
  }
  const checkComputed = (node: ComputedNode, here: string, line: number | undefined, scope: JSONSchema, inRepeat: string | undefined): void => {
    const id = node.id
    if (!id) return err('E_ID', here, 'computed без id', '### $computed <id>', line)
    const info = exprs.computed.get(id)
    if (!info || info.node !== node) return err('E_ID', here, `id вычисления "${id}" повторяется`, undefined, line)
    const n = info.node
    if (!['number', 'string', 'boolean'].includes(n.type)) err('E_TYPE', here, `$type "${n.type ?? ''}" — number | string | boolean`, undefined, line)
    if (!n.expr) return err('E_EXPR', here, 'нет $expr', '$expr: "<< … >>"', line)
    if (info.error) return err('E_EXPR', here, `$expr: ${info.error.message}`, info.error.hint, line)
    // Переменные выражения: поля от корня, item в повторителе, calc.<id>.
    for (const d of info.compiled!.deps) {
      const [head, ...rest] = d.split('.')
      if (head === 'calc') {
        const ref = rest[0]
        if (ref && !exprs.computed.has(ref)) err('E_EXPR', here, `$expr: calc.${ref} — нет такого вычисления`, undefined, line)
        continue
      }
      if (head === 'item') {
        if (!inRepeat) err('E_EXPR', here, '$expr: item — только внутри repeat', undefined, line)
        else if (rest.length && !resolveLoose(scope, rest)) err('E_EXPR', here, `$expr: ${d} мимо элемента`, undefined, line)
        continue
      }
      if (!resolveLoose(schema, [head!, ...rest])) {
        const hint = exprs.computed.has(head!) ? `другое вычисление — calc.${head}` : inRepeat && resolveLoose(scope, [head!, ...rest]) ? `поле элемента — item.${d}` : undefined
        err('E_EXPR', here, `$expr: переменная ${d} мимо схемы`, hint, line)
      }
    }
    const e = firstError(id)
    if (e) err('E_EXPR', here, `$expr ${e.message}`, e.hint, line)
  }

  walk(def.nodes, schema, '', '', true, undefined)

  for (const c of exprs.cycles) err('E_CYCLE', `computed ${c[0]}`, `цикл вычислений: ${c.join(' → ')}`, 'вычисление не может зависеть от себя через calc.*')

  // ---------- покрытие ----------
  const unbound = leaves(schema).filter((p) => p && !bound.has(p) && !p.endsWith('._id') && p !== '_id' && !coveredByJson(p, bound))
  if (unbound.length) warn('W_COVERAGE', '', `поля схемы без виджета: ${unbound.join(', ')}`)

  return { ok: errors.length === 0, errors, warnings, schema, expressions: exprs, sample: data }
}

/** Путь в схеме, где сегменты массивов объектов проходятся насквозь (`sessions.scenes.clues`). */
function resolveLoose(scope: JSONSchema, parts: string[]): JSONSchema | undefined {
  let cur: JSONSchema | undefined = scope
  for (const p of parts) {
    if (typeOf(cur)?.endsWith('[]')) {
      if (/^\d+$/.test(p) || p === 'length') return cur
      cur = cur?.items
    }
    if (typeOf(cur) === 'string' && p === 'length') return cur
    const next: JSONSchema | undefined = cur?.properties?.[p]
    if (!next) return /^\d+$/.test(p) || (cur && !cur.properties && typeOf(cur) === 'object') ? cur : undefined
    cur = next
  }
  return cur
}

/** Лист внутри объекта, отданного json-виджету целиком, — покрыт. */
function coveredByJson(p: string, bound: Set<string>): boolean {
  for (const b of bound) if (p.startsWith(b + '.') || p.startsWith(b + '[].')) return true
  return false
}

function typesOf(s: JSONSchema): string[] {
  return Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
}

function typeAllows(s: JSONSchema, t: string): boolean {
  const ts = typesOf(s)
  return !ts.length || ts.includes(t) || (t === 'number' && ts.includes('integer'))
}

/** Значение props против своей схемы (тип, enum); проблема строкой. */
function valueProblem(v: unknown, s: JSONSchema): string | undefined {
  const ts = typesOf(s)
  if (ts.length) {
    const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v
    const ok = ts.some((t) => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) return `${JSON.stringify(v)} — не ${ts.join(' | ')}`
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return `${JSON.stringify(v)} — одно из ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`
  return undefined
}

function suggest(catalog: Catalog, f: FieldInfo): string | undefined {
  const fit = catalog
    .list()
    .filter((w) => !catalog.accepts(w, f))
    .map((w) => w.id)
  return fit.length ? `к ${f.type} подходят: ${fit.slice(0, 8).join(', ')}` : undefined
}

function similar(id: string, ids: string[]): string | undefined {
  const head = id.split('.')[0]!
  const near = ids.filter((x) => x.startsWith(head) || x.includes(id) || id.includes(x))
  return near.length ? `похожие: ${near.slice(0, 6).join(', ')}` : `в каталоге: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''}`
}
