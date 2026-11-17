/**
 * Форма по JSON Schema с `x-ui` (forms-spec §5.2, forms-2-spec §5) — один
 * компонент на всё: рецепты и виджеты форм, форма аргументов команды, шапка
 * макроса. Перенесена из nrchat (`src/core/forms/FormView.tsx`) без
 * смены поведения: вместо контекста плагина — `labels` (строки интерфейса) и
 * `modelWidget` (выбор модели рисует хозяин, по умолчанию — поле со списком).
 *
 * Презентационная: пропсы внутрь, колбэки наружу. Девять виджетов и списки
 * чипами; секции, пометки «задано в этом файле» и «изменено». Чего у вызывающего
 * нет (картинки, варианты моделей и файлов) — колбэк не передан, поле живёт без него.
 *
 * Классы — утилиты Tailwind на токенах `--nr-*` (`text-nr-sm`, `gap-nr-4`…):
 * потребитель сканирует пакет своим Tailwind (`@source`) с мостом токенов.
 */

import { ExternalLink, ImagePlus, Loader2, RotateCcw, X } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { unitOf, fieldDefault, isChanged, needsValue, orderedFields, originOf, prettyModel, revertValue, sameValue, sectionSummary, sectionsOf, sectionVisible, splitTitle } from './schema.js'
import type { FieldSchema, FormSchema, FormValue, Origin } from './schema.js'
import { LABELS } from './labels.js'
import type { FormLabels } from './labels.js'
import { FieldGrid, FieldRow, useFormControls, type FormControls } from './controls.js'

export * from './schema.js'
export * from './util.js'
export * from './controls.js'
export { LABELS } from './labels.js'
export type { FormLabels } from './labels.js'
export * from './object-editor/index.js'

/** Модель в каталоге выбора: id, человеческое имя, провайдер, окно контекста. */
export interface ModelEntry {
  id: string
  name: string
  provider?: string
  contextWindow?: number
}

/** Пропсы виджета модели (`model`, `model[]`): свой — `modelWidget` формы. */
export interface ModelWidgetProps {
  value: string
  onChange(id: string): void
  placeholder: string
  models: ModelEntry[]
  /** Список открыли — пора загрузить варианты. */
  onOpen?(): void
  clearable: boolean
  allowCustom: boolean
  disabled: boolean
  testId: string
}

/** Строки и виджет модели — то, что раньше форма брала из контекста плагина. */
interface Tr {
  t(key: keyof FormLabels, vars?: Record<string, string | number>): string
  Model: ComponentType<ModelWidgetProps>
  /** Контролы хозяина (`FormControlsProvider`) или запасные на ролях. */
  C: FormControls
}

/** Подстановка `{name}` — тот же формат, что у словарей nrchat. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole))
}

function makeTr(labels: Partial<FormLabels> | undefined, Model: ComponentType<ModelWidgetProps> | undefined, C: FormControls): Tr {
  const all: FormLabels = { ...LABELS, ...labels }
  return { t: (key, vars) => interpolate(all[key], vars), Model: Model ?? DefaultModel, C }
}

/** Выбор модели без хозяина: поле со списком id (свой id — вводом). */
export function DefaultModel({ value, onChange, placeholder, models, onOpen, disabled, testId }: ModelWidgetProps): ReactNode {
  const list = `${testId}-list`
  return (
    <span className="flex min-w-0 flex-1">
      <input
        data-testid={testId}
        list={list}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onFocus={onOpen}
        onChange={(e) => onChange(e.target.value)}
        className="nr-field min-w-0 flex-1 px-nr-3 py-nr-1 text-nr-sm text-nr-fg outline-none focus:border-nr-accent"
      />
      <datalist id={list}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>
    </span>
  )
}

const ICON = 'size-nr-icon-sm shrink-0'

/** Что форма знает о своём источнике: id (ключ полей), файл (подписи), схема или ошибка разбора. */
export interface FormTemplate {
  id: string
  file: string
  schema: FormSchema | null
  error?: string
}

/** Модель провайдера рецепта с тем, что он о ней сказал (сервис `models`, `infos`). */
export interface ModelOption {
  id: string
  name?: string
  owner?: string
  contextWindow?: number
}

/** Список вариантов поля `model` / `file` (сервис `models` / `files`). */
export interface OptionList {
  items: string[]
  /** У моделей — имя, владелец, контекст (пульт, ModelChooser). */
  infos?: ModelOption[]
  loading: boolean
  error?: string
}

/** Вариант рецепта (`variants` сервиса): «Вариант» наверху формы (вариант = пресет). */
export interface VariantOption {
  file: string
  title: string
  values: Record<string, FormValue>
}

/** Вход картинки для `input.image`: байты (буфер, drop), путь или URL. */
export type ImageInput =
  | { kind: 'bytes'; data: Uint8Array; mime: string; name?: string }
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }

