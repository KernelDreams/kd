/**
 * Цвет CSS для конвертеров (skin-convert-spec §1): темы Obsidian считают палитру в браузере —
 * `oklch(from var(--x) l c h / 50%)`, `lch()`, `color-mix()`, `hsl(var(--h), …)`. Чтобы вывести
 * недостающие токены и проверить контраст, значение надо вычислить здесь. `evalColor` понимает
 * hex, именованные, `rgb/hsl/hwb`, `lab/lch/oklab/oklch` (CSS Color 4), относительный синтаксис
 * `from` (CSS Color 5) и `color-mix(in srgb|oklab|oklch|lab|lch|hsl, …)`, `calc()` в каналах.
 * Не смог — `null`: конвертер оставляет выражение как есть (браузер посчитает), а для вывода
 * палитры берёт запасной цвет.
 */

import { parseColor, type Rgba } from '../readability.js'

type Space = 'srgb' | 'hsl' | 'hwb' | 'lab' | 'lch' | 'oklab' | 'oklch'
/** Цвет в пространстве: три канала и альфа. */
interface Color {
  space: Space
  c: [number, number, number]
  a: number
}

const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500',
  purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', navy: '#000080', teal: '#008080',
  olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb',
  brown: '#a52a2a', gold: '#ffd700', beige: '#f5f5dc', ivory: '#fffff0', khaki: '#f0e68c', crimson: '#dc143c', coral: '#ff7f50',
  salmon: '#fa8072', tomato: '#ff6347', indigo: '#4b0082', violet: '#ee82ee', orchid: '#da70d6', tan: '#d2b48c', wheat: '#f5deb3',
  linen: '#faf0e6', snow: '#fffafa', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969', slategray: '#708090', darkslategray: '#2f4f4f',
  steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff', skyblue: '#87ceeb', midnightblue: '#191970', seagreen: '#2e8b57',
  forestgreen: '#228b22', darkgreen: '#006400', firebrick: '#b22222', darkred: '#8b0000', chocolate: '#d2691e', sienna: '#a0522d',
  peru: '#cd853f', goldenrod: '#daa520', darkorange: '#ff8c00', hotpink: '#ff69b4', plum: '#dda0dd', lavender: '#e6e6fa',
  mintcream: '#f5fffa', honeydew: '#f0fff0', aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff', floralwhite: '#fffaf0', oldlace: '#fdf5e6',
  antiquewhite: '#faebd7', papayawhip: '#ffefd5', blanchedalmond: '#ffebcd', bisque: '#ffe4c4', moccasin: '#ffe4b5', cornsilk: '#fff8dc',
  seashell: '#fff5ee', lemonchiffon: '#fffacd', rebeccapurple: '#663399', transparent: '#00000000',
}

// ────────────────────────────────────────────────────────────────────────────
// Пространства → sRGB
// ────────────────────────────────────────────────────────────────────────────

const toLin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
const fromLin = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
const D = Math.PI / 180

function hslToSrgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

// CIE Lab (D50) ⇄ линейный sRGB (через XYZ D50, адаптация Брэдфорда).
const KAPPA = 24389 / 27
const EPS = 216 / 24389
const WD50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const x = (fx ** 3 > EPS ? fx ** 3 : (116 * fx - 16) / KAPPA) * WD50[0]!
  const y = (L > KAPPA * EPS ? fy ** 3 : L / KAPPA) * WD50[1]!
  const z = (fz ** 3 > EPS ? fz ** 3 : (116 * fz - 16) / KAPPA) * WD50[2]!
  return [3.1341359569958707 * x - 1.6173863321612538 * y - 0.4906619460083532 * z, -0.978795502912089 * x + 1.916254567259524 * y + 0.03344273116131949 * z, 0.07195537988411677 * x - 0.2289768264158322 * y + 1.405386058324125 * z]
}

function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const x = (0.436065742824811 * r + 0.3851514688337912 * g + 0.14307845442264197 * b) / WD50[0]!
  const y = (0.22249319175623702 * r + 0.7168870538238823 * g + 0.06061979053616537 * b) / WD50[1]!
  const z = (0.013923904500943465 * r + 0.09708128566574634 * g + 0.7140993584005155 * b) / WD50[2]!
  const f = (t: number): number => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

