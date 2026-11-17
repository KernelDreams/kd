// Виджеты каталога (spec §4) для <ObjectEditor>: базовые, Fate, CCv3. Контракт один —
// `WidgetProps`; свой виджет кодом (плагин nrchat, потребитель пакета) — тот же компонент.
// Цвета — только токены `--nr-*`.

import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { FieldNode } from '../editor/types.js'
import { fmt, type EditorLabels } from './labels.js'
import { useFormControls } from '../controls.js'

export interface WidgetProps {
  value: unknown
  /** Новое значение; `undefined` — убрать поле. */
  onChange(value: unknown): void
  /** props описания; `"=<id>"` уже заменены значениями вычислений. */
  props: Record<string, unknown>
  /** Путь команды: `aspects[a7f3].text`. */
  path: string
  readOnly: boolean
  host: unknown
  labels: EditorLabels
  /** Узел поля описания (тип, enum, min/max). */
  field: FieldNode
  /** Тип поля (из описания или схемы). */
  type: string
  /** Вложенные пути, описанные отдельными полями (виджет `json` их не показывает), — от поля. */
  exclude?: string[]
  /** Прочитать значение по пути от корня (`fate.fate-points` → `refreshFrom`). */
  read(path: string): unknown
}

export type WidgetComponent = ComponentType<WidgetProps>

// Форма поля и кнопки — роли хозяина (`nr-field`, `nr-ctl`: рамка, радиус, тень, заливка из токенов скина), не свои border / rounded.
export const INPUT = 'nr-field w-full min-w-0 px-nr-2 py-nr-1 text-nr-sm text-nr-fg outline-none placeholder:text-nr-muted/70 focus:border-nr-accent disabled:opacity-60'
const ICON = 'size-nr-icon-sm shrink-0'
const CHIP = 'nr-ctl flex max-w-full items-center gap-nr-1 px-nr-2 py-0.5 text-nr-xs text-nr-fg'
const BTN = 'nr-ctl inline-flex items-center gap-nr-1 px-nr-2 py-0.5 text-nr-xs text-nr-muted hover:text-nr-fg disabled:opacity-50'

const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v))
const tid = (path: string): string => path

/** Строка, которая правится локально и уходит командой по blur/Enter — одна запись истории на правку. */
function useDraft(value: string, commit: (v: string) => void): [string, (v: string) => void, () => void] {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setDraft(value)
  }, [value])
  return [
    draft,
    (v) => {
      dirty.current = true
      setDraft(v)
    },
    () => {
      if (!dirty.current) return
      dirty.current = false
      if (draft !== value) commit(draft)
    },
  ]
}

/** Пустое поле показывает умолчание серым (правило 5 пульта): `placeholder` описания, иначе `$default`. */
const hintOf = (props: Record<string, unknown>, field: FieldNode): string | undefined => str(props.placeholder) || str(field.default) || undefined

function Text({ value, onChange, props, readOnly, path, field }: WidgetProps): ReactNode {
  const C = useFormControls()
  const [draft, set, flush] = useDraft(str(value), (v) => onChange(v))
  const hint = hintOf(props, field)
  return (
    <C.Text
      testId="oe-input"
      attrs={{ 'data-path': tid(path) }}
      value={draft}
      disabled={readOnly}
      {...(hint ? { placeholder: hint } : {})}
      onChange={set}
      onBlur={flush}
      onKeyDown={(e) => e.key === 'Enter' && flush()}
    />
  )
}

function Textarea({ value, onChange, props, readOnly, path, field }: WidgetProps): ReactNode {
  const C = useFormControls()
  const [draft, set, flush] = useDraft(str(value), (v) => onChange(v))
  const hint = hintOf(props, field)
  return (
    <C.Textarea
      testId="oe-input"
      attrs={{ 'data-path': tid(path) }}
      rows={typeof props.rows === 'number' ? props.rows : 3}
      value={draft}
      disabled={readOnly}
      {...(hint ? { placeholder: hint } : {})}
      onChange={set}
      onBlur={flush}
    />
  )
}

function Markdown(p: WidgetProps): ReactNode {
  const [preview, setPreview] = useState(false)
  return (
    <div className="flex flex-col gap-nr-1">
      <div className="flex justify-end">
        <button type="button" className={BTN} onClick={() => setPreview(!preview)}>
          {preview ? p.labels.edit : p.labels.preview}
        </button>
      </div>
      {preview ? (
        <div data-testid="oe-markdown-preview" className="whitespace-pre-wrap rounded-nr border border-nr-line-soft px-nr-2 py-nr-1 text-nr-sm leading-nr-body text-nr-fg">
          {str(p.value)}
        </div>
      ) : (
        <Textarea {...p} props={{ rows: 6, ...p.props }} />
      )}
    </div>
  )
}

