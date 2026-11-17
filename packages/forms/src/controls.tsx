// Контролы хозяина: `FormView` и `<ObjectEditor>` рисуют поля не сами, а набором контролов, который передаёт
// хозяин (`<FormControlsProvider controls={…}>` один раз у корня — все формы под ним берут их без правки). Пакет не знает
// кита хозяина: здесь только контракт и запасной набор на ролях (`nr-field`, `nr-ctl`, `nr-menu`) — для работы без
// хозяина (demo, тесты). Цвета и форма — токены `--nr-*` и роли; ни одного системного `<select>`, числа со стрелками
// и флажка с системным акцентом (сторож `tests/controls-guard.test.ts`).
//
// Раскладка полей — тоже здесь, а не у хозяина: `FieldGrid` — сетка «подпись слева» (колонка подписей по самой длинной,
// контролы выровнены), `FieldRow` — строка в ней; многострочное — подпись сверху во всю ширину. От шести строк чётная
// затемняется токеном `--nr-row-alt` (скин задаёт силу или выключает).

import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { parseNumber, stepNumber } from './util.js'

/** Атрибуты на сам контрол (`data-path` редактора объектов): адрес для тестов и плагинов. */
export type ControlAttrs = Record<string, string | undefined>

interface Base {
  id?: string
  testId?: string
  disabled?: boolean
  attrs?: ControlAttrs
  /** Имя для скринридера, если подписи `<label for>` рядом нет. */
  label?: string
}

export interface TextControlProps extends Base {
  value: string
  onChange(value: string): void
  onBlur?(): void
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void
  placeholder?: string
  /** Путь, id — моноширинным. */
  mono?: boolean
  /** id `<datalist>` подсказок. */
  list?: string
  autoFocus?: boolean
}

export interface TextareaControlProps extends Base {
  value: string
  onChange(value: string): void
  onBlur?(): void
  onKeyDown?(e: KeyboardEvent<HTMLTextAreaElement>): void
  placeholder?: string
  rows?: number
  /** Растёт по тексту (промпт), иначе — `rows` и ручка. */
  autoGrow?: boolean
  mono?: boolean
}

export interface NumberControlProps extends Base {
  /** `undefined` — пусто. */
  value: number | undefined
  /** На каждый ввод: число, `undefined` — стёрли. */
  onChange(value: number | undefined): void
  /** Ввод закончен (blur, Enter): одна запись истории на правку. */
  onCommit?(value: number | undefined): void
  min?: number
  max?: number
  step?: number
  /** Целое: ввод округляется. */
  integer?: boolean
  /** Единица справа приглушённо: `px`, `%`, `шагов`. */
  unit?: string
  placeholder?: string
}

export interface CheckboxControlProps extends Base {
  checked: boolean
  onChange(checked: boolean): void
  /** Подпись справа от флажка (в строке без колонки подписей). */
  children?: ReactNode
  /** `switch` — переключатель (вкл / выкл настройки), `checkbox` — флажок. */
  kind?: 'checkbox' | 'switch'
}

export interface ControlOption {
  value: string
  label: string
  /** Тултип и вторая строка: исходный id, подсказка. */
  title?: string
}

export interface SelectControlProps extends Base {
  /** `undefined` / не из списка — показ `placeholder`. */
  value: string | undefined
  options: readonly ControlOption[]
  onChange(value: string): void
  placeholder?: string
}

/** Выбор одного, все варианты видны рядом (радио: «Рядом / Туда же», 1k / 2k). */
export interface ChoiceControlProps extends Base {
  value: string | undefined
  options: readonly ControlOption[]
  onChange(value: string): void
}

export interface MultiSelectControlProps extends Base {
  value: readonly string[]
  options: readonly ControlOption[]
  onChange(value: string[]): void
}

export interface SliderControlProps extends Base {
  value: number
  onChange(value: number): void
  min: number
  max: number
  step?: number
  format?(value: number): string
}

export interface ButtonControlProps {
  variant?: 'default' | 'primary'
  type?: 'button' | 'submit'
  onClick?(): void
  disabled?: boolean
  testId?: string
  title?: string
  autoFocus?: boolean
  children?: ReactNode
}

export interface SectionControlProps {
  title: ReactNode
  open: boolean
  onToggle(): void
  /** Сводка свёрнутой: клик раскрывает. */
  summary?: ReactNode
  /** Справа в заголовке: «изменено 2». */
  badge?: ReactNode
  /** `forms-section` → тело секции, `-toggle`, `-summary`, `-changed`. */
  testId?: string
  attrs?: ControlAttrs
  children?: ReactNode
}