const polar = (L: number, c: number, h: number): [number, number, number] => [L, c * Math.cos(h * D), c * Math.sin(h * D)]
const unpolar = (L: number, a: number, b: number): [number, number, number] => {
  const c = Math.hypot(a, b)
  let h = Math.atan2(b, a) / D
  if (h < 0) h += 360
  return [L, c, c < 1e-6 ? 0 : h]
}

/** Цвет → sRGB 0…1 (без обрезки). */
function toSrgb(x: Color): [number, number, number] {
  const [p, q, r] = x.c
  switch (x.space) {
    case 'srgb':
      return [p, q, r]
    case 'hsl':
      return hslToSrgb(p, q, r)
    case 'hwb': {
      if (q + r >= 1) return [q / (q + r), q / (q + r), q / (q + r)]
      const [a, b, c] = hslToSrgb(p, 1, 0.5)
      return [a * (1 - q - r) + q, b * (1 - q - r) + q, c * (1 - q - r) + q]
    }
    case 'oklab':
      return oklabToLinear(p, q, r).map(fromLin) as [number, number, number]
    case 'oklch':
      return oklabToLinear(...polar(p, q, r)).map(fromLin) as [number, number, number]
    case 'lab':
      return labToLinear(p, q, r).map(fromLin) as [number, number, number]
    case 'lch':
      return labToLinear(...polar(p, q, r)).map(fromLin) as [number, number, number]
  }
}

/** sRGB 0…1 → пространство. */
function fromSrgb(rgb: [number, number, number], space: Space): [number, number, number] {
  const [r, g, b] = rgb
  switch (space) {
    case 'srgb':
      return [r, g, b]
    case 'hsl':
    case 'hwb': {
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const d = max - min
      let h = 0
      if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      h = (h * 60 + 360) % 360
      if (space === 'hwb') return [h, min, 1 - max]
      const l = (max + min) / 2
      return [h, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l]
    }
    case 'oklab':
      return linearToOklab(toLin(r), toLin(g), toLin(b))
    case 'oklch':
      return unpolar(...linearToOklab(toLin(r), toLin(g), toLin(b)))
    case 'lab':
      return linearToLab(toLin(r), toLin(g), toLin(b))
    case 'lch':
      return unpolar(...linearToLab(toLin(r), toLin(g), toLin(b)))
  }
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
const toRgba = (x: Color): Rgba => {
  const [r, g, b] = toSrgb(x)
  return { r: clamp01(r) * 255, g: clamp01(g) * 255, b: clamp01(b) * 255, a: clamp01(x.a) }
}

// ────────────────────────────────────────────────────────────────────────────
// Разбор
// ────────────────────────────────────────────────────────────────────────────

/** Аргументы функции верхнего уровня: пробелы, запятые и `/` как отдельные лексемы. */
function tokens(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let level = 0
  const push = (): void => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const ch of s) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (level === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === ',' || ch === '/')) {
      push()
      if (ch === ',' || ch === '/') out.push(ch)
      continue
    }
    cur += ch
  }
  push()
  return out
}

/** `calc()`-выражение над числами, процентами (как доли `pct`) и ключами канала. */
function calc(expr: string, keys: Readonly<Record<string, number>>, pct: number): number | null {
  const src = expr.replace(/^calc\(/i, '(')
  let i = 0
  const ws = (): void => {
    while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n') i++
  }
  const atom = (): number | null => {
    ws()
    if (src[i] === '(') {
      i++
      const v = sum()
      ws()
      if (src[i] !== ')') return null
      i++
      return v
    }
    if (src.slice(i, i + 5).toLowerCase() === 'calc(') {
      i += 4
      return atom()
    }
    if (src[i] === '-' || src[i] === '+') {
      const sign = src[i] === '-' ? -1 : 1
      i++
      const v = atom()
      return v === null ? null : sign * v
    }
    const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)(%|deg|turn|rad)?/i.exec(src.slice(i))
    if (m) {
      i += m[0].length
      const n = Number(m[1])
      const unit = (m[2] ?? '').toLowerCase()
      return unit === '%' ? n * pct : unit === 'turn' ? n * 360 : unit === 'rad' ? n / D : n
    }
    const k = /^[a-z]+/i.exec(src.slice(i))
    if (k && k[0].toLowerCase() in keys) {
      i += k[0].length
      return keys[k[0].toLowerCase()]!
    }
    return null
  }
  const prod = (): number | null => {
    let v = atom()
    for (;;) {
      ws()
      const op = src[i]
      if (v === null || (op !== '*' && op !== '/')) return v
      i++
      const r = atom()
      if (r === null) return null
      v = op === '*' ? v * r : v / r
    }
  }
  const sum = (): number | null => {
    let v = prod()
    for (;;) {
      ws()
      const op = src[i]
      if (v === null || (op !== '+' && op !== '-')) return v
      i++
      const r = prod()
      if (r === null) return null
      v = op === '+' ? v + r : v - r
    }
  }
  const v = sum()
  ws()
  return v !== null && i >= src.length && Number.isFinite(v) ? v : null
}

