/**
 * Правила читаемости скина (skin-spec §3.1): минимум кегля и контраст
 * статусов. Без IO и без DOM — чистые функции над значениями переменных:
 * их зовут валидатор (кегль), `compileSkin` (контраст — предупреждением) и
 * тест скинов (контраст — строго, по всем скинам студии и встроенным nrchat).
 *
 *   - кегль: ступени `--nr-text-*` в `rem`/`px`, при 100% (корень 16px) —
 *     не мельче `TEXT_MIN_PX` (13px), базовый текст (`sm`, `body`) — не мельче
 *     `TEXT_BASE_MIN_PX` (15px);
 *   - контраст: `--nr-fg`, `--nr-muted`, `--nr-accent`, `--nr-ok`, `--nr-error`
 *     к `--nr-bg` и `--nr-surface` — не ниже `CONTRAST_MIN` (4.5:1, WCAG AA),
 *     в каждом заявленном режиме. Полупрозрачный цвет кладётся на фон.
 */

/** Корень документа при «размере текста» 100%. */
export const ROOT_PX = 16
/** Самая мелкая ступень текста — не мельче (px при 100%). */
export const TEXT_MIN_PX = 13
/** Базовый текст интерфейса и тело реплики — не мельче (px при 100%). */
export const TEXT_BASE_MIN_PX = 15
/** Контраст статусов и текста к фону (WCAG AA для обычного текста). */
export const CONTRAST_MIN = 4.5

/** Ступени кегля и их минимум. */
export const TEXT_MINIMUMS: Readonly<Record<string, number>> = {
  '--nr-text-xs': TEXT_MIN_PX,
  '--nr-text-sm': TEXT_BASE_MIN_PX,
  '--nr-text-md': TEXT_MIN_PX,
  '--nr-text-lg': TEXT_MIN_PX,
  '--nr-text-body': TEXT_BASE_MIN_PX,
}

/** Текст и статусы, которые обязаны читаться… */
export const CONTRAST_FG: readonly string[] = ['--nr-fg', '--nr-muted', '--nr-accent', '--nr-ok', '--nr-error']
/** …на этих фонах. */
export const CONTRAST_BG: readonly string[] = ['--nr-bg', '--nr-surface', '--nr-chrome']

/** Кегль в px при корне 16px: `0.9375rem` → 15, `14px` → 14; иначе `null` (calc, var, em). */
export function textPx(value: string): number | null {
  const m = /^\s*(\d*\.?\d+)\s*(rem|px)\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return m[2]!.toLowerCase() === 'rem' ? n * ROOT_PX : n
}