/** Текст, вставленный в поле картинки: URL — скачать, иначе путь. */
export function textInput(text: string): ImageInput | null {
  const t = text.trim().replace(/^["']|["']$/g, '')
  if (t === '' || t.includes('\n')) return null
  return /^https?:\/\//i.test(t) ? { kind: 'url', url: t } : { kind: 'path', path: t }
}

// ────────────────────────────────────────────────────────────────────────────
// Поля
// ────────────────────────────────────────────────────────────────────────────

/**
 * Подпись поля (пульт по-человечески): предложением, обычным шрифтом, не
 * капсом; подсказка — часть `// подпись` после «:» — в title. Звёздочка — только у
 * пустого обязательного.
 */
function Label({ name, field, star, htmlFor, required, muted }: { name: string; field: FieldSchema; star: boolean; htmlFor?: string; required: string; muted?: boolean }): ReactNode {
  const split = splitTitle(field.title, name)
  const { hint } = split
  const label = field['x-ui'].widget === 'number' ? unitOf(split.label).label : split.label
  return (
    <label htmlFor={htmlFor} title={hint || undefined} data-testid="forms-label" className={`flex min-w-0 items-baseline gap-nr-1 text-nr-sm leading-nr-ui ${muted ? 'text-nr-muted' : 'text-nr-fg'}`}>
      <span className="min-w-0">{label}</span>
      {star ? (
        <span data-testid="forms-required" className="text-nr-error" aria-label={required}>
          *
        </span>
      ) : null}
    </label>
  )
}

/** Многострочное поле, растущее по содержимому (`text`, forms-spec §2). */
export function transferInput(data: DataTransfer | null): Promise<ImageInput | null> | ImageInput | null {
  if (!data) return null
  const file = Array.from(data.files).find((f) => f.type.startsWith('image/'))
  if (file) {
    return file.arrayBuffer().then((buf) => ({ kind: 'bytes', data: new Uint8Array(buf), mime: file.type, name: file.name }) as ImageInput)
  }
  const uri = data.getData('text/uri-list').split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))
  const text = uri ?? data.getData('text/plain')
  return text ? textInput(text) : null
}

function ImageField({
  tr,
  name,
  value,
  thumb,
  focused,
  onFocus,
  onInput,
  onClear,
  onPasteClipboard,
}: {
  tr: Tr
  name: string
  value: string
  thumb: string | undefined
  focused: boolean
  onFocus(): void
  onInput(input: ImageInput): void
  onClear(): void
  onPasteClipboard(): void
}): ReactNode {
  const { t } = tr
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)

  const take = async (data: DataTransfer | null): Promise<boolean> => {
    const input = await transferInput(data)
    if (input) onInput(input)
    return input !== null
  }

  return (
    <div
      data-testid="forms-image"
      data-field={name}
      data-focused={String(focused)}
      tabIndex={0}
      onFocus={onFocus}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        onFocus()
        void take(e.dataTransfer)
      }}
      className={`flex items-center gap-nr-3 rounded-nr border px-nr-2 py-nr-2 outline-none ${
        over ? 'border-nr-accent bg-nr-line-soft' : focused ? 'border-nr-accent/50' : 'border-nr-line'
      }`}
    >
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-nr border border-nr-line-soft bg-nr-bg">
        {value !== '' && thumb ? (
          <img data-testid="forms-image-thumb" src={thumb} alt="" className="size-full object-cover" />
        ) : value !== '' ? (
          <Loader2 aria-hidden="true" strokeWidth={1.75} className={`${ICON} animate-spin text-nr-muted`} />
        ) : (
          <ImagePlus aria-hidden="true" strokeWidth={1.75} className={`${ICON} text-nr-muted`} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-nr-1">
        {value !== '' ? (
          <span data-testid="forms-image-path" className="nr-mono truncate text-nr-xs text-nr-muted" title={value}>
            {value}
          </span>
        ) : null}
        <input
          data-testid="forms-image-input"
          value={text}
          placeholder={t('imageHint')}
          onFocus={onFocus}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Картинка из буфера прямо в поле; текст (путь, URL) — обычной вставкой, потом Enter.
            const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
            if (file) {
              e.preventDefault()
              void take(e.clipboardData)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              const input = textInput(text)
              if (input) {
                onInput(input)
                setText('')
              }
            }
          }}
          className="nr-mono w-full rounded-nr border border-nr-line-soft bg-nr-bg px-nr-2 py-0.5 text-nr-xs text-nr-fg outline-none"
        />
      </div>
      <button
        type="button"
        data-testid="forms-image-paste"
        title={t('pasteImage')}
        onClick={onPasteClipboard}
        className="nr-mono shrink-0 text-nr-xs text-nr-muted hover:text-nr-fg"
      >
        ⌘V
      </button>
      {value !== '' ? (
        <button type="button" data-testid="forms-image-clear" title={t('clear')} onClick={onClear} className="shrink-0 text-nr-muted hover:text-nr-fg">
          <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
        </button>
      ) : null}
    </div>
  )
}