/** Масштаб «100%» канала пространства (CSS Color 4). */
const PCT: Record<Space, [number, number, number]> = {
  srgb: [1, 1, 1],
  hsl: [1, 0.01, 0.01],
  hwb: [1, 0.01, 0.01],
  lab: [1, 1.25, 1.25],
  lch: [1, 1.5, 1],
  oklab: [0.01, 0.004, 0.004],
  oklch: [0.01, 0.004, 1],
}
const KEYS: Record<Space, [string, string, string]> = {
  srgb: ['r', 'g', 'b'],
  hsl: ['h', 's', 'l'],
  hwb: ['h', 'w', 'b'],
  lab: ['l', 'a', 'b'],
  lch: ['l', 'c', 'h'],
  oklab: ['l', 'a', 'b'],
  oklch: ['l', 'c', 'h'],
}

/** Число канала: для rgb — 0…255 в 0…1, hsl s/l — проценты в доли, lab L — 0…100. */
function channel(raw: string, space: Space, idx: number, keys: Readonly<Record<string, number>>): number | null {
  if (raw.toLowerCase() === 'none') return 0
  // Процент: rgb 100% = 1; hsl/hwb s,l 100% = 1; lab L 100% = 100; oklab L 100% = 1.
  // В относительном синтаксисе ключи — в «родных» числах (rgb 0…255, hsl s/l 0…100): проценты тоже.
  const rel = Boolean(keys.__rel)
  let pct = PCT[space][idx]!
  if (space === 'srgb') pct = rel ? 2.55 : 0.01
  if ((space === 'lab' || space === 'lch') && idx === 0) pct = 1
  if ((space === 'hsl' || space === 'hwb') && idx > 0) pct = rel ? 1 : 0.01
  // Голое число: rgb — 0…255; hsl/hwb s,l — проценты (числом); остальное — как есть.
  let v = calc(raw, keys, pct)
  if (v === null) return null
  const bare = /^-?[\d.]+$/.test(raw)
  if (bare && space === 'srgb' && !rel) v = v / 255
  if (bare && (space === 'hsl' || space === 'hwb') && idx > 0 && !rel) v = v / 100
  return v
}

/** Значение альфы: число, процент, ключ `alpha`. */
function alphaOf(raw: string | undefined, keys: Readonly<Record<string, number>>): number | null {
  if (raw === undefined) return keys.alpha ?? 1
  return calc(raw, keys, 0.01)
}