const bound = (p: WidgetProps, k: 'min' | 'max'): number | undefined => {
  const v = p.props[k] ?? p.field[k]
  return typeof v === 'number' ? v : undefined
}

function NumberInput(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const min = bound(p, 'min')
  const max = bound(p, 'max')
  // Ввод — в черновике контрола, командой — по blur / Enter / шагу: одна запись истории на правку.
  return (
    <C.Number
      testId="oe-input"
      attrs={{ 'data-path': tid(p.path) }}
      value={typeof p.value === 'number' ? p.value : undefined}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(typeof p.props.step === 'number' ? { step: p.props.step } : {})}
      {...(p.type === 'integer' ? { integer: true } : {})}
      {...(typeof p.props.unit === 'string' ? { unit: p.props.unit } : {})}
      disabled={p.readOnly}
      onChange={() => {}}
      onCommit={(n) => {
        if (n === undefined ? p.value !== undefined : n !== p.value) p.onChange(n)
      }}
    />
  )
}

function Slider(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const min = bound(p, 'min') ?? 0
  const max = bound(p, 'max') ?? 100
  const v = typeof p.value === 'number' ? p.value : min
  return (
    <C.Slider
      testId="oe-input"
      attrs={{ 'data-path': p.path }}
      label={str(p.field.label) || p.path}
      min={min}
      max={max}
      {...(typeof p.props.step === 'number' ? { step: p.props.step } : {})}
      value={v}
      disabled={p.readOnly}
      onChange={(n) => p.onChange(n)}
    />
  )
}

function Checkbox({ value, onChange, readOnly, path, props }: WidgetProps): ReactNode {
  const C = useFormControls()
  return <C.Checkbox testId="oe-input" attrs={{ 'data-path': path }} {...(props.switch === true ? { kind: 'switch' as const } : {})} checked={value === true} disabled={readOnly} onChange={(v) => onChange(v)} />
}

const optionsOf = (p: WidgetProps): unknown[] => (Array.isArray(p.field.enum) ? p.field.enum : [])
const optionLabel = (p: WidgetProps, v: unknown): string => {
  const l = p.props.labels as Record<string, unknown> | undefined
  return str(l?.[str(v)] ?? v)
}

function Select(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const opts = optionsOf(p)
  const idx = opts.findIndex((o) => o === p.value)
  const hint = hintOf(p.props, p.field)
  // Значения enum бывают не строками: в контроле — индекс.
  return (
    <C.Select
      testId="oe-input"
      attrs={{ 'data-path': p.path }}
      value={idx < 0 ? undefined : String(idx)}
      placeholder={hint ?? '—'}
      options={opts.map((o, i) => ({ value: String(i), label: optionLabel(p, o) }))}
      disabled={p.readOnly}
      onChange={(v) => p.onChange(opts[Number(v)])}
    />
  )
}

function Radio(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const opts = optionsOf(p)
  const idx = opts.findIndex((o) => o === p.value)
  return (
    <C.Choice
      testId="oe-input"
      attrs={{ 'data-path': p.path }}
      label={str(p.field.label) || p.path}
      value={idx < 0 ? undefined : String(idx)}
      options={opts.map((o, i) => ({ value: String(i), label: optionLabel(p, o) }))}
      disabled={p.readOnly}
      onChange={(v) => p.onChange(opts[Number(v)])}
    />
  )
}

function Chips(p: WidgetProps): ReactNode {
  return (
    <div data-testid="oe-input" data-path={p.path} className="flex flex-wrap gap-nr-1">
      {optionsOf(p).map((o, i) => (
        <button
          key={i}
          type="button"
          aria-pressed={p.value === o}
          disabled={p.readOnly}
          onClick={() => p.onChange(o)}
          className={`${CHIP} ${p.value === o ? 'border-nr-accent bg-nr-accent text-nr-accent-fg' : 'hover:border-nr-accent/50'}`}
        >
          {optionLabel(p, o)}
        </button>
      ))}
    </div>
  )
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : [])