/** Все картинки из DataTransfer / FileList: файлы-картинки байтами, иначе текст (путь, URL) одной. */
export async function transferInputs(files: ArrayLike<File>, data?: DataTransfer | null): Promise<ImageInput[]> {
  const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
  if (images.length > 0) {
    return Promise.all(images.map(async (f) => ({ kind: 'bytes', data: new Uint8Array(await f.arrayBuffer()), mime: f.type, name: f.name }) as ImageInput))
  }
  const one = data ? await transferInput(data) : null
  return one ? [one] : []
}

/**
 * Список картинок (`image[]`): превью с ×, перетаскивание нескольких
 * файлов разом, «Выбрать» — диалог файлов, ⌘V — из буфера. Каждая картинка — отдельный
 * `input.image` сервиса (путь в `inputs/`), в задачу уходит копией во входы.
 */
function ImageListField({
  tr,
  name,
  items,
  thumbs,
  focused,
  onFocus,
  onInput,
  onRemove,
  onPasteClipboard,
}: {
  tr: Tr
  name: string
  items: string[]
  thumbs: Record<string, string>
  focused: boolean
  onFocus(): void
  onInput(input: ImageInput): void
  onRemove(path: string): void
  onPasteClipboard(): void
}): ReactNode {
  const { t } = tr
  const [over, setOver] = useState(false)
  const pick = useRef<HTMLInputElement | null>(null)
  const take = async (files: ArrayLike<File>, data?: DataTransfer | null): Promise<void> => {
    for (const input of await transferInputs(files, data)) onInput(input)
  }
  return (
    <div
      data-testid="forms-images"
      data-field={name}
      data-focused={String(focused)}
      tabIndex={0}
      onFocus={onFocus}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        onFocus()
        void take(e.dataTransfer.files, e.dataTransfer)
      }}
      className={`flex flex-wrap items-center gap-nr-2 rounded-nr border border-dashed px-nr-2 py-nr-2 outline-none ${
        over ? 'border-nr-accent bg-nr-line-soft' : focused ? 'border-nr-accent/50' : 'border-nr-line'
      }`}
    >
      {items.map((path) => (
        <div key={path} data-testid="forms-images-item" data-path={path} title={path} className="relative size-16 shrink-0 overflow-hidden rounded-nr border border-nr-line-soft bg-nr-bg">
          {thumbs[path] ? (
            <img src={thumbs[path]} alt="" className="size-full object-cover" />
          ) : (
            <Loader2 aria-hidden="true" strokeWidth={1.75} className={`${ICON} m-auto mt-6 animate-spin text-nr-muted`} />
          )}
          <button
            type="button"
            data-testid="forms-images-remove"
            title={t('clear')}
            onClick={() => onRemove(path)}
            className="absolute right-0.5 top-0.5 rounded-nr bg-nr-bg/80 text-nr-muted hover:text-nr-fg"
          >
            <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
          </button>
        </div>
      ))}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-nr-3 text-nr-sm text-nr-muted">
        {items.length === 0 ? <ImagePlus aria-hidden="true" strokeWidth={1.75} className={ICON} /> : null}
        <span className="min-w-0">{t('imagesHint')}</span>
        <button type="button" data-testid="forms-images-pick" onClick={() => pick.current?.click()} className="ml-auto shrink-0 rounded-nr border border-nr-line px-nr-2 text-nr-fg hover:border-nr-accent/50">
          {t('imagesPick')}
        </button>
        <button type="button" data-testid="forms-image-paste" title={t('pasteImage')} onClick={onPasteClipboard} className="shrink-0 hover:text-nr-fg">
          ⌘V
        </button>
        <input
          ref={pick}
          type="file"
          multiple
          accept="image/*"
          data-testid="forms-images-file"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files
            if (files) void take(files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Поля forms 2: строка, число, модель / файл со списком, списки чипами
// ────────────────────────────────────────────────────────────────────────────

const INPUT = 'nr-field w-full min-w-0 px-nr-3 py-nr-1 text-nr-sm text-nr-fg outline-none placeholder:text-nr-muted/70 focus:border-nr-accent'

/** Варианты под фильтром: подстрока без регистра. */
export function filterOptions(items: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  return q === '' ? [...items] : items.filter((x) => x.toLowerCase().includes(q))
}

/**
 * Поле со списком вариантов под ним (модели, файлы; forms-2-spec §5): список в
 * потоке, а не поверх окна; фильтр по подстроке, стрелки и Enter; свободный
 * ввод разрешён. Список грузится при первом фокусе (`onLoad`).
 *
 * `mode: 'value'` — поле и есть значение (скаляр); `'add'` — ввод добавляет
 * элемент списка (Enter или выбор), поле очищается.
 */
function ComboInput({
  tr,
  name,
  value,
  mode,
  options,
  testId,
  onLoad,
  onChange,
  onAdd,
}: {
  tr: Tr
  name: string
  value: string
  mode: 'value' | 'add'
  /** Варианты; `undefined` — поле без списка (простой `string[]`). */
  options: OptionList | undefined
  testId: string
  onLoad?(): void
  onChange?(v: string): void
  onAdd?(v: string): void
}): ReactNode {
  const { t } = tr
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement | null>(null)
  const shown = mode === 'value' ? value : text
  const items = options ? filterOptions(options.items, query) : []

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const pick = (item: string): void => {
    if (mode === 'value') onChange?.(item)
    else {
      onAdd?.(item)
      setText('')
    }
    setQuery('')
    setActive(-1)
    if (mode === 'value') setOpen(false)
  }

  return (
    <div className="flex flex-col gap-nr-1">
      <input
        data-testid={testId}
        value={shown}
        spellCheck={false}
        placeholder={mode === 'add' ? t('add') : undefined}
        onFocus={() => {
          setOpen(true)
          setQuery('')
          setActive(-1)
          onLoad?.()
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          const v = e.target.value
          if (mode === 'value') onChange?.(v)
          else setText(v)
          setQuery(v)
          setActive(-1)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length > 0) {
            e.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(i + 1, items.length - 1))
          } else if (e.key === 'ArrowUp' && items.length > 0) {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Escape') {
            // Открытый список закрывается сам и гасит Esc: иначе его ловит хозяин (закрыть вкладку, окно формы).
            if (open) {
              e.preventDefault()
              e.stopPropagation()
            }
            setOpen(false)
          } else if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (open && active >= 0 && items[active] !== undefined) pick(items[active]!)
            else if (mode === 'add' && text.trim() !== '') pick(text.trim())
            else setOpen(false)
          }
        }}
        className={INPUT}
      />
      {open && items.length > 0 ? (
        <div
          ref={listRef}
          data-testid={`forms-options-${name}`}
          role="listbox"
          className="max-h-40 overflow-y-auto rounded-nr border border-nr-line-soft bg-nr-bg py-0.5"
        >
          {items.map((item, i) => (
            <div
              key={item}
              role="option"
              aria-selected={i === active}
              data-testid="forms-option"
              data-index={i}
              // mousedown, а не click: blur поля закрыл бы список раньше клика.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(item)
              }}
              onMouseEnter={() => setActive(i)}
              className={`nr-mono cursor-pointer truncate px-nr-2 text-nr-xs ${i === active ? 'bg-nr-line-soft text-nr-fg' : 'text-nr-muted'}`}
            >
              {item}
            </div>
          ))}
        </div>
      ) : null}
      {options && open && options.loading ? (
        <span className="nr-mono text-nr-xs text-nr-muted">{t('optionsLoading')}</span>
      ) : options && !options.loading && (options.error || options.items.length === 0) ? (
        <span data-testid={`forms-options-note-${name}`} className="nr-mono truncate text-nr-xs text-nr-muted" title={options.error}>
          {options.error ? t('optionsError', { error: options.error }) : t('optionsEmpty')}
        </span>
      ) : null}
    </div>
  )
}