export interface FormControls {
  Text: ComponentType<TextControlProps>
  Textarea: ComponentType<TextareaControlProps>
  Number: ComponentType<NumberControlProps>
  Checkbox: ComponentType<CheckboxControlProps>
  Select: ComponentType<SelectControlProps>
  Choice: ComponentType<ChoiceControlProps>
  MultiSelect: ComponentType<MultiSelectControlProps>
  Slider: ComponentType<SliderControlProps>
  Button: ComponentType<ButtonControlProps>
  Section: ComponentType<SectionControlProps>
}

const ICON = 'size-nr-icon-sm shrink-0'
const FIELD = 'nr-field min-w-0 px-nr-3 py-nr-1 text-nr-sm text-nr-fg outline-none placeholder:text-nr-muted/70 focus:border-nr-accent disabled:opacity-50'
const data = (attrs?: ControlAttrs): Record<string, string> => Object.fromEntries(Object.entries(attrs ?? {}).filter((e): e is [string, string] => e[1] !== undefined))

function RoleText(p: TextControlProps): ReactNode {
  return (
    <input
      id={p.id}
      data-testid={p.testId}
      {...data(p.attrs)}
      aria-label={p.label}
      className={`${FIELD} w-full ${p.mono ? 'nr-mono' : ''}`}
      value={p.value}
      disabled={p.disabled}
      placeholder={p.placeholder}
      spellCheck={false}
      list={p.list}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={p.autoFocus}
      onChange={(e) => p.onChange(e.target.value)}
      onBlur={p.onBlur}
      onKeyDown={p.onKeyDown}
    />
  )
}

function RoleTextarea(p: TextareaControlProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!p.autoGrow || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [p.value, p.autoGrow])
  return (
    <textarea
      ref={ref}
      id={p.id}
      data-testid={p.testId}
      {...data(p.attrs)}
      aria-label={p.label}
      className={`${FIELD} w-full leading-nr-body ${p.autoGrow ? 'max-h-80 resize-none overflow-y-auto' : 'resize-y'} ${p.mono ? 'nr-mono' : ''}`}
      rows={p.rows ?? (p.autoGrow ? 1 : 3)}
      value={p.value}
      disabled={p.disabled}
      placeholder={p.placeholder}
      onChange={(e) => p.onChange(e.target.value)}
      onBlur={p.onBlur}
      onKeyDown={p.onKeyDown}
    />
  )
}

/**
 * Поведение поля-числа без системных стрелок: черновик текста, ↑ ↓ (Shift ×10, Alt ×0.1) и колесо над полем
 * в фокусе — шаг, Enter и blur — фиксация. Его же берёт `NumberField` кита хозяина, чтобы не разойтись.
 */
export function useNumberField(p: NumberControlProps): {
  text: string
  setText(text: string): void
  onKeyDown(e: KeyboardEvent<HTMLInputElement>): void
  onBlur(): void
  inputRef: RefObject<HTMLInputElement | null>
} {
  const shown = p.value === undefined ? '' : String(p.value)
  const [text, setDraft] = useState(shown)
  const editing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing.current) setDraft(shown)
  }, [shown])
  const norm = (n: number | undefined): number | undefined => (n === undefined ? undefined : p.integer ? Math.round(n) : n)
  const commit = (n: number | undefined): void => {
    editing.current = false
    p.onCommit?.(n)
  }
  const step = (dir: 1 | -1, scale = 1): void => {
    const next = stepNumber(norm(parseNumber(text)), dir, { ...(p.step !== undefined ? { step: p.step } : p.integer ? { step: 1 } : {}), ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), scale })
    setDraft(String(next))
    p.onChange(next)
    commit(next)
  }
  // Колесо: только в фокусе (страница прокручивается мимо), без пассивного слушателя — иначе preventDefault не работает.
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (document.activeElement !== el || e.deltaY === 0) return
      e.preventDefault()
      stepRef.current(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  return {
    text,
    inputRef,
    setText(t) {
      editing.current = true
      setDraft(t)
      const n = parseNumber(t)
      if (t.trim() === '') p.onChange(undefined)
      else if (n !== undefined) p.onChange(norm(n))
    },
    onKeyDown(e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
      } else if (e.key === 'Enter') commit(norm(parseNumber(text)))
    },
    onBlur() {
      const n = norm(parseNumber(text))
      setDraft(n === undefined ? '' : String(n))
      commit(n)
    },
  }
}