function Tags(p: WidgetProps): ReactNode {
  const items = strings(p.value)
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    if (!items.includes(v)) p.onChange([...items, v])
  }
  return (
    <div data-testid="oe-tags" data-path={p.path} className="flex flex-wrap items-center gap-nr-1">
      {items.map((t, i) => (
        <span key={`${i}:${t}`} data-testid="oe-tag" className={CHIP}>
          <span className="min-w-0 truncate">{t}</span>
          {p.readOnly ? null : (
            <button type="button" title={p.labels.remove} onClick={() => p.onChange(items.filter((_, j) => j !== i))} className="shrink-0 text-nr-muted hover:text-nr-fg">
              <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
            </button>
          )}
        </span>
      ))}
      {p.readOnly ? null : (
        <input
          data-testid="oe-tag-input"
          className={`${INPUT} w-32 flex-none`}
          value={draft}
          placeholder={p.labels.addTag}
          aria-label={p.labels.addTag}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
          }}
        />
      )}
    </div>
  )
}

function ListItem({ value, onCommit, rows, readOnly }: { value: string; onCommit(v: string): void; rows: number; readOnly: boolean }): ReactNode {
  const [draft, set, flush] = useDraft(value, onCommit)
  return <textarea data-testid="oe-list-item" className={`${INPUT} resize-y`} rows={rows} value={draft} disabled={readOnly} onChange={(e) => set(e.target.value)} onBlur={flush} />
}

function StringList(p: WidgetProps & { rows?: number; numbered?: boolean }): ReactNode {
  const items = strings(p.value)
  return (
    <div data-testid="oe-list" data-path={p.path} className="flex flex-col gap-nr-2">
      {items.map((t, i) => (
        <div key={i} className="flex items-start gap-nr-2">
          <span className="w-6 shrink-0 pt-nr-1 text-right text-nr-xs text-nr-muted">{i + 1}</span>
          <ListItem value={t} rows={p.rows ?? 2} readOnly={p.readOnly} onCommit={(v) => p.onChange(items.map((x, j) => (j === i ? v : x)))} />
          {p.readOnly ? null : (
            <button type="button" title={p.labels.remove} onClick={() => p.onChange(items.filter((_, j) => j !== i))} className="pt-nr-1 text-nr-muted hover:text-nr-fg">
              <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
            </button>
          )}
        </div>
      ))}
      {p.readOnly ? null : (
        <div>
          <button type="button" data-testid="oe-list-add" className={BTN} onClick={() => p.onChange([...items, ''])}>
            <Plus aria-hidden="true" strokeWidth={1.75} className={ICON} />
            {p.labels.add}
          </button>
        </div>
      )}
    </div>
  )
}

function ImageWidget(p: WidgetProps): ReactNode {
  const url = str(p.value)
  const aspect = str(p.props.aspect)
  const [w, h] = /^\d+:\d+$/.test(aspect) ? aspect.split(':').map(Number) : [1, 1]
  const file = useRef<HTMLInputElement>(null)
  const [draft, set, flush] = useDraft(url, (v) => p.onChange(v || undefined))
  return (
    <div data-testid="oe-image" data-path={p.path} className="flex items-start gap-nr-3">
      <div className="w-24 shrink-0 overflow-hidden rounded-nr border border-nr-line bg-nr-surface" style={{ aspectRatio: `${w} / ${h}` }}>
        {url ? <img data-testid="oe-image-preview" src={url} alt="" className="size-full object-cover" /> : null}
      </div>
      {p.readOnly ? null : (
        <div className="flex min-w-0 flex-1 flex-col gap-nr-1">
          <input className={INPUT} placeholder={p.labels.imageUrl} value={draft.startsWith('data:') ? '' : draft} onChange={(e) => set(e.target.value)} onBlur={flush} />
          <div>
            <button type="button" className={BTN} onClick={() => file.current?.click()}>
              {p.labels.upload}
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const r = new FileReader()
                r.onload = () => p.onChange(String(r.result))
                r.readAsDataURL(f)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function DateInput(p: WidgetProps): ReactNode {
  return <input type="date" data-testid="oe-input" data-path={p.path} className={`${INPUT} w-auto`} value={str(p.value)} disabled={p.readOnly} onChange={(e) => p.onChange(e.target.value || undefined)} />
}

function ColorInput(p: WidgetProps): ReactNode {
  return <input type="color" data-testid="oe-input" data-path={p.path} className="h-7 w-12 rounded-nr border border-nr-line bg-nr-bg" value={str(p.value) || '#000000'} disabled={p.readOnly} onChange={(e) => p.onChange(e.target.value)} />
}

/** Ссылка на объект: хозяин может дать список (`host.refs(type) → [{id, title}]`). */
function Ref(p: WidgetProps): ReactNode {
  const refs = (p.host as { refs?(type: string): { id: string; title?: string }[] } | undefined)?.refs?.(str(p.props.type))
  const list = `oe-ref-${p.path.replace(/[^\w-]/g, '_')}`
  const [draft, set, flush] = useDraft(str(p.value), (v) => p.onChange(v || undefined))
  return (
    <>
      <input data-testid="oe-input" data-path={p.path} list={refs ? list : undefined} className={INPUT} value={draft} placeholder={str(p.props.type) || undefined} disabled={p.readOnly} onChange={(e) => set(e.target.value)} onBlur={flush} />
      {refs ? (
        <datalist id={list}>
          {refs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title ?? r.id}
            </option>
          ))}
        </datalist>
      ) : null}
    </>
  )
}

/** Убрать вложенные пути (описаны отдельными полями) из объекта. */
function omit(v: unknown, paths: string[]): unknown {
  if (!paths.length || !v || typeof v !== 'object' || Array.isArray(v)) return v
  const out: Record<string, unknown> = { ...(v as Record<string, unknown>) }
  for (const p of paths) {
    const [head, ...rest] = p.split('.')
    if (!head || !(head in out)) continue
    if (!rest.length) delete out[head]
    else {
      const inner = omit(out[head], [rest.join('.')])
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && !Object.keys(inner).length) delete out[head]
      else out[head] = inner
    }
  }
  return out
}