/** Замечание о кегле: `null` — в порядке (или значение не проверить — см. `textPx`). */
export function checkTextSize(name: string, value: string): { message: string; hint: string } | null {
  const min = TEXT_MINIMUMS[name]
  if (min === undefined) return null
  const px = textPx(value)
  if (px === null || px + 1e-6 >= min) return null
  return {
    message: `${name}: ${value} — ${round(px)}px при 100%, мельче ${min}px`,
    hint:
      min === TEXT_BASE_MIN_PX
        ? `базовый текст (--nr-text-sm, --nr-text-body) — не мельче ${TEXT_BASE_MIN_PX}px (${TEXT_BASE_MIN_PX / ROOT_PX}rem); мельче хочет пользователь — «размер текста» 85–90%`
        : `ступени текста — не мельче ${TEXT_MIN_PX}px (${TEXT_MIN_PX / ROOT_PX}rem)`,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Цвет
// ────────────────────────────────────────────────────────────────────────────

/** sRGB 0…255 и альфа 0…1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const round = (n: number): number => Math.round(n * 100) / 100

function channel(raw: string, max = 255): number {
  const s = raw.trim()
  if (s.endsWith('%')) return (Number(s.slice(0, -1)) / 100) * max
  return Number(s)
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1
  const s = raw.trim()
  return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

const NAMED: Readonly<Record<string, Rgba>> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
}

/**
 * Цвет из значения переменной: `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()` (через
 * запятые и через пробел с `/ альфа`), `hsl()/hsla()`, `oklch()`, `var(--nr-…)` из `vars`,
 * `color-mix(in oklch|oklab|srgb, A p%, B)` (смесь — в OKLab: для контраста оттенок по дуге не важен).
 * Остальное (`oklch(from …)`, имена кроме black/white) — `null`: проверка его пропускает и говорит об этом.
 */
export function parseColor(value: string, vars: Readonly<Record<string, string>> = {}, depth = 0): Rgba | null {
  const v = value.trim().toLowerCase()
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/.exec(v)
  if (ref) {
    if (depth > 8) return null
    const target = vars[ref[1]!] ?? ref[2]
    return target === undefined ? null : parseColor(target, vars, depth + 1)
  }
  if (NAMED[v]) return NAMED[v]!
  const mix = /^color-mix\(\s*in\s+(oklch|oklab|srgb)\s*,(.*)\)$/.exec(v)
  if (mix) return colorMix(mix[1]!, mix[2]!, vars, depth)
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(v)
  if (ok) {
    const l = ok[1]!.endsWith('%') ? Number(ok[1]!.slice(0, -1)) / 100 : Number(ok[1])
    const c = ok[2]!.endsWith('%') ? (Number(ok[2]!.slice(0, -1)) / 100) * 0.4 : Number(ok[2])
    const h = (Number(ok[3]) * Math.PI) / 180
    return fromOklab([l, c * Math.cos(h), c * Math.sin(h)], alpha(ok[4]))
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1]!
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16))
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 }
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
    }
    return null
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(v)
  if (!fn) return null
  const body = fn[2]!.trim()
  let parts: string[]
  let a: string | undefined
  if (body.includes(',')) {
    parts = body.split(',').map((x) => x.trim())
    if (parts.length === 4) a = parts.pop()
  } else {
    const [main, al] = body.split('/')
    parts = main!.trim().split(/\s+/)
    a = al?.trim()
  }
  if (parts.length !== 3) return null
  let rgb: [number, number, number]
  if (fn[1]!.startsWith('rgb')) rgb = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)]
  else {
    const h = Number(parts[0]!.replace(/deg$/, ''))
    rgb = hslToRgb(h, channel(parts[1]!, 1), channel(parts[2]!, 1))
  }
  const out = { r: rgb[0], g: rgb[1], b: rgb[2], a: alpha(a) }
  return [out.r, out.g, out.b, out.a].every(Number.isFinite) ? out : null
}

/** Аргументы верхнего уровня через запятую (скобки внутри `var(…)` не режутся). */
function splitTop(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

function colorMix(space: string, body: string, vars: Readonly<Record<string, string>>, depth: number): Rgba | null {
  const args = splitTop(body)
  if (args.length !== 2) return null
  const parse = (arg: string): { c: Rgba | null; p: number | null } => {
    const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(arg)!
    return { c: parseColor(m[1]!, vars, depth + 1), p: m[2] === undefined ? null : Number(m[2]) / 100 }
  }
  const a = parse(args[0]!)
  const b = parse(args[1]!)
  if (!a.c || !b.c) return null
  const pa = a.p ?? (b.p === null ? 0.5 : 1 - b.p)
  const t = 1 - pa
  const al = a.c.a * pa + b.c.a * t
  if (space === 'srgb') return { r: a.c.r * pa + b.c.r * t, g: a.c.g * pa + b.c.g * t, b: a.c.b * pa + b.c.b * t, a: al }
  const la = toOklab(a.c)
  const lb = toOklab(b.c)
  return fromOklab([la[0] * pa + lb[0] * t, la[1] * pa + lb[1] * t, la[2] * pa + lb[2] * t], al)
}

const toLin = (x: number): number => {
  const s = x / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const fromLin = (x: number): number => 255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))