function RoleNumber(p: NumberControlProps): ReactNode {
  const f = useNumberField(p)
  return (
    <span className="nr-field inline-flex w-32 max-w-full min-w-0 items-center gap-nr-2 px-nr-3 py-nr-1 focus-within:border-nr-accent">
      <input
        ref={f.inputRef}
        id={p.id}
        data-testid={p.testId}
        {...data(p.attrs)}
        aria-label={p.label}
        inputMode={p.integer ? 'numeric' : 'decimal'}
        role="spinbutton"
        aria-valuenow={p.value}
        aria-valuemin={p.min}
        aria-valuemax={p.max}
        className="min-w-0 flex-1 bg-transparent text-nr-sm tabular-nums text-nr-fg outline-none placeholder:text-nr-muted/70 disabled:opacity-50"
        value={f.text}
        disabled={p.disabled}
        placeholder={p.placeholder}
        onChange={(e) => f.setText(e.target.value)}
        onKeyDown={f.onKeyDown}
        onBlur={f.onBlur}
      />
      {p.unit ? <span className="shrink-0 text-nr-xs text-nr-muted">{p.unit}</span> : null}
    </span>
  )
}

function RoleCheckbox(p: CheckboxControlProps): ReactNode {
  const sw = p.kind === 'switch'
  const box = (
    <button
      type="button"
      id={p.id}
      role={sw ? 'switch' : 'checkbox'}
      aria-checked={p.checked}
      aria-label={p.label}
      data-testid={p.testId}
      data-checked={p.checked ? 'true' : undefined}
      {...data(p.attrs)}
      disabled={p.disabled}
      onClick={() => p.onChange(!p.checked)}
      className={
        sw
          ? `nr-ctl relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 disabled:opacity-50 ${p.checked ? 'justify-end bg-nr-accent' : 'justify-start'}`
          : `nr-field inline-flex size-[1.15rem] shrink-0 items-center justify-center p-0 disabled:opacity-50 ${p.checked ? 'border-nr-accent bg-nr-accent text-nr-bg' : ''}`
      }
    >
      {sw ? <span className={`size-3.5 rounded-full ${p.checked ? 'bg-nr-bg' : 'bg-nr-muted'}`} /> : p.checked ? <Check aria-hidden="true" strokeWidth={3} className="size-3" /> : null}
    </button>
  )
  if (!p.children) return box
  return (
    <span className="inline-flex items-center gap-nr-2 text-nr-sm text-nr-fg">
      {box}
      <span onClick={() => !p.disabled && p.onChange(!p.checked)}>{p.children}</span>
    </span>
  )
}

/** Выбор из списка без системного `<select>`: поле-якорь и список роли `nr-menu`, ↑ ↓ Enter Esc. */
function RoleSelect(p: SelectControlProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [cur, setCur] = useState(-1)
  const anchor = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const current = p.options.find((o) => o.value === p.value)
  const testId = p.testId ?? 'select'
  const show = (): void => {
    setCur(Math.max(0, p.options.findIndex((o) => o.value === p.value)))
    setOpen(true)
  }
  const pick = (o: ControlOption): void => {
    p.onChange(o.value)
    setOpen(false)
    anchor.current?.focus()
  }
  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <button
        ref={anchor}
        type="button"
        id={p.id}
        data-testid={testId}
        data-value={p.value ?? ''}
        {...data(p.attrs)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={p.label}
        disabled={p.disabled}
        title={current?.title}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            show()
          } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setCur((c) => Math.min(p.options.length - 1, Math.max(0, c + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (open && e.key === 'Enter' && p.options[cur]) {
            e.preventDefault()
            pick(p.options[cur]!)
          } else if (open && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setOpen(false)
        }}
        className={`${FIELD} inline-flex min-w-[8rem] max-w-full items-center gap-nr-2 text-left`}
      >
        <span className={`min-w-0 flex-1 truncate ${current ? '' : 'text-nr-muted'}`}>{current?.label ?? p.placeholder ?? p.value ?? '—'}</span>
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className={`${ICON} text-nr-muted`} />
      </button>
      {open ? (
        <div id={listId} role="listbox" data-testid={`${testId}-popover`} className="nr-menu absolute left-0 top-full z-50 mt-nr-1 flex max-h-64 min-w-full flex-col overflow-y-auto py-nr-1">
          {p.options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === p.value}
              data-testid={`${testId}-option`}
              data-value={o.value}
              data-cursor={i === cur ? 'true' : undefined}
              title={o.title}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCur(i)}
              onClick={() => pick(o)}
              className={`nr-menu-item flex items-center gap-nr-2 px-nr-3 py-nr-1 text-left text-nr-sm ${i === cur ? 'bg-nr-hover' : ''} ${o.value === p.value ? 'text-nr-fg' : 'text-nr-muted'}`}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === p.value ? <Check aria-hidden="true" strokeWidth={1.75} className={ICON} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  )
}

/** Выбор одного рядом: кнопки-радио на роли `nr-ctl`, ← → внутри ряда. */
function RoleChoice(p: ChoiceControlProps): ReactNode {
  const move = (step: number): void => {
    const i = p.options.findIndex((o) => o.value === p.value)
    const next = p.options[(i + step + p.options.length) % p.options.length]
    if (next) p.onChange(next.value)
  }
  return (
    <span
      role="radiogroup"
      aria-label={p.label}
      data-testid={p.testId}
      data-value={p.value ?? ''}
      {...data(p.attrs)}
      className="flex flex-wrap gap-nr-1"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault()
          move(e.key === 'ArrowRight' ? 1 : -1)
        }
      }}
    >
      {p.options.map((o) => {
        const on = o.value === p.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-pressed={on}
            data-value={o.value}
            title={o.title}
            disabled={p.disabled}
            tabIndex={on || (p.value === undefined && o === p.options[0]) ? 0 : -1}
            onClick={() => p.onChange(o.value)}
            className={`nr-ctl px-nr-3 py-nr-1 text-nr-sm ${on ? 'text-nr-fg' : 'text-nr-muted hover:text-nr-fg'}`}
          >
            {o.label}
          </button>
        )
      })}
    </span>
  )
}

