// <ObjectEditor> (spec §6): документ + описание → инспектор или лист. Повторители (вложенные,
// перетаскивание, `_id` строк), группы, строки `$row` и вкладки `$tab` (лист), вычисления (граф
// документа: пересчёт зависимых), `show-if`, виджеты каталога, виджет-iframe, поиск по полям
// в инспекторе (≥ 15), свёрнутые секции со сводкой, происхождение значения и «вернуть».
//
// Правка — только командами документа (`object.set/insert/remove/move`): undo, история, агент —
// одни. Ядро выражений (nunjucks) сюда не тянется: значения вычислений берутся из `doc`.

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, GripVertical, Plus, RotateCcw, Search, X } from 'lucide-react'
import { createContext, useContext, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { Catalog, FieldInfo, WidgetDef } from '../editor/catalog.js'
import { shown } from '../editor/cond.js'
import type { ObjectDocument } from '../editor/document.js'
import { get } from '../editor/get.js'
import { formatIssue, type AnyNode, type ComputedNode, type EditorDef, type EditorNode, type FieldNode, type GroupNode, type Issue, type JSONSchema, type RepeatNode, type SectionNode } from '../editor/types.js'
import { frameWidget } from './frame.js'
import { EDITOR_LABELS, fmt, type EditorLabels } from './labels.js'
import { fallbackWidget, INLINE_WIDGETS, SHORT_WIDGETS, WIDGET_COMPONENTS, type WidgetComponent } from './widgets.js'
import { FieldGrid, useFormControls } from '../controls.js'

export interface FieldOrigin {
  /** Метка уровня: «рецепт», «вариант», «библиотека». */
  label: string
  /** Значение уровня ниже; отличается от текущего — «↶ вернуть». */
  base?: unknown
  /** Свой «вернуть» (снять запись уровня); нет — `object.set` пути значением `base`. */
  onRevert?(): void
}

export interface EditorVariants {
  options: { id: string; title: string }[]
  value?: string
  onChange(id: string): void
}

/** Поле для меню хозяина (`fieldMenu`): прочитать, скопировать, продиктовать (voice-everywhere-spec §1). */
export interface EditorFieldRef {
  /** Путь команды (`aspects[a7f3].text`). */
  path: string
  label: string
  type: string
  value: unknown
  readOnly: boolean
  /** Записать значение одной командой (`object.set`); у `readOnly` — нет. */
  set?(value: unknown): void
}

/**
 * Генератор поля (bot-assembly-spec §10): рецепт, что пишет кандидат в поле. Описание поля
 * называет id (`$generators`), хозяин — подпись и запуск. Кандидат — под полем: «Принять»
 * пишет его одной командой, «Нет» — выбрасывает.
 */
export interface EditorGenerator {
  title: string
  /** Кандидат значения поля; `row` — строка повторителя (гритинг целиком), `object` — документ. */
  run(field: EditorFieldRef, ctx: { row?: unknown; object: unknown }): Promise<unknown>
}

export interface ObjectEditorProps {
  doc: ObjectDocument
  /** Описание; нет — `doc.def`. */
  def?: EditorDef
  view?: 'inspector' | 'sheet'
  /** Строка повторителя (`aspects[a7f3]`): редактор только её полей (инспектор ноды графа). */
  root?: string
  /** Хозяин вида (objects-spec §5.4) — отдаётся виджетам как есть. */
  host?: unknown
  labels?: Partial<EditorLabels>
  /** Свои виджеты по id (перекрывают каталог). */
  widgets?: Record<string, WidgetComponent>
  /** Происхождение значения по пути команды. */
  origins?: Record<string, FieldOrigin>
  variants?: EditorVariants
  /** Ошибки описания (`check`) — строкой над редактором; остальное живо. */
  issues?: Issue[]
  readOnly?: boolean
  /** Порог поиска по полям инспектора; по умолчанию 15. */
  searchFrom?: number
  /**
   * Меню поля у хозяина: правый клик по полю или «⋯» у подписи. Нет — ни кнопки, ни
   * перехвата правого клика (системное меню на месте).
   */
  fieldMenu?(field: EditorFieldRef, anchor: { x: number; y: number }): void
  /** Генераторы полей по id (§10); поле зовёт те, что названы в его `$generators`. */
  generators?: Record<string, EditorGenerator>
}

/** Подписка на документ: перерисовка на каждое `change`. */
export function useDocument<T>(doc: ObjectDocument<T>): T {
  return useSyncExternalStore(
    (fn) => doc.on('change', fn),
    () => doc.object,
    () => doc.object,
  )
}

// ---------- контекст ----------

interface Ctx {
  doc: ObjectDocument
  def: EditorDef
  view: 'inspector' | 'sheet'
  labels: EditorLabels
  widgets: Record<string, WidgetComponent>
  catalog: Catalog | undefined
  origins: Record<string, FieldOrigin>
  host: unknown
  readOnly: boolean
  query: string
  fieldPaths: string[]
  fieldMenu: ObjectEditorProps['fieldMenu']
  generators: Record<string, EditorGenerator>
}

interface Scope {
  data: unknown
  /** Префикс пути команды: '' или `aspects[a7f3].`. */
  prefix: string
  /** Префикс пути схемы без строк: '' или `aspects.`. */
  norm: string
}

const EditorCtx = createContext<Ctx | null>(null)
const useCtx = (): Ctx => {
  const c = useContext(EditorCtx)
  if (!c) throw new Error('ObjectEditor: нет контекста')
  return c
}

const ICON = 'size-nr-icon-sm shrink-0'
const BTN = 'inline-flex items-center gap-nr-1 rounded-nr px-nr-1 py-0.5 text-nr-xs text-nr-muted hover:text-nr-fg disabled:opacity-40'
const rowIdOf = (r: unknown): string | undefined => (r && typeof r === 'object' && typeof (r as { _id?: unknown })._id === 'string' ? (r as { _id: string })._id : undefined)

/** Схема по пути без строк (`aspects.text`). */
function schemaAtPath(schema: JSONSchema | undefined, path: string): JSONSchema | undefined {
  let cur = schema
  for (const seg of path.split('.')) {
    if (!cur) return undefined
    if (cur.items && !cur.properties) cur = cur.items
    cur = cur.properties?.[seg]
  }
  return cur
}

function typeOfSchema(s: JSONSchema | undefined): string | undefined {
  if (!s) return undefined
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type
  if (t === 'array') {
    const it = typeOfSchema(s.items)
    return it ? `${it}[]` : 'array'
  }
  return t ?? (s.properties ? 'object' : undefined)
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Поля, видимые сейчас (`show-if` узла и его предков по данным корня): порог поиска считает их, а не всё описание. */
function visibleFields(nodes: AnyNode[], data: unknown, out: FieldNode[] = []): FieldNode[] {
  for (const n of nodes) {
    if (!shown(n, data)) continue
    if (n.kind === 'field') out.push(n as FieldNode)
    if (n.kind !== 'repeat') visibleFields((n as { children?: AnyNode[] }).children ?? [], data, out)
  }
  return out
}

function allFields(nodes: AnyNode[], out: FieldNode[] = []): FieldNode[] {
  for (const n of nodes) {
    if (n.kind === 'field') out.push(n as FieldNode)
    allFields((n as { children?: AnyNode[] }).children ?? [], out)
  }
  return out
}

/** Узел подходит поиску (подпись, путь, id) — сам или кто-то из детей. */
function matches(n: AnyNode, q: string): boolean {
  if (!q) return true
  const r = n as { label?: string; title?: string; path?: string; id?: string; children?: AnyNode[] }
  const hay = `${r.label ?? ''} ${r.title ?? ''} ${r.path ?? ''} ${r.id ?? ''}`.toLowerCase()
  if (n.kind !== 'section' && n.kind !== 'group' && hay.includes(q)) return true
  if (n.kind === 'section' && (r.title ?? '').toLowerCase().includes(q)) return true
  return (r.children ?? []).some((c) => matches(c, q))
}

// ---------- корень ----------

export function ObjectEditor(props: ObjectEditorProps): ReactNode {
  const { doc } = props
  const object = useDocument(doc)
  const def = props.def ?? doc.def
  const view = props.view ?? 'inspector'
  const labels = useMemo(() => ({ ...EDITOR_LABELS, ...props.labels }), [props.labels])
  const fields = useMemo(() => allFields(def.nodes), [def])
  const [query, setQuery] = useState('')
  const searchable = view === 'inspector' && visibleFields(def.nodes, object).length >= (props.searchFrom ?? 15)
  const ctx: Ctx = {
    doc,
    def,
    view,
    labels,
    widgets: props.widgets ?? {},
    catalog: doc.catalog,
    origins: props.origins ?? {},
    host: props.host,
    readOnly: props.readOnly ?? false,
    query: searchable ? query.trim().toLowerCase() : '',
    fieldPaths: fields.map((f) => f.path),
    fieldMenu: props.fieldMenu,
    generators: props.generators ?? {},
  }

  let nodes: AnyNode[] = def.nodes
  let scope: Scope = { data: object, prefix: '', norm: '' }
  if (props.root) {
    const found = findRoot(def.nodes, object, props.root)
    if (found) ({ nodes, scope } = found)
    else nodes = []
  }

  const sheet = view === 'sheet'
  const hits = ctx.query ? nodes.filter((n) => matches(n, ctx.query)).length : 1
  return (
    <EditorCtx.Provider value={ctx}>
      <div
        data-testid={sheet ? 'oe-sheet' : 'oe-inspector'}
        data-editor={def.id}
        className={
          sheet
            ? 'flex flex-col gap-nr-5 rounded-nr-lg border border-[var(--nr-sheet-line,var(--nr-line))] bg-[var(--nr-sheet-bg,var(--nr-raised))] p-nr-5 text-nr-fg [font-family:var(--nr-sheet-font,var(--nr-font-body))]'
            : 'flex flex-col gap-nr-4 px-nr-4 py-nr-3 text-nr-fg'
        }
      >
        {props.issues?.length ? <Issues issues={props.issues} /> : null}
        {props.variants ? <Variants {...props.variants} /> : null}
        {searchable ? (
          <label className="nr-field flex items-center gap-nr-2 px-nr-2 py-nr-1">
            <Search aria-hidden="true" strokeWidth={1.75} className={`${ICON} text-nr-muted`} />
            <input data-testid="oe-search" className="min-w-0 flex-1 bg-transparent text-nr-sm text-nr-fg outline-none" placeholder={labels.search} value={query} onChange={(e) => setQuery(e.target.value)} />
            {query ? (
              <button type="button" className={BTN} onClick={() => setQuery('')} title={labels.remove}>
                <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
              </button>
            ) : null}
          </label>
        ) : null}
        {hits === 0 ? (
          <p data-testid="oe-no-matches" className="text-nr-sm text-nr-muted">
            {fmt(labels.noMatches, { query })}
          </p>
        ) : null}
        <TopLevel nodes={nodes} scope={scope} />
      </div>
    </EditorCtx.Provider>
  )
}

function Issues({ issues }: { issues: Issue[] }): ReactNode {
  const { labels } = useCtx()
  return (
    <div data-testid="oe-issues" role="alert" className="rounded-nr border border-nr-error/50 bg-nr-error/10 px-nr-3 py-nr-2 text-nr-sm text-nr-fg">
      <div className="font-medium text-nr-error">{labels.issues}</div>
      <ul className="mt-nr-1 flex flex-col gap-nr-1">
        {issues.map((i, k) => (
          <li key={k} data-testid="oe-issue" data-code={i.code} className="nr-mono text-nr-xs">
            {formatIssue(i)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Variants({ options, value, onChange }: EditorVariants): ReactNode {
  const C = useFormControls()
  return (
    <div className="flex items-center gap-nr-2">
      <C.Select testId="oe-variant" value={value ?? undefined} options={options.map((o) => ({ value: o.id, label: o.title }))} onChange={onChange} />
    </div>
  )
}

/** Строка повторителя по пути `aspects[a7f3]` (в т.ч. вложенная): её дети и область. */
function findRoot(nodes: AnyNode[], data: unknown, root: string): { nodes: AnyNode[]; scope: Scope } | undefined {
  const walk = (ns: AnyNode[], scope: Scope): { nodes: AnyNode[]; scope: Scope } | undefined => {
    for (const n of ns) {
      if (n.kind === 'repeat') {
        const r = n as RepeatNode
        const rows = get(scope.data, r.path)
        if (!Array.isArray(rows)) continue
        for (const row of rows) {
          const id = rowIdOf(row)
          const key = `${scope.prefix}${r.path}[${id}]`
          const inner: Scope = { data: row, prefix: key + '.', norm: `${scope.norm}${r.path}.` }
          if (key === root) return { nodes: r.children, scope: inner }
          if (root.startsWith(key + '.')) {
            const deep = walk(r.children, inner)
            if (deep) return deep
          }
        }
      } else {
        const deep = walk((n as { children?: AnyNode[] }).children ?? [], scope)
        if (deep) return deep
      }
    }
    return undefined
  }
  return walk(nodes, { data, prefix: '', norm: '' })
}

// ---------- раскладка ----------

/** Верхний уровень: в листе секции с `$tab` собираются во вкладки (порядок — по первому появлению). */
function TopLevel({ nodes, scope }: { nodes: AnyNode[]; scope: Scope }): ReactNode {
  const { view } = useCtx()
  const tabs = useMemo(() => {
    const order: string[] = []
    for (const n of nodes) if (n.kind === 'section' && (n as SectionNode).tab && !order.includes((n as SectionNode).tab!)) order.push((n as SectionNode).tab!)
    return order
  }, [nodes])
  const [tab, setTab] = useState<string | undefined>(undefined)
  if (view !== 'sheet' || !tabs.length) return <Children nodes={nodes} scope={scope} />
  const active = tab && tabs.includes(tab) ? tab : tabs[0]!
  const out: ReactNode[] = []
  let placed = false
  nodes.forEach((n, i) => {
    const t = n.kind === 'section' ? (n as SectionNode).tab : undefined
    if (!t) return out.push(<Node key={i} node={n} scope={scope} />)
    if (placed) return
    placed = true
    const title = (id: string): string => (nodes.find((x) => x.kind === 'section' && (x as SectionNode).tab === id) as SectionNode | undefined)?.title ?? id
    out.push(
      <div key={`tabs-${i}`} data-testid="oe-tabs" className="flex flex-col gap-nr-4">
        <div role="tablist" className="flex flex-wrap gap-nr-1 border-b border-[var(--nr-sheet-line,var(--nr-line))]">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid="oe-tab"
              data-tab={id}
              aria-selected={id === active}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-nr-3 py-nr-1 text-nr-sm ${id === active ? 'border-[var(--nr-sheet-accent,var(--nr-accent))] text-nr-fg' : 'border-transparent text-nr-muted hover:text-nr-fg'}`}
            >
              {title(id)}
            </button>
          ))}
        </div>
        {nodes.map((x, j) => (x.kind === 'section' && (x as SectionNode).tab === active ? <Node key={j} node={x} scope={scope} /> : null))}
      </div>,
    )
  })
  return <>{out}</>
}

/**
 * Дети узла: соседи с одним `$row` — одна строка (лист). В инспекторе — сетка «подпись слева» (`FieldGrid`): колонка
 * подписей по самой длинной, от шести полей чётная строка затемнена `--nr-row-alt`.
 */
function Children({ nodes, scope }: { nodes: AnyNode[]; scope: Scope }): ReactNode {
  const { view } = useCtx()
  if (view === 'inspector') {
    const rows = nodes.filter((n) => n.kind === 'field' && shown(n, scope.data)).length
    return (
      <FieldGrid rows={rows} testId="oe-rows" className="gap-y-nr-1">
        {nodes.map((n, i) => (
          <Node key={i} node={n} scope={scope} />
        ))}
      </FieldGrid>
    )
  }
  const out: ReactNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const row = (n as { row?: string }).row
    if (view === 'sheet' && row) {
      const group: AnyNode[] = [n]
      while (i + 1 < nodes.length && (nodes[i + 1] as { row?: string }).row === row) group.push(nodes[++i]!)
      if (group.length > 1) {
        out.push(
          <div key={`row-${i}`} data-testid="oe-row-layout" data-row={row} className="grid items-start gap-nr-4" style={{ gridTemplateColumns: `repeat(${group.length}, minmax(0, 1fr))` }}>
            {group.map((g, j) => (
              <Node key={j} node={g} scope={scope} />
            ))}
          </div>,
        )
        continue
      }
    }
    // Лист: серия коротких полей без `$row` (навыки лестницей) — сеткой в две колонки.
    if (view === 'sheet' && isShort(n)) {
      const run: AnyNode[] = [n]
      while (i + 1 < nodes.length && isShort(nodes[i + 1]!)) run.push(nodes[++i]!)
      if (run.length >= 3) {
        out.push(
          <div key={`grid-${i}`} data-testid="oe-grid" className="grid grid-cols-1 gap-x-nr-6 gap-y-nr-2 sm:grid-cols-2">
            {run.map((g, j) => (
              <Node key={j} node={g} scope={scope} />
            ))}
          </div>,
        )
        continue
      }
      run.forEach((g, j) => out.push(<Node key={`${i}-${j}`} node={g} scope={scope} />))
      continue
    }
    out.push(<Node key={i} node={n} scope={scope} />)
  }
  return <>{out}</>
}

const isShort = (n: AnyNode): boolean => n.kind === 'field' && !(n as FieldNode).row && SHORT_WIDGETS.has((n as FieldNode).widget ?? '')

function Node({ node, scope }: { node: AnyNode; scope: Scope }): ReactNode {
  const ctx = useCtx()
  if (!shown(node, scope.data)) return null
  if (ctx.query && !matches(node, ctx.query)) return null
  switch (node.kind) {
    case 'section':
      return <Section node={node as SectionNode} scope={scope} />
    case 'field':
      return <Field node={node as FieldNode} scope={scope} />
    case 'repeat':
      return <Repeat node={node as RepeatNode} scope={scope} />
    case 'group':
      return <Group node={node as GroupNode} scope={scope} />
    case 'computed':
      return <Computed node={node as ComputedNode} scope={scope} />
    case 'text':
      return <p className="text-nr-sm leading-nr-body text-nr-muted">{(node as { text: string }).text}</p>
    default:
      return <Children nodes={(node as { children?: AnyNode[] }).children ?? []} scope={scope} />
  }
}

/** Сводка свёрнутой секции: первые непустые значения. */
function summaryOf(nodes: AnyNode[], scope: Scope, doc: ObjectDocument, out: string[] = []): string[] {
  for (const n of nodes) {
    if (out.length >= 4) break
    if (!shown(n, scope.data)) continue
    if (n.kind === 'field') {
      const f = n as FieldNode
      const v = get(scope.data, f.path)
      if (empty(v) || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'boolean'))) continue
      if (typeof v === 'string') out.push(v.startsWith('data:') ? '🖼' : v.length > 28 ? v.slice(0, 27) + '…' : v)
      else if (typeof v === 'number') out.push(`${f.label ?? f.path} ${v}`)
      else if (Array.isArray(v)) out.push(`${f.label ?? f.path}: ${v.length}`)
    } else if (n.kind === 'repeat') {
      const r = n as RepeatNode
      const rows = get(scope.data, r.path)
      if (Array.isArray(rows) && rows.length) out.push(`${r.label ?? r.path}: ${rows.length}`)
    } else if (n.kind === 'computed') {
      const c = n as ComputedNode
      const v = doc.calc(c.id)
      if (v !== undefined) out.push(`${c.label ?? c.id} ${String(v)}`)
    } else summaryOf((n as { children?: AnyNode[] }).children ?? [], scope, doc, out)
  }
  return out
}

function Section({ node, scope }: { node: SectionNode; scope: Scope }): ReactNode {
  const ctx = useCtx()
  const first = ctx.def.nodes.find((n) => n.kind === 'section') === node
  const [open, setOpen] = useState(ctx.view === 'sheet' ? true : node.collapsed === true ? false : first)
  const forced = !!ctx.query
  const isOpen = forced || open
  const sheet = ctx.view === 'sheet'
  const summary = !isOpen ? summaryOf(node.children, scope, ctx.doc).join(' · ') : ''
  return (
    <section data-testid="oe-section" data-section={node.id} data-collapsed={String(!isOpen)} className={sheet ? 'flex flex-col gap-nr-4' : 'flex flex-col gap-nr-3'}>
      {node.title !== undefined || !sheet ? (
        <header className={`flex min-w-0 items-center gap-nr-3 ${sheet ? 'border-b border-[var(--nr-sheet-line,var(--nr-line-soft))] pb-nr-1' : ''}`}>
          {sheet ? (
            <h3 data-testid="oe-section-title" className="text-nr-lg font-semibold text-[var(--nr-sheet-accent,var(--nr-fg))]">
              {node.title ?? node.id}
            </h3>
          ) : (
            <button type="button" data-testid="oe-section-toggle" aria-expanded={isOpen} onClick={() => setOpen(!open)} className="-ml-nr-1 flex shrink-0 items-center gap-nr-1 text-nr-sm font-semibold text-nr-fg">
              {isOpen ? <ChevronDown aria-hidden="true" strokeWidth={1.75} className={ICON} /> : <ChevronRight aria-hidden="true" strokeWidth={1.75} className={ICON} />}
              <span data-testid="oe-section-title">{node.title ?? node.id}</span>
            </button>
          )}
          {summary ? (
            <button type="button" data-testid="oe-section-summary" title={summary} onClick={() => setOpen(true)} className="min-w-0 truncate text-left text-nr-sm text-nr-muted hover:text-nr-fg">
              {summary}
            </button>
          ) : null}
        </header>
      ) : null}
      {isOpen ? <Children nodes={node.children} scope={scope} /> : null}
    </section>
  )
}

function Group({ node, scope }: { node: GroupNode; scope: Scope }): ReactNode {
  return (
    <div data-testid="oe-group" data-path={scope.prefix + node.path} className="flex flex-col gap-nr-3">
      {node.label ? <div className="text-nr-sm font-medium text-nr-muted">{node.label}</div> : null}
      <Children nodes={node.children} scope={scope} />
    </div>
  )
}

function Computed({ node, scope }: { node: ComputedNode; scope: Scope }): ReactNode {
  const { doc, labels } = useCtx()
  const row = scope.prefix ? scope.prefix.slice(0, -1) : undefined
  const v = doc.calc(node.id, row)
  const err = doc.errors.find((e) => e.code === 'E_EXPR' && e.where === (row ? `${row}.${node.id}` : node.id))
  return (
    <div data-testid="oe-computed" data-id={node.id} className="flex items-baseline gap-nr-2 text-nr-sm">
      <span className="text-nr-fg">{node.label ?? node.id}</span>
      <span data-testid="oe-computed-value" className="tabular-nums font-medium text-nr-fg">
        {v === undefined ? '—' : String(v)}
      </span>
      <span className="text-nr-xs text-nr-muted">{labels.computed}</span>
      {err ? <span className="text-nr-xs text-nr-error">{err.message}</span> : null}
    </div>
  )
}

// ---------- поле ----------

const frameCache = new WeakMap<WidgetDef, WidgetComponent>()

function resolveWidget(ctx: Ctx, node: FieldNode, info: FieldInfo): { id: string; Component: WidgetComponent } {
  const { catalog, widgets } = ctx
  const usable = (id: string): WidgetComponent | undefined => {
    if (widgets[id]) return widgets[id]
    const w = catalog?.get(id)
    if (w && catalog && catalog.accepts(w, info)) return undefined // не по типу: check сообщает, поле живо виджетом по типу
    if (w?.component) return w.component as WidgetComponent
    if (w?.frame) {
      let c = frameCache.get(w)
      if (!c) frameCache.set(w, (c = frameWidget(w.frame as { src?: string; srcdoc?: string })))
      return c
    }
    return WIDGET_COMPONENTS[id]
  }
  if (node.widget) {
    const c = usable(node.widget)
    if (c) return { id: node.widget, Component: c }
  }
  const picked = catalog?.pick(info)?.id
  if (picked) {
    const c = usable(picked)
    if (c) return { id: picked, Component: c }
  }
  const id = fallbackWidget(info.type, !!info.enum?.length)
  return { id, Component: usable(id) ?? WIDGET_COMPONENTS[id]! }
}

function Field({ node, scope }: { node: FieldNode; scope: Scope }): ReactNode {
  const ctx = useCtx()
  const { doc, labels } = ctx
  const path = scope.prefix + node.path
  const schema = schemaAtPath(doc.schema, scope.norm + node.path)
  const type = node.type ?? typeOfSchema(schema) ?? 'string'
  const value = get(scope.data, node.path)
  const en = node.enum ?? (schema?.enum as unknown[] | undefined)
  const info: FieldInfo = { type, path: scope.norm + node.path, schema: schema ?? {}, ...(en ? { enum: en } : {}), ...(schema?.format ? { format: schema.format } : {}) }
  const { id, Component } = resolveWidget(ctx, node, info)
  const row = scope.prefix ? scope.prefix.slice(0, -1) : undefined
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.props ?? {})) {
    if (typeof v === 'string' && v.startsWith('=')) {
      const cid = v.slice(1)
      props[k] = doc.calc(cid, row) ?? doc.calc(cid)
    } else props[k] = v
  }
  const exclude = id === 'json' ? ctx.fieldPaths.filter((p) => p.startsWith(node.path + '.')).map((p) => p.slice(node.path.length + 1)) : undefined
  const fieldNode = en && !node.enum ? { ...node, enum: en } : node
  const onChange = (v: unknown): void => {
    if (v === undefined) doc.exec('object.unset', { path })
    else doc.exec('object.set', { path, value: v })
  }
  const errors = doc.errors.filter((e) => e.where === path)
  const origin = ctx.origins[path]
  const inspector = ctx.view === 'inspector'
  const short = inspector ? INLINE_WIDGETS.has(id) || ctx.catalog?.get(id)?.inline === true : SHORT_WIDGETS.has(id) && !node.row
  const title = node.label ?? node.id ?? node.path
  const menu = ctx.fieldMenu
  const gens = ctx.readOnly ? [] : (node.generators ?? []).filter((g) => ctx.generators[g])
  const [cand, setCand] = useState<{ gen: string; value?: unknown; error?: string; busy?: boolean } | null>(null)
  const runGen = (g: string): void => {
    setCand({ gen: g, busy: true })
    const ref: EditorFieldRef = { path, label: node.label ?? node.id ?? node.path, type, value, readOnly: false, set: onChange }
    ctx.generators[g]!.run(ref, { ...(scope.prefix ? { row: scope.data } : {}), object: doc.object }).then(
      (v) => setCand({ gen: g, value: v }),
      (e: unknown) => setCand({ gen: g, error: e instanceof Error ? e.message : String(e) }),
    )
  }
  const openMenu = (at: { x: number; y: number }): void =>
    menu?.({ path, label: title, type, value, readOnly: ctx.readOnly, ...(ctx.readOnly ? {} : { set: onChange }) }, at)
  const label = (
    <div className="group/oe-label flex min-w-0 items-baseline gap-nr-1">
      <span data-testid="oe-label" className={`min-w-0 text-nr-sm leading-nr-ui ${short && inspector ? 'text-nr-muted' : 'text-nr-fg'}`} title={node.description}>
        {title}
      </span>
      {node.required ? <span className="text-nr-error">*</span> : null}
      {origin ? <Origin origin={origin} value={value} path={path} /> : null}
      {gens.map((g) => (
        <button key={g} type="button" data-testid="oe-generator" data-generator={g} disabled={cand?.busy} className={`${BTN} ${menu ? '' : 'ml-auto'}`} onClick={() => runGen(g)}>
          ✨ {ctx.generators[g]!.title}
        </button>
      ))}
      {menu ? (
        <button
          type="button"
          data-testid="oe-field-menu"
          title={labels.fieldMenu}
          aria-label={labels.fieldMenu}
          className={`${BTN} ml-auto opacity-0 focus:opacity-100 group-hover/oe-label:opacity-100 [@media(pointer:coarse)]:opacity-100`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            openMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <Ellipsis aria-hidden="true" strokeWidth={1.75} className={ICON} />
        </button>
      ) : null}
    </div>
  )
  const widget = (
    <Component value={value} onChange={onChange} props={props} path={path} readOnly={ctx.readOnly} host={ctx.host} labels={labels} field={fieldNode} type={type} {...(exclude ? { exclude } : {})} read={(p) => get(doc.object, p)} />
  )
  return (
    <div
      data-testid="oe-field"
      data-path={path}
      data-widget={id}
      data-invalid={errors.length ? 'true' : undefined}
      {...(menu
        ? {
            onContextMenu: (e: ReactMouseEvent) => {
              // Своё меню виджета (ссылки, вложенный редактор) — не перехватывать.
              if (e.defaultPrevented) return
              e.preventDefault()
              e.stopPropagation()
              openMenu({ x: e.clientX, y: e.clientY })
            },
          }
        : {})}
      data-row={inspector ? (short ? 'inline' : 'stack') : undefined}
      className={
        inspector
          ? short
            ? 'grid min-w-0 grid-cols-subgrid items-center gap-y-nr-1 rounded-nr px-nr-2 py-nr-1'
            : 'flex min-w-0 flex-col gap-nr-1 rounded-nr px-nr-2 py-nr-2'
          : short
            ? 'grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] items-center gap-nr-3'
            : 'flex flex-col gap-nr-1'
      }>
      {label}
      <div className={short && inspector ? 'flex min-h-nr-hit min-w-0 items-center' : 'min-w-0'}>{widget}</div>
      {cand ? (
        <div data-testid="oe-candidate" data-generator={cand.gen} data-busy={cand.busy ? 'true' : undefined} className={`flex flex-col gap-nr-1 rounded-nr border border-nr-line p-nr-2 ${short ? 'col-span-2' : ''}`}>
          {cand.busy ? <span className="text-nr-xs text-nr-muted">…</span> : null}
          {cand.error ? <span data-testid="oe-candidate-error" className="text-nr-xs text-nr-error">{fmt(labels.candidateError, { error: cand.error })}</span> : null}
          {cand.value !== undefined ? <div data-testid="oe-candidate-value" className="whitespace-pre-wrap text-nr-sm text-nr-fg">{typeof cand.value === 'string' ? cand.value : JSON.stringify(cand.value, null, 2)}</div> : null}
          {!cand.busy ? (
            <div className="flex gap-nr-1">
              {cand.value !== undefined ? (
                <button type="button" data-testid="oe-candidate-accept" className={BTN} onClick={() => (onChange(cand.value), setCand(null))}>
                  {labels.candidateAccept}
                </button>
              ) : null}
              <button type="button" data-testid="oe-candidate-reject" className={BTN} onClick={() => setCand(null)}>
                {labels.candidateReject}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {errors.map((e, i) => (
        <span key={i} data-testid="oe-field-error" data-code={e.code} className={`text-nr-xs text-nr-error ${short ? 'col-span-2' : ''}`}>
          {e.message}
        </span>
      ))}
    </div>
  )
}

function Origin({ origin, value, path }: { origin: FieldOrigin; value: unknown; path: string }): ReactNode {
  const { doc, labels, readOnly } = useCtx()
  const changed = origin.base !== undefined && !same(origin.base, value)
  return (
    <span className="flex shrink-0 items-center gap-nr-1">
      <span data-testid="oe-origin" className={`rounded-nr px-nr-1 text-nr-xs ${changed ? 'text-nr-accent' : 'text-nr-muted'}`}>
        {origin.label}
      </span>
      {changed && !readOnly ? (
        <button type="button" data-testid="oe-revert" title={labels.revert} className={BTN} onClick={() => (origin.onRevert ? origin.onRevert() : doc.exec('object.set', { path, value: origin.base }))}>
          <RotateCcw aria-hidden="true" strokeWidth={1.75} className={ICON} />
        </button>
      ) : null}
    </span>
  )
}

// ---------- повторитель ----------

function Repeat({ node, scope }: { node: RepeatNode; scope: Scope }): ReactNode {
  const ctx = useCtx()
  const { doc, labels, readOnly } = ctx
  const path = scope.prefix + node.path
  const raw = get(scope.data, node.path)
  const rows = Array.isArray(raw) ? raw : []
  const drag = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const move = (id: string, target: string): void => {
    const from = rows.findIndex((r) => rowIdOf(r) === id)
    const to = rows.findIndex((r) => rowIdOf(r) === target)
    if (from < 0 || to < 0 || from === to) return
    // Вниз — встать после цели, вверх — перед ней.
    const before = from < to ? rowIdOf(rows[to + 1]) : target
    doc.exec('object.move', before ? { path, id, before } : { path, id })
  }
  const title = (row: unknown, i: number): string => {
    const v = node.itemTitle ? get(row, node.itemTitle) : undefined
    return typeof v === 'string' && v ? v : fmt(labels.item, { n: i + 1 })
  }
  const add = (): void => {
    const r = doc.exec('object.insert', { path })
    if (!r.ok) return
  }
  return (
    <div data-testid="oe-repeat" data-path={path} className="flex flex-col gap-nr-2">
      <div className="flex items-center gap-nr-2">
        <span className="text-nr-sm font-medium text-nr-fg">{node.label ?? node.path}</span>
        <span data-testid="oe-repeat-count" className="text-nr-xs tabular-nums text-nr-muted">
          {rows.length}
        </span>
        {readOnly ? null : (
          <button type="button" data-testid="oe-repeat-add" onClick={add} className={`${BTN} nr-ctl ml-auto`}>
            <Plus aria-hidden="true" strokeWidth={1.75} className={ICON} />
            {labels.add}
          </button>
        )}
      </div>
      {rows.length === 0 ? <p className="text-nr-xs text-nr-muted">{labels.emptyList}</p> : null}
      {rows.map((row, i) => {
        const id = rowIdOf(row) ?? String(i)
        const inner: Scope = { data: row, prefix: `${path}[${id}].`, norm: `${scope.norm}${node.path}.` }
        return (
          <div
            key={id}
            data-testid="oe-row"
            data-id={id}
            data-over={over === id ? 'true' : undefined}
            onDragOver={(e) => {
              if (!drag.current) return
              e.preventDefault()
              setOver(id)
            }}
            onDragLeave={() => setOver((o) => (o === id ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              const src = drag.current ?? e.dataTransfer.getData('text/x-oe-row')
              drag.current = null
              setOver(null)
              if (src) move(src, id)
            }}
            className={`flex flex-col gap-nr-2 rounded-nr border px-nr-3 py-nr-2 ${over === id ? 'border-nr-accent' : 'border-nr-line-soft'} ${ctx.view === 'sheet' ? 'bg-transparent' : 'bg-nr-surface/40'}`}
          >
            <div className="flex min-w-0 items-center gap-nr-1">
              {readOnly ? null : (
                <span
                  data-testid="oe-row-handle"
                  draggable
                  title={labels.drag}
                  onDragStart={(e) => {
                    drag.current = id
                    e.dataTransfer.setData('text/x-oe-row', id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    drag.current = null
                    setOver(null)
                  }}
                  className="cursor-grab text-nr-muted hover:text-nr-fg"
                >
                  <GripVertical aria-hidden="true" strokeWidth={1.75} className={ICON} />
                </span>
              )}
              <span data-testid="oe-row-title" className="min-w-0 flex-1 truncate text-nr-xs text-nr-muted">
                {title(row, i)}
              </span>
              {readOnly ? null : (
                <>
                  <button type="button" data-testid="oe-row-up" title={labels.moveUp} disabled={i === 0} className={BTN} onClick={() => doc.exec('object.move', { path, id, before: rowIdOf(rows[i - 1]) })}>
                    <ArrowUp aria-hidden="true" strokeWidth={1.75} className={ICON} />
                  </button>
                  <button
                    type="button"
                    data-testid="oe-row-down"
                    title={labels.moveDown}
                    disabled={i === rows.length - 1}
                    className={BTN}
                    onClick={() => {
                      const after = rowIdOf(rows[i + 2])
                      doc.exec('object.move', after ? { path, id, before: after } : { path, id })
                    }}
                  >
                    <ArrowDown aria-hidden="true" strokeWidth={1.75} className={ICON} />
                  </button>
                  <button type="button" data-testid="oe-row-remove" title={labels.remove} className={BTN} onClick={() => doc.exec('object.remove', { path, id })}>
                    <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
                  </button>
                </>
              )}
            </div>
            <Children nodes={node.children as EditorNode[]} scope={inner} />
          </div>
        )
      })}
    </div>
  )
}