/** Вернуть вложенные пути из исходного в правку `json`-виджета. */
function keep(next: unknown, prev: unknown, paths: string[]): unknown {
  if (!paths.length || !next || typeof next !== 'object' || Array.isArray(next)) return next
  const out = { ...(next as Record<string, unknown>) }
  for (const p of paths) {
    const parts = p.split('.')
    let src = prev as Record<string, unknown> | undefined
    for (const k of parts) src = src && typeof src === 'object' ? (src[k] as Record<string, unknown> | undefined) : undefined
    if (src === undefined) continue
    let dst = out
    parts.slice(0, -1).forEach((k) => {
      dst[k] = dst[k] && typeof dst[k] === 'object' ? { ...(dst[k] as object) } : {}
      dst = dst[k] as Record<string, unknown>
    })
    dst[parts.at(-1)!] = src
  }
  return out
}

function Json(p: WidgetProps): ReactNode {
  const shownValue = omit(p.value, p.exclude ?? [])
  const text = shownValue === undefined ? '' : JSON.stringify(shownValue, null, 2)
  const [error, setError] = useState('')
  const [draft, set, flush] = useDraft(text, (v) => {
    if (!v.trim()) {
      setError('')
      return p.onChange(keep(undefined, p.value, p.exclude ?? []))
    }
    try {
      const parsed = JSON.parse(v)
      setError('')
      p.onChange(keep(parsed, p.value, p.exclude ?? []))
    } catch (e) {
      setError(fmt(p.labels.jsonInvalid, { error: (e as Error).message }))
    }
  })
  return (
    <div className="flex flex-col gap-nr-1">
      <textarea data-testid="oe-input" data-path={p.path} className={`${INPUT} nr-mono resize-y text-nr-xs`} rows={Math.min(12, Math.max(3, draft.split('\n').length))} value={draft} disabled={p.readOnly} onChange={(e) => set(e.target.value)} onBlur={flush} />
      {error ? <span className="text-nr-xs text-nr-error">{error}</span> : null}
    </div>
  )
}

function Booleans(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const v = Array.isArray(p.value) ? p.value : []
  return (
    <div data-testid="oe-input" data-path={p.path} className="flex flex-wrap gap-nr-1">
      {v.map((b, i) => (
        <C.Checkbox key={i} checked={b === true} disabled={p.readOnly} label={`${i + 1}`} onChange={(c) => p.onChange(v.map((x, j) => (j === i ? c : x)))} />
      ))}
    </div>
  )
}

// ---------- Fate ----------

function Ladder(p: WidgetProps): ReactNode {
  const C = useFormControls()
  const v = typeof p.value === 'number' ? p.value : 0
  const min = bound(p, 'min') ?? -2
  const max = bound(p, 'max') ?? 8
  const steps: number[] = []
  for (let i = min; i <= max; i++) steps.push(i)
  const name = (n: number): string => p.labels.ladder[n + 2] ?? ''
  return (
    <C.Select
      testId="fate-ladder"
      attrs={{ 'data-path': p.path }}
      value={String(v)}
      disabled={p.readOnly}
      options={steps.map((n) => ({ value: String(n), label: `${n > 0 ? '+' : ''}${n} ${name(n)}` }))}
      onChange={(x) => p.onChange(Number(x))}
    />
  )
}

function Aspect(p: WidgetProps): ReactNode {
  const kind = str(p.props.kind) || 'other'
  return (
    <div className="flex items-center gap-nr-2">
      <span data-testid="fate-aspect-kind" className="shrink-0 rounded-nr bg-nr-surface px-nr-2 py-0.5 text-nr-xs uppercase tracking-wide text-nr-muted">
        {p.labels.aspectKinds[kind] ?? kind}
      </span>
      <Text {...p} />
    </div>
  )
}