/** Несколько из списка: ряд нажимаемых чипов (`aria-pressed`). */
function RoleMultiSelect(p: MultiSelectControlProps): ReactNode {
  return (
    <span role="group" aria-label={p.label} data-testid={p.testId} {...data(p.attrs)} className="flex flex-wrap gap-nr-1">
      {p.options.map((o) => {
        const on = p.value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            data-value={o.value}
            title={o.title}
            disabled={p.disabled}
            onClick={() => p.onChange(on ? p.value.filter((v) => v !== o.value) : [...p.value, o.value])}
            className={`nr-ctl px-nr-3 py-0.5 text-nr-xs ${on ? 'text-nr-fg' : 'text-nr-muted hover:text-nr-fg'}`}
          >
            {o.label}
          </button>
        )
      })}
    </span>
  )
}

function RoleSlider(p: SliderControlProps): ReactNode {
  const fmt = p.format ?? String
  return (
    <span className="flex min-w-0 flex-1 items-center gap-nr-3">
      <input
        type="range"
        id={p.id}
        data-testid={p.testId}
        {...data(p.attrs)}
        aria-label={p.label}
        aria-valuetext={fmt(p.value)}
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={p.value}
        disabled={p.disabled}
        onChange={(e) => p.onChange(Number(e.target.value))}
        className="nr-slider min-w-0 flex-1"
      />
      <span className="shrink-0 text-nr-xs tabular-nums text-nr-fg">{fmt(p.value)}</span>
    </span>
  )
}

function RoleButton(p: ButtonControlProps): ReactNode {
  return (
    <button
      type={p.type ?? 'button'}
      data-testid={p.testId}
      data-variant={p.variant === 'primary' ? 'primary' : undefined}
      title={p.title}
      disabled={p.disabled}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={p.autoFocus}
      onClick={p.onClick}
      className={`nr-ctl inline-flex items-center justify-center gap-nr-2 px-nr-4 py-nr-1 text-nr-sm disabled:opacity-50 ${p.variant === 'primary' ? 'font-semibold' : 'text-nr-fg hover:bg-nr-hover'}`}
    >
      {p.children}
    </button>
  )
}