function toOklab(c: Rgba): [number, number, number] {
  const [r, g, b] = [toLin(c.r), toLin(c.g), toLin(c.b)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function fromOklab([L, A, B]: [number, number, number], a: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return {
    r: fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  }
}

/** Положить цвет на непрозрачный фон. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}

function luminance(c: Rgba): number {
  const lin = (x: number): number => {
    const s = x / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** Контраст WCAG 2.x двух цветов; полупрозрачный передний — поверх заднего. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const back = bg.a < 1 ? over(bg, NAMED.white!) : bg
  const front = fg.a < 1 ? over(fg, back) : fg
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Пара «текст на фоне», которая не читается (или не проверена). */
export interface ContrastIssue {
  mode?: 'light' | 'dark'
  fg: string
  bg: string
  /** Контраст; `null` — цвет не разобран (color-mix, oklch…). */
  ratio: number | null
  message: string
  hint?: string
}

/**
 * Контраст текста и статусов к фонам одного режима (`vars` — итоговые
 * переменные режима, как `modeVars`). Нет пары переменных — пропуск (полноту
 * палитры проверяет `compileSkin`).
 */
export function checkContrast(vars: Readonly<Record<string, string>>, mode?: 'light' | 'dark'): ContrastIssue[] {
  const issues: ContrastIssue[] = []
  const where = mode ? ` (${mode})` : ''
  for (const bgName of CONTRAST_BG) {
    const bgRaw = vars[bgName]
    if (bgRaw === undefined) continue
    const bg = parseColor(bgRaw, vars)
    for (const fgName of CONTRAST_FG) {
      const fgRaw = vars[fgName]
      if (fgRaw === undefined) continue
      const fg = parseColor(fgRaw, vars)
      if (!fg || !bg) {
        issues.push({
          ...(mode ? { mode } : {}),
          fg: fgName,
          bg: bgName,
          ratio: null,
          message: `контраст ${fgName} к ${bgName}${where} не проверить: «${!fg ? fgRaw : bgRaw}»`,
          hint: 'палитра — #hex, rgb() или hsl(); color-mix и oklch проверка не считает',
        })
        continue
      }
      const ratio = contrastRatio(fg, bg)
      if (ratio + 1e-9 < CONTRAST_MIN) {
        issues.push({
          ...(mode ? { mode } : {}),
          fg: fgName,
          bg: bgName,
          ratio: round(ratio),
          message: `контраст ${fgName} к ${bgName}${where} ${round(ratio)}:1 — меньше ${CONTRAST_MIN}:1`,
          hint: `тот же оттенок ${luminance(bg.a < 1 ? over(bg, NAMED.white!) : bg) > 0.18 ? 'темнее' : 'светлее'}: статус и текст читаются на фоне и на подложке панелей`,
        })
      }
    }
  }
  // Свой фон тулбара: на нём читаются его текст и вторичный текст (нет своих — общие).
  const tbRaw = vars['--nr-toolbar-bg']
  if (tbRaw !== undefined && !/var\(\s*--nr-chrome\s*\)/.test(tbRaw)) {
    const tb = parseColor(tbRaw, vars)
    for (const [own, common] of [
      ['--nr-toolbar-fg', '--nr-fg'],
      ['--nr-toolbar-muted', '--nr-muted'],
    ] as const) {
      const name = vars[own] !== undefined ? own : common
      const raw = vars[name]
      const fg = raw !== undefined ? parseColor(raw, vars) : null
      if (!fg || !tb) continue
      const ratio = contrastRatio(fg, tb)
      if (ratio + 1e-9 < CONTRAST_MIN)
        issues.push({
          ...(mode ? { mode } : {}),
          fg: name,
          bg: '--nr-toolbar-bg',
          ratio: round(ratio),
          message: `контраст ${name} к --nr-toolbar-bg${where} ${round(ratio)}:1 — меньше ${CONTRAST_MIN}:1`,
          hint: 'тёмному верху — свои --nr-toolbar-fg и --nr-toolbar-muted',
        })
    }
  }
  return issues
}

// ── иконки (icons-spec §2) ─────────────────────────────────────────────────

/** Толщина линии одноцветного пакета по способу (сетка 24) — как в `modeIcon.css` nrchat. */
export const ICON_STROKE_DEFAULT: Readonly<Record<string, number>> = { outline: 2.4, plate: 2.25, duotone: 2 }
/** Порог тонкого контура: 2.33 в сетке 24 ≈ 1.75px при иконке 18px. */
export const ICON_STROKE_MIN = 2.33
/** Встроенные одноцветные пакеты: линтер знает их род без папки. */
const MONO_PACKS = new Set(['lucide'])
/** Встроенные многоцветные пакеты: `office` (SVG Flat Color), `office2000` (растр). */
const COLOR_PACKS = new Set(['office', 'office2000'])
/** Наименьшая иконка тулбара у многоцветного пакета, px. */
export const ICON_BAR_MIN = 24

const px = (v: string | undefined): number | undefined => {
  const m = v?.trim().match(/^(\d+(?:\.\d+)?)px$/)
  return m ? Number(m[1]) : undefined
}

/**
 * Растровая иконка пакета: исходник мельче 2× показа на экране с плотностью 2 мылится — предупреждение.
 * `shown` — наибольший размер показа, px (тулбар — `--nr-icon-bar`, 32).
 */
export function checkRasterIcon(icon: { name: string; width: number; height: number }, shown = 32): { message: string; hint: string } | null {
  const side = Math.min(icon.width, icon.height)
  if (side >= shown * 2) return null
  return { message: `иконка ${icon.name}: исходник ${icon.width}×${icon.height} мельче 2× показа ${shown}px`, hint: `растр пакета — от ${shown * 2}px по меньшей стороне (лучше ${shown * 3}px)` }
}

const keyword = (v: string | undefined): string | undefined => {
  const s = v?.trim().replace(/^['"]|['"]$/g, '')
  return s ? s : undefined
}

/**
 * Читаемость иконок скина (icons-spec §2) — предупреждения, не ошибки. `vars` — итоговые переменные режима.
 * Одноцветный пакет контуром с тонкой линией; контур при сером эталоне записи — соседи различаются только формой.
 * Свой пакет (не встроенный) — род неизвестен линтеру, считается одноцветным: проверка та же.
 */
export function checkIcons(vars: Readonly<Record<string, string>>, opts: { colorPacks?: readonly string[] } = {}): Array<{ message: string; hint: string }> {
  const out: Array<{ message: string; hint: string }> = []
  const pack = keyword(vars['--nr-icon-pack']) ?? 'lucide'
  const style = keyword(vars['--nr-icon-style']) ?? 'plate'
  const color = COLOR_PACKS.has(pack) || (opts.colorPacks ?? []).includes(pack)
  if (color && !MONO_PACKS.has(pack)) {
    // Картинка-предмет мельче 24 px в тулбаре не читается (значок — не мельче 32).
    const bar = px(vars['--nr-icon-bar'])
    if (bar !== undefined && bar < ICON_BAR_MIN) {
      out.push({ message: `--nr-icon-bar: ${bar}px у многоцветного пакета ${pack}`, hint: `картинка-предмет мельче ${ICON_BAR_MIN}px не узнаётся краем глаза — 32px, как у базы` })
    }
    return out
  }
  if (style !== 'outline' && style !== 'plate' && style !== 'duotone') {
    out.push({ message: `--nr-icon-style: ${style}`, hint: 'способ одноцветного пакета: outline, plate или duotone' })
    return out
  }
  if (style !== 'outline') return out
  const raw = vars['--nr-icon-stroke']
  const stroke = raw !== undefined && raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : ICON_STROKE_DEFAULT.outline!
  if (stroke + 1e-9 < ICON_STROKE_MIN) {
    out.push({
      message: `тонкий контур иконок: ${pack} · outline, линия ${stroke} в сетке 24 (≈${round((stroke * 18) / 24)}px)`,
      hint: `одноцветный лайнарт тоньше ${ICON_STROKE_MIN} не читается краем глаза — толще линия, способ plate или многоцветный пакет`,
    })
  }
  const accent = vars['--nr-record-accent'] ?? vars['--nr-accent']
  const rgb = accent ? parseColor(accent, vars) : null
  if (rgb && Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 12) {
    out.push({
      message: 'иконки тулбара одного цвета: outline при сером --nr-record-accent',
      hint: 'соседние иконки различаются только формой — эталону записи нужна насыщенность, или способ plate / duotone',
    })
  }
  return out
}