/** Список строк чипами: удалить — крестик, добавить — тем же виджетом, что у скаляра. */
function ChipList({
  tr,
  name,
  items,
  options,
  onLoad,
  onChange,
}: {
  tr: Tr
  name: string
  items: string[]
  options: OptionList | undefined
  onLoad?(): void
  onChange(items: string[]): void
}): ReactNode {
  const { t } = tr
  return (
    <div className="flex flex-col gap-nr-1">
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-nr-1">
          {items.map((item, i) => (
            <span
              key={`${i}:${item}`}
              data-testid="forms-chip"
              data-value={item}
              className="nr-mono flex max-w-full items-center gap-nr-1 rounded-nr border border-nr-line px-nr-2 py-0.5 text-nr-xs text-nr-fg"
            >
              <span className="min-w-0 truncate" title={item}>
                {item}
              </span>
              <button
                type="button"
                data-testid="forms-chip-remove"
                title={t('removeItem')}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 text-nr-muted hover:text-nr-fg"
              >
                <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <ComboInput
        tr={tr}
        name={name}
        value=""
        mode="add"
        options={options}
        testId={`forms-add-${name}`}
        {...(onLoad ? { onLoad } : {})}
        onAdd={(v) => onChange([...items, v])}
      />
    </div>
  )
}

export interface FormViewProps {
  /** Строки интерфейса поверх английских по умолчанию (`LABELS`); `{name}` — подстановки. */
  labels?: Partial<FormLabels>
  /** Виджет модели (`model`, `model[]`); нет — `DefaultModel`. */
  modelWidget?: ComponentType<ModelWidgetProps>
  template: FormTemplate
  values: Record<string, FormValue>
  thumbs: Record<string, string>
  imageField: string | null
  disabled: boolean
  onChange(field: string, value: FormValue): void
  onImage(field: string, input: ImageInput): void
  onImageFocus(field: string): void
  onPasteClipboard(field: string): void
  onSubmit(): void
  /** Свёрнута ли секция (стор); `undefined` — не трогали: дефолт секции (`$nr-collapsed`). */
  collapsed?(section: string): boolean | undefined
  /** `def` — свёрнута ли секция по умолчанию (переключение от него, пока стор пуст). */
  onToggleSection?(section: string, def?: boolean): void
  /** Варианты поля `model` / `file` и их загрузка. */
  options?(widget: 'model' | 'file', field: string): OptionList | undefined
  onOptions?(widget: 'model' | 'file', field: string): void
  /** Вернуть полю дефолт файла. */
  onReset?(field: string): void
  /**
   * Только поля этой секции, без заголовков секций (инспектор схемы,
   * pipeline-graph-spec §4); `''` — безымянная. Нет — форма целиком.
   */
  section?: string
  /** Метки происхождения «вариант / запуск» и «↶ вернуть»; у виджета — нет. */
  origins?: boolean
  /** Фильтр «только изменённые»: есть колбэк — есть переключатель. */
  onlyChanged?: boolean
  onOnlyChanged?(value: boolean): void
  /** «Вариант» наверху (вариант = пресет): файлы-варианты рецепта; меньше двух — не рисуется. */
  variants?: VariantOption[]
  onVariant?(variant: VariantOption): void
  /** «Открыть» у поля `file`: путь относительно папки шаблона. */
  onOpenFile?(path: string): void
}

/** Короткие поля — подпись слева в строку (обзор); длинные — подпись сверху (property-grid.md п.1–2). */
const SHORT = new Set(['select', 'radio', 'number', 'checkbox', 'model', 'file', 'input'])

const fieldShown = (schema: FormSchema, name: string, values: Record<string, FormValue>, onlyChanged: boolean | undefined): boolean =>
  !onlyChanged || originOf(schema, name, values[name]) !== 'recipe'

/** Вариант рецепта (select) и фильтр «только изменённые» — над формой. */
function FormToolbar({ tr, template, values, variants, onVariant, onlyChanged, onOnlyChanged }: FormViewProps & { tr: Tr; values: Record<string, FormValue> }): ReactNode {
  const { t } = tr
  const many = (variants?.length ?? 0) > 1 && onVariant
  if (!many && !onOnlyChanged) return null
  const schema = template.schema!
  // Текущий вариант — тот, чьи значения совпадают с формой; иначе — «свой» (изменён).
  const current =
    variants?.find((v) => Object.keys(schema.properties).every((k) => v.values[k] === undefined || sameValue(v.values[k], values[k]))) ?? null
  const C = tr.C
  const variantId = 'forms-variant-' + template.id
  return (
    <div data-testid="forms-toolbar" className="flex flex-wrap items-center gap-x-nr-5 gap-y-nr-2 pb-nr-2">
      {many ? (
        <span className="flex min-w-0 items-center gap-nr-3 text-nr-sm text-nr-fg">
          <label htmlFor={variantId} className="text-nr-sm text-nr-muted">
            {t('variant')}
          </label>
          <C.Select
            id={variantId}
            testId="forms-variant"
            value={current?.file ?? ''}
            placeholder={t('variantCustom')}
            options={variants!.map((v) => ({ value: v.file, label: v.title + (v.file === template.file ? ` — ${t('variantThis')}` : ''), title: v.file }))}
            onChange={(file) => {
              const v = variants!.find((x) => x.file === file)
              if (v) onVariant!(v)
            }}
          />
        </span>
      ) : null}
      {onOnlyChanged ? (
        <span className="ml-auto">
          <C.Checkbox kind="switch" testId="forms-only-changed" checked={onlyChanged === true} onChange={onOnlyChanged} label={t('onlyChanged')}>
            {t('onlyChanged')}
          </C.Checkbox>
        </span>
      ) : null}
    </div>
  )
}

export function FormView(props: FormViewProps): ReactNode {
  const { template, values, collapsed, onToggleSection, onlyChanged } = props
  const tr = makeTr(props.labels, props.modelWidget, useFormControls())
  const { t } = tr
  if (!template.schema) {
    return (
      <div data-testid="forms-broken" className="px-4 py-nr-3 text-nr-sm text-nr-error">
        {t('brokenTemplate', { error: template.error ?? '' })}
        <div className="nr-mono mt-nr-1 text-nr-xs text-nr-muted">{template.file}</div>
      </div>
    )
  }
  const schema: FormSchema = template.schema
  const fields = orderedFields(schema)
  const C = tr.C
  const fieldList = (list: Array<[string, FieldSchema]>): ReactNode => (
    <FieldGrid rows={list.length}>
      {list.map(([name, field]) => (
        <Field key={name} {...props} tr={tr} schema={schema} name={name} field={field} />
      ))}
    </FieldGrid>
  )
  if (props.section !== undefined) {
    const only = fields.filter(([, f]) => (f['x-ui'].section ?? '') === props.section)
    return (
      <fieldset data-testid="forms-form" data-section={props.section} disabled={props.disabled} className="flex min-w-0 flex-col gap-nr-3 px-nr-3 py-nr-3">
        {fieldList(only)}
      </fieldset>
    )
  }
  return (
    <fieldset data-testid="forms-form" disabled={props.disabled} className="flex min-w-0 flex-col gap-nr-3 px-nr-3 py-nr-3">
      <FormToolbar {...props} tr={tr} values={values} />
      {sectionsOf(schema).map((section) => {
        // `$nr-show-if`: секция не к выбранному шагу — не на экране; значения не трогаются.
        if (!sectionVisible(section, values)) return null
        const own = fields.filter(([name, f]) => (f['x-ui'].section ?? '') === section.id && fieldShown(schema, name, values, onlyChanged))
        if (own.length === 0) return null
        if (section.title === '') {
          return (
            <section key={section.id} data-testid="forms-section" data-section={section.id} data-collapsed="false" className="flex min-w-0 flex-col">
              {fieldList(own)}
            </section>
          )
        }
        const isCollapsed = onlyChanged ? false : (collapsed?.(section.id) ?? section.collapsed ?? false)
        const changed = own.filter(([name]) => originOf(schema, name, values[name]) !== 'recipe').length
        const summary = isCollapsed ? sectionSummary(schema, section.id, values) : ''
        return (
          <C.Section
            key={section.id}
            testId="forms-section"
            attrs={{ 'data-section': section.id }}
            title={section.title}
            open={!isCollapsed}
            onToggle={() => onToggleSection?.(section.id, section.collapsed === true)}
            {...(summary !== '' ? { summary } : {})}
            {...(changed > 0 ? { badge: t('changedCount', { n: changed }) } : {})}
          >
            {fieldList(own)}
          </C.Section>
        )
      })}
    </fieldset>
  )
}

/** Метка происхождения и «↶ вернуть» (снимает запись текущего уровня: запуск → файл, вариант → база). */
function OriginTag({ tr, origin, base, onRevert, name }: { tr: Tr; origin: Origin; base?: string | undefined; onRevert?(): void; name: string }): ReactNode {
  const { t } = tr
  if (origin === 'recipe') return null
  return (
    <span className="flex shrink-0 items-center gap-nr-2">
      <span data-testid={`forms-origin-${name}`} data-origin={origin} title={t(`originHint.${origin}`, { base: base ?? '' })} className={`text-nr-xs ${origin === 'run' ? 'text-nr-accent' : 'text-nr-muted'}`}>
        {t(`origin.${origin}`)}
      </span>
      {onRevert ? (
        <button
          type="button"
          data-testid={`forms-reset-${name}`}
          title={t(origin === 'run' ? 'revertRun' : 'revertVariant', { base: base ?? '' })}
          onClick={onRevert}
          className="flex items-center gap-nr-1 text-nr-xs text-nr-muted hover:text-nr-fg"
        >
          <RotateCcw aria-hidden="true" strokeWidth={1.75} className={ICON} />
          {t('revert')}
        </button>
      ) : null}
    </span>
  )
}

/** Модели провайдера рецепта для ModelChooser: имя — провайдера или из id, группа — владелец. */
function modelCatalog(list: OptionList | undefined, current: string[]): ModelEntry[] {
  const src: ModelOption[] = list?.infos ?? list?.items.map((id) => ({ id })) ?? []
  const infos: ModelEntry[] = src.map((m) => {
    const out: ModelEntry = { id: m.id, name: m.name || prettyModel(m.id) }
    if (m.owner) out.provider = m.owner
    else if (m.id.includes('/')) out.provider = m.id.split('/')[0]!
    if (m.contextWindow) out.contextWindow = m.contextWindow
    return out
  })
  // Значение не из каталога (провайдер принимает и такие) — тоже с человеческим именем.
  for (const id of current) if (id && !infos.some((m) => m.id === id)) infos.push({ id, name: prettyModel(id), ...(id.includes('/') ? { provider: id.split('/')[0]! } : {}) })
  return infos
}

function Field({
  tr,
  template,
  values,
  thumbs,
  imageField,
  onChange,
  onImage,
  onImageFocus,
  onPasteClipboard,
  onSubmit,
  options,
  onOptions,
  onReset,
  origins,
  onOpenFile,
  disabled,
  schema,
  name,
  field,
}: FormViewProps & { tr: Tr; schema: FormSchema; name: string; field: FieldSchema }): ReactNode {
  const { t, C } = tr
  const value = values[name]
  const str = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  const widget = field['x-ui'].widget
  const own = field['x-ui'].own === true
  const changed = isChanged(schema, name, value)
  const star = needsValue(schema, name, value)
  const origin = originOf(schema, name, value)
  const combo = widget === 'model' || widget === 'file' ? widget : null
  const list = combo ? options?.(combo, name) : undefined
  const load = combo && onOptions ? () => onOptions(combo, name) : undefined
  const optional = !schema.required.includes(name)
  const { hint } = splitTitle(field.title, name)
  const inputId = `forms-${template.id}-${name}`
  const short = SHORT.has(widget) && field.type !== 'array'
  const preset = field['x-ui'].preset !== undefined

  const revert =
    origins === false
      ? undefined
      : origin === 'run' && preset
        ? () => onChange(name, fieldDefault(field)) // профиль: вернуть и его поля
        : origin === 'run' && onReset
        ? () => onReset(name)
        : origin === 'variant'
          ? () => {
              const to = revertValue(schema, name, value)
              if (to !== undefined) onChange(name, to)
            }
          : undefined
  const tail = origins === false ? null : <OriginTag tr={tr} origin={origin} base={schema['x-ui']?.base} name={name} {...(revert ? { onRevert: revert } : {})} />

  const labels = field['x-ui'].labels ?? {}
  const control: ReactNode =
    widget === 'image' && field.type === 'array' ? (
      <ImageListField
        tr={tr}
        name={name}
        items={Array.isArray(value) ? value : []}
        thumbs={thumbs}
        focused={imageField === name}
        onFocus={() => onImageFocus(name)}
        onInput={(input) => onImage(name, input)}
        onRemove={(path) => onChange(name, (Array.isArray(value) ? value : []).filter((p) => p !== path))}
        onPasteClipboard={() => onPasteClipboard(name)}
      />
    ) : widget === 'image' ? (
      <ImageField
        tr={tr}
        name={name}
        value={str}
        thumb={thumbs[str] || undefined}
        focused={imageField === name}
        onFocus={() => onImageFocus(name)}
        onInput={(input) => onImage(name, input)}
        onClear={() => onChange(name, '')}
        onPasteClipboard={() => onPasteClipboard(name)}
      />
    ) : widget === 'textarea' ? (
      <C.Textarea
        id={inputId}
        testId={`forms-input-${name}`}
        value={str}
        autoGrow
        rows={2}
        {...(hint ? { placeholder: hint } : {})}
        onChange={(v) => onChange(name, v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
    ) : widget === 'model' && field.type === 'array' ? (
      <ModelList
        tr={tr}
        name={name}
        items={Array.isArray(value) ? value : []}
        catalog={modelCatalog(list, Array.isArray(value) ? value : [])}
        disabled={disabled}
        {...(load ? { onLoad: load } : {})}
        onChange={(items) => onChange(name, items)}
      />
    ) : field.type === 'array' ? (
      <ChipList
        tr={tr}
        name={name}
        items={Array.isArray(value) ? value : []}
        options={list}
        {...(load ? { onLoad: load } : {})}
        onChange={(items) => onChange(name, items)}
      />
    ) : widget === 'model' ? (
      <tr.Model
        value={str}
        onChange={(id) => onChange(name, id)}
        placeholder={t(optional ? 'modelOff' : 'modelNone')}
        models={modelCatalog(list, [str])}
        {...(load ? { onOpen: load } : {})}
        clearable={optional}
        allowCustom
        disabled={disabled}
        testId={`forms-model-${name}`}
      />
    ) : widget === 'file' ? (
      <div className="flex min-w-0 flex-1 items-start gap-nr-2">
        <div className="min-w-0 flex-1">
          <ComboInput
            tr={tr}
            name={name}
            value={str}
            mode="value"
            // Список ещё не запрашивали (первый фокус впереди) — это «грузится», а не «вариантов нет».
            options={list ?? (load ? { items: [], loading: true } : undefined)}
            testId={`forms-input-${name}`}
            {...(load ? { onLoad: load } : {})}
            onChange={(v) => onChange(name, v)}
          />
        </div>
        {str !== '' && onOpenFile ? (
          <button
            type="button"
            data-testid={`forms-open-${name}`}
            title={t('openFileHint', { file: str })}
            onClick={() => onOpenFile(str)}
            className="flex shrink-0 items-center gap-nr-1 py-nr-1 text-nr-sm text-nr-muted hover:text-nr-fg"
          >
            <ExternalLink aria-hidden="true" strokeWidth={1.75} className={ICON} />
            {t('openFile')}
          </button>
        ) : null}
      </div>
    ) : widget === 'number' ? (
      <C.Number
        id={inputId}
        testId={`forms-input-${name}`}
        value={typeof value === 'number' ? value : str === '' ? undefined : Number(str)}
        {...(field.minimum !== undefined ? { min: field.minimum } : {})}
        {...(field.maximum !== undefined ? { max: field.maximum } : {})}
        {...(unitOf(splitTitle(field.title, name).label).unit ? { unit: unitOf(splitTitle(field.title, name).label).unit! } : {})}
        onChange={(n) => onChange(name, n === undefined ? '' : n)}
      />
    ) : widget === 'input' ? (
      <C.Text id={inputId} testId={`forms-input-${name}`} value={str} {...(hint ? { placeholder: hint } : {})} onChange={(v) => onChange(name, v)} />
    ) : widget === 'radio' ? (
      <C.Choice
        id={inputId}
        testId={`forms-input-${name}`}
        label={splitTitle(field.title, name).label}
        value={str}
        options={(field.enum ?? []).map((opt) => ({ value: opt, label: labels[opt] ?? opt, ...(labels[opt] ? { title: opt } : {}) }))}
        onChange={(v) => onChange(name, v)}
      />
    ) : widget === 'select' ? (
      <span className="flex min-w-0 flex-wrap items-center gap-x-nr-3 gap-y-nr-1">
        <C.Select
          id={inputId}
          testId={`forms-input-${name}`}
          value={str}
          placeholder={str || '—'}
          options={[
            // Значение не из списка (руками в файле) — видно и выбирается обратно.
            ...((field.enum ?? []).includes(str) || str === '' ? [] : [{ value: str, label: str }]),
            // Необязательный профиль: «—» всегда в списке — вернуться к моделям рецепта.
            ...(preset && optional ? [{ value: '', label: '—' }] : []),
            ...(field.enum ?? []).map((opt) => {
              const tip = field['x-ui'].hints?.[opt] ?? (labels[opt] ? opt : undefined)
              return { value: opt, label: labels[opt] ?? opt, ...(tip ? { title: tip } : {}) }
            }),
          ]}
          onChange={(v) => onChange(name, v)}
        />
        {preset && field['x-ui'].hints?.[str] ? (
          <span data-testid={`forms-hint-${name}`} className="text-nr-sm text-nr-muted">
            {field['x-ui'].hints[str]}
          </span>
        ) : null}
      </span>
    ) : widget === 'checkbox' ? (
      <C.Checkbox id={inputId} testId={`forms-input-${name}`} checked={value === true} onChange={(v) => onChange(name, v)} />
    ) : null

  const bar = origins === false ? 'border-transparent' : origin === 'run' ? 'border-nr-accent' : origin === 'variant' ? 'border-nr-accent/50' : 'border-transparent'
  const fromTitle = origin === 'recipe' && schema['x-ui']?.base && !own ? t('originHint.recipe', { base: schema['x-ui'].base }) : undefined
  return (
    <FieldRow
      layout={short ? 'inline' : 'stack'}
      attrs={{
        'data-testid': 'forms-field',
        'data-field': name,
        'data-widget': widget,
        'data-own': own ? 'true' : undefined,
        'data-changed': changed ? 'true' : undefined,
        'data-origin': origin,
      }}
      {...(fromTitle ? { title: fromTitle } : {})}
      className={`border-l-2 ${bar}`}
      label={<Label name={name} field={field} star={star} htmlFor={inputId} required={t('required')} muted={short} />}
      tail={tail}
    >
      {control}
    </FieldRow>
  )
}

/** `model[]` — чипы с именами моделей (сырой id — в подсказке) и «добавить» тем же ModelChooser. */
function ModelList({
  tr,
  name,
  items,
  catalog,
  disabled,
  onLoad,
  onChange,
}: {
  tr: Tr
  name: string
  items: string[]
  catalog: ModelEntry[]
  disabled: boolean
  onLoad?(): void
  onChange(items: string[]): void
}): ReactNode {
  const { t } = tr
  return (
    <div className="flex flex-wrap items-center gap-nr-2">
      {items.map((id, i) => (
        <span
          key={`${i}:${id}`}
          data-testid="forms-chip"
          data-value={id}
          title={id}
          className="flex max-w-full items-center gap-nr-1 rounded-nr border border-nr-line px-nr-2 py-nr-1 text-nr-sm text-nr-fg"
        >
          <span className="min-w-0 truncate">{catalog.find((m) => m.id === id)?.name ?? prettyModel(id)}</span>
          <button
            type="button"
            data-testid="forms-chip-remove"
            title={t('removeItem')}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="shrink-0 text-nr-muted hover:text-nr-fg"
          >
            <X aria-hidden="true" strokeWidth={1.75} className={ICON} />
          </button>
        </span>
      ))}
      <tr.Model
        value=""
        onChange={(id) => id && !items.includes(id) && onChange([...items, id])}
        placeholder={t('addModel')}
        models={catalog}
        {...(onLoad ? { onOpen: onLoad } : {})}
        clearable={false}
        allowCustom
        disabled={disabled}
        testId={`forms-add-${name}`}
      />
    </div>
  )
}