function RoleSection(p: SectionControlProps): ReactNode {
  const testId = p.testId ?? 'section'
  return (
    <section data-testid={testId} data-collapsed={String(!p.open)} {...data(p.attrs)} className="flex flex-col gap-nr-2">
      <header className="flex min-h-nr-hit min-w-0 items-center gap-nr-3">
        <button type="button" data-testid={`${testId}-toggle`} aria-expanded={p.open} onClick={p.onToggle} className="flex shrink-0 items-center gap-nr-1 text-nr-sm font-semibold text-nr-fg">
          {p.open ? <ChevronDown aria-hidden="true" strokeWidth={1.75} className={`${ICON} text-nr-muted`} /> : <ChevronRight aria-hidden="true" strokeWidth={1.75} className={`${ICON} text-nr-muted`} />}
          <span data-testid={`${testId}-title`}>{p.title}</span>
        </button>
        {p.summary ? (
          <button type="button" data-testid={`${testId}-summary`} onClick={p.onToggle} className="min-w-0 truncate text-left text-nr-sm text-nr-muted hover:text-nr-fg">
            {p.summary}
          </button>
        ) : null}
        {p.badge ? (
          <span data-testid={`${testId}-changed`} className="ml-auto shrink-0 text-nr-xs text-nr-accent">
            {p.badge}
          </span>
        ) : null}
      </header>
      {p.open ? p.children : null}
    </section>
  )
}

/** Запасной набор на ролях: без хозяина (demo, тесты пакета). */
export const ROLE_CONTROLS: FormControls = {
  Text: RoleText,
  Textarea: RoleTextarea,
  Number: RoleNumber,
  Checkbox: RoleCheckbox,
  Select: RoleSelect,
  Choice: RoleChoice,
  MultiSelect: RoleMultiSelect,
  Slider: RoleSlider,
  Button: RoleButton,
  Section: RoleSection,
}

const ControlsCtx = createContext<FormControls>(ROLE_CONTROLS)

/** Контролы хозяина для всех форм под ним; чего нет в `controls` — из внешнего набора (или запасного). */
export function FormControlsProvider({ controls, children }: { controls: Partial<FormControls>; children?: ReactNode }): ReactNode {
  const outer = useContext(ControlsCtx)
  const value = useMemo(() => ({ ...outer, ...controls }), [outer, controls])
  return <ControlsCtx.Provider value={value}>{children}</ControlsCtx.Provider>
}

export function useFormControls(): FormControls {
  return useContext(ControlsCtx)
}

/** От скольких строк чередуется фон (правило пульта). */
export const ROW_ALT_FROM = 6

/**
 * Сетка полей «подпись слева»: колонка подписей по самой длинной (не шире половины), контролы выровнены по одной линии.
 * Дети — `FieldRow` (и что угодно ещё: такая строка встаёт во всю ширину). `rows` — сколько строк-полей: от
 * `ROW_ALT_FROM` чётные затемняются `--nr-row-alt`.
 */
export function FieldGrid({ rows, children, testId, className = '' }: { rows: number; children?: ReactNode; testId?: string; className?: string }): ReactNode {
  return (
    <div
      data-testid={testId}
      data-alt={rows >= ROW_ALT_FROM ? 'true' : undefined}
      className={`grid min-w-0 grid-cols-[fit-content(50%)_minmax(0,1fr)] gap-x-nr-4 [&>*]:col-span-full data-[alt=true]:[&>[data-row]:nth-child(even)]:bg-[var(--nr-row-alt,transparent)] ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * Строка поля в `FieldGrid`: `inline` — подпись слева, контрол справа по ширине своего типа (число узкое, текст —
 * во всю колонку); `stack` — подпись сверху (многострочное, списки). `tail` — справа от контрола (происхождение).
 */
export function FieldRow({
  label,
  layout,
  children,
  tail,
  note,
  attrs,
  className = '',
  title,
}: {
  label: ReactNode
  layout: 'inline' | 'stack'
  children?: ReactNode
  tail?: ReactNode
  /** Под контролом: ошибка, кандидат генератора. */
  note?: ReactNode
  attrs?: ControlAttrs & { 'data-testid'?: string }
  className?: string
  title?: string
}): ReactNode {
  if (layout === 'stack') {
    return (
      <div data-row="stack" {...data(attrs)} title={title} className={`flex min-w-0 flex-col gap-nr-1 rounded-nr px-nr-2 py-nr-2 ${className}`}>
        <div className="flex min-w-0 items-center gap-nr-3">
          <div className="min-w-0 flex-1">{label}</div>
          {tail}
        </div>
        {children}
        {note}
      </div>
    )
  }
  return (
    <div data-row="inline" {...data(attrs)} title={title} className={`grid min-w-0 grid-cols-subgrid items-center gap-y-nr-1 rounded-nr px-nr-2 py-nr-1 ${className}`}>
      <div className="min-w-0">{label}</div>
      <div className="flex min-h-nr-hit min-w-0 items-center gap-nr-3">
        {children}
        {tail}
      </div>
      {note ? <div className="col-start-2 min-w-0">{note}</div> : null}
    </div>
  )
}