function parse(value: string, depth = 0): Color | null {
  if (depth > 12) return null
  const v = value.trim().toLowerCase()
  const named = NAMED[v]
  if (named) return parse(named, depth + 1)
  if (v.startsWith('#')) {
    const c = parseColor(v)
    return c ? { space: 'srgb', c: [c.r / 255, c.g / 255, c.b / 255], a: c.a } : null
  }
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(v)
  if (!fn) return null
  const name = fn[1]!
  const body = fn[2]!
  if (name === 'color-mix') return colorMix(body, depth)
  const space: Space | null = name === 'rgb' || name === 'rgba' ? 'srgb' : name === 'hsl' || name === 'hsla' ? 'hsl' : (['hwb', 'lab', 'lch', 'oklab', 'oklch'] as const).find((s) => s === name) ?? null
  if (!space) return null
  let t = tokens(body)
  let keys: Record<string, number> = {}
  if (t[0] === 'from') {
    const origin = parse(t[1] ?? '', depth + 1)
    if (!origin) return null
    const rgb = toSrgb(origin)
    const ch = fromSrgb(rgb, space)
    // Ключи канала в «родных» единицах: rgb — 0…255, hsl s/l — 0…100 (как числа CSS), lab — как есть.
    const scale = space === 'srgb' ? [255, 255, 255] : space === 'hsl' || space === 'hwb' ? [1, 100, 100] : [1, 1, 1]
    keys = { __rel: 1, alpha: origin.a }
    KEYS[space].forEach((k, i) => (keys[k] = ch[i]! * scale[i]!))
    t = t.slice(2)
    const parts = t.filter((x) => x !== ',')
    const slash = parts.indexOf('/')
    const main = slash < 0 ? parts : parts.slice(0, slash)
    if (main.length !== 3) return null
    const raw = main.map((p, i) => channel(p, space, i, keys))
    if (raw.some((x) => x === null)) return null
    const back = raw.map((x, i) => x! / scale[i]!) as [number, number, number]
    const a = alphaOf(slash < 0 ? undefined : parts[slash + 1], keys)
    return a === null ? null : { space, c: back, a }
  }
  const parts = t.filter((x) => x !== ',')
  const slash = parts.indexOf('/')
  let main = slash < 0 ? parts : parts.slice(0, slash)
  let alphaRaw = slash < 0 ? undefined : parts[slash + 1]
  if (main.length === 4 && slash < 0) {
    alphaRaw = main[3]
    main = main.slice(0, 3)
  }
  if (main.length !== 3) return null
  const c = main.map((p, i) => channel(p, space, i, {}))
  if (c.some((x) => x === null)) return null
  const a = alphaOf(alphaRaw, {})
  return a === null ? null : { space, c: c as [number, number, number], a }
}

function colorMix(body: string, depth: number): Color | null {
  const parts: string[] = []
  let level = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (ch === ',' && level === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  parts.push(cur.trim())
  if (parts.length !== 3) return null
  const m = /^in\s+([a-z-]+)/.exec(parts[0]!)
  const space = ((): Space | null => {
    const s = m?.[1]
    if (s === 'srgb' || s === 'srgb-linear') return 'srgb'
    return (['hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch'] as const).find((x) => x === s) ?? null
  })()
  if (!space) return null
  const side = (s: string): { c: Color | null; p: number | null } => {
    const pm = /\s(-?[\d.]+)%$/.exec(s) ?? /^(-?[\d.]+)%\s/.exec(s)
    const color = pm ? s.replace(pm[0], ' ').trim() : s
    return { c: parse(color, depth + 1), p: pm ? Number(pm[1]) / 100 : null }
  }
  const A = side(parts[1]!)
  const B = side(parts[2]!)
  if (!A.c || !B.c) return null
  let pa = A.p ?? (B.p !== null ? 1 - B.p : 0.5)
  let pb = B.p ?? 1 - pa
  const sum = pa + pb
  if (sum <= 0) return null
  const alphaMul = Math.min(1, sum)
  pa /= sum
  pb /= sum
  const a = fromSrgb(toSrgb(A.c), space)
  const b = fromSrgb(toSrgb(B.c), space)
  const hueIdx: number = space === 'hsl' || space === 'hwb' ? 0 : space === 'lch' || space === 'oklch' ? 2 : (-1 as number)
  const out = a.map((x, i) => {
    if (i === hueIdx) {
      let d = b[i]! - x
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return (x + d * pb + 360) % 360
    }
    return x * pa + b[i]! * pb
  }) as [number, number, number]
  return { space, c: out, a: (A.c.a * pa + B.c.a * pb) * alphaMul }
}

/** Вычислить цвет CSS (без `var()` — их подставляет вызывающий). Не смог — null. */
export function evalColor(value: string): Rgba | null {
  const simple = parseColor(value)
  if (simple) return simple
  const c = parse(value)
  return c ? toRgba(c) : null
}