function StressTrack(p: WidgetProps): ReactNode {
  const n = Math.max(0, Math.min(20, Math.round(Number(p.props.boxes) || 0)))
  const cur = Array.isArray(p.value) ? p.value : []
  const boxes = Array.from({ length: n }, (_, i) => cur[i] === true)
  return (
    <div data-testid="fate-stress" data-path={p.path} data-boxes={n} className="flex flex-wrap gap-nr-1" title={fmt(p.labels.boxes, { n })}>
      {boxes.map((on, i) => (
        <button
          key={i}
          type="button"
          data-testid="fate-stress-box"
          aria-pressed={on}
          disabled={p.readOnly}
          onClick={() => p.onChange(boxes.map((b, j) => (j === i ? !b : b)))}
          className={`flex size-7 items-center justify-center rounded-nr border text-nr-xs tabular-nums ${on ? 'border-nr-accent bg-nr-accent text-nr-accent-fg' : 'border-nr-line bg-nr-bg text-nr-muted hover:border-nr-accent/50'}`}
        >
          {i + 1}
        </button>
      ))}
    </div>
  )
}

function Consequence(p: WidgetProps): ReactNode {
  const sev = str(p.props.severity)
  return (
    <div className="flex items-center gap-nr-2">
      <span data-testid="fate-consequence" className="shrink-0 rounded-nr border border-nr-line px-nr-2 py-0.5 text-nr-xs tabular-nums text-nr-muted">
        {p.props.value !== undefined ? `−${str(p.props.value)} ` : ''}
        {p.labels.severities[sev] ?? sev}
      </span>
      <Text {...p} />
    </div>
  )
}

function FatePoints(p: WidgetProps): ReactNode {
  const v = typeof p.value === 'number' ? p.value : 0
  const from = str(p.props.refreshFrom)
  const refresh = from ? p.read(from) : undefined
  return (
    <div className="flex items-center gap-nr-2" data-testid="fate-points" data-path={p.path}>
      <button type="button" className={BTN} disabled={p.readOnly || v <= 0} onClick={() => p.onChange(v - 1)}>
        −
      </button>
      <span className="w-6 text-center text-nr-md tabular-nums text-nr-fg">{v}</span>
      <button type="button" className={BTN} disabled={p.readOnly} onClick={() => p.onChange(v + 1)}>
        +
      </button>
      {typeof refresh === 'number' ? <span className="text-nr-xs text-nr-muted">{fmt(p.labels.refresh, { n: refresh })}</span> : null}
    </div>
  )
}

/** Компоненты по id каталога (`baseWidgets`, `fateWidgets`, `ccv3Widgets`). */
export const WIDGET_COMPONENTS: Record<string, WidgetComponent> = {
  text: Text,
  textarea: Textarea,
  markdown: Markdown,
  number: NumberInput,
  slider: Slider,
  checkbox: Checkbox,
  select: Select,
  radio: Radio,
  chips: Chips,
  tags: Tags,
  list: (p) => <StringList {...p} rows={2} />,
  image: ImageWidget,
  date: DateInput,
  color: ColorInput,
  ref: Ref,
  json: Json,
  'fate.ladder': Ladder,
  'fate.aspect': Aspect,
  'fate.stress-track': StressTrack,
  'fate.consequence': Consequence,
  'fate.fate-points': FatePoints,
  'ccv3.greetings': (p) => <StringList {...p} rows={3} />,
  'ccv3.lorebook-keys': Tags,
}

/** Виджет по типу, когда ни описание, ни ранги каталога не выбрали. */
export function fallbackWidget(type: string, hasEnum: boolean): string {
  if (hasEnum) return 'select'
  if (type === 'string') return 'text'
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'boolean') return 'checkbox'
  if (type === 'string[]') return 'tags'
  if (type === 'boolean[]') return 'booleans'
  return 'json'
}

WIDGET_COMPONENTS.booleans = Booleans

/** Поле короткое — подпись слева в строку (property-grid.md); длинное — сверху. */
export const SHORT_WIDGETS = new Set(['number', 'slider', 'checkbox', 'select', 'radio', 'chips', 'date', 'color', 'fate.ladder', 'fate.fate-points'])

/** Инспектор: однострочные виджеты — подпись слева, колонка подписей выровнена; виджеты плагинов — `inline` каталога. */
export const INLINE_WIDGETS = new Set([...SHORT_WIDGETS, 'text', 'ref'])
