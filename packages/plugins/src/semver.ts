/**
 * Версии и диапазоны Plugin API (plugin-registry-spec §5 «совместимость»): `nrchat.api` манифеста — диапазон в
 * духе npm (`^1.2`, `~1.2.3`, `>=1 <3`, `1.x`, `*`, `a || b`), версия хоста — `MAJOR.MINOR.PATCH`. Без зависимостей
 * и без Node: этим же файлом проверяет и фронт (`@kerneldreams/plugins/semver`).
 */

export type Version = readonly [number, number, number]

/** `1.2.3`, `v1.2`, `1` → тройка; хвост `-beta`/`+build` отбрасывается. Не версия — `null`. */
export function parseVersion(text: string): Version | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][\w.-]*)?\s*$/i.exec(text)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

type Test = (v: Version) => boolean

/** Частичная версия диапазона: сколько частей задано (`1.x` — одна). */
function partial(text: string): { v: Version; parts: number } | null {
  const m = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:[-+][\w.-]*)?$/i.exec(text)
  if (!m) return null
  const raw = [m[1], m[2], m[3]]
  let parts = 0
  for (const p of raw) {
    if (p === undefined || /^[x*]$/i.test(p)) break
    parts++
  }
  const n = (i: number): number => (i < parts ? Number(raw[i]) : 0)
  return { v: [n(0), n(1), n(2)], parts }
}

const cmp = (op: string, b: Version): Test => {
  switch (op) {
    case '>':
      return (v) => compareVersions(v, b) > 0
    case '>=':
      return (v) => compareVersions(v, b) >= 0
    case '<':
      return (v) => compareVersions(v, b) < 0
    case '<=':
      return (v) => compareVersions(v, b) <= 0
    default:
      return (v) => compareVersions(v, b) === 0
  }
}

/** Верхняя граница частичной версии: `1` → `<2.0.0`, `1.2` → `<1.3.0`. */
const bump = (v: Version, parts: number): Version => (parts <= 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0])

function comparator(token: string): Test | null {
  if (token === '' || token === '*' || /^x$/i.test(token)) return () => true
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
  if (!m) return null
  const op = m[1] ?? ''
  const p = partial(m[2]!)
  if (!p) return null
  const { v, parts } = p
  if (parts === 0) return op === '<' || op === '>' ? () => false : () => true
  const lo = cmp('>=', v)
  if (op === '^') {
    // ^1.2.3 → <2; ^0.2.3 → <0.3; ^0.0.3 → <0.0.4 (как npm).
    const hi: Version = v[0] > 0 || parts === 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || parts === 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]
    return (x) => lo(x) && compareVersions(x, hi) < 0
  }
  if (op === '~') {
    const hi: Version = parts === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0]
    return (x) => lo(x) && compareVersions(x, hi) < 0
  }
  if (op === '' || op === '=') {
    if (parts === 3) return cmp('=', v)
    const hi = bump(v, parts)
    return (x) => lo(x) && compareVersions(x, hi) < 0
  }
  if (op === '>' && parts < 3) return cmp('>=', bump(v, parts))
  if (op === '<=' && parts < 3) return cmp('<', bump(v, parts))
  return cmp(op, v)
}

/** Разбор диапазона в проверку; кривой — `null`. */
export function parseRange(range: string): Test | null {
  const alts: Test[] = []
  for (const alt of range.split('||')) {
    // `1.0.0 - 2.0.0` — дефисный диапазон.
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt)
    const tokens = hyphen ? ['>=' + hyphen[1], '<=' + hyphen[2]] : alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/)
    const tests = tokens.map(comparator)
    if (tests.some((t) => t === null)) return null
    alts.push((v) => (tests as Test[]).every((t) => t(v)))
  }
  return alts.length ? (v) => alts.some((t) => t(v)) : null
}

/** Версия попадает в диапазон. Кривая версия или диапазон — `false`. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const test = parseRange(range)
  return !!v && !!test && test(v)
}

/**
 * Причина, почему плагин с `api` не подходит хосту версии `host`, — словами для списка плагинов; подходит или `api`
 * не задан — `null` (плагин без поля — круга 1, грузится).
 */
export function apiMismatch(host: string, api: string | undefined | null): string | null {
  if (api === undefined || api === null || api.trim() === '') return null
  if (!parseRange(api)) return `кривой диапазон Plugin API «${api}» в манифесте`
  return satisfies(host, api) ? null : `нужен Plugin API ${api}, у хоста ${host}`
}

/** Самая новая версия из тегов (`v1.2.0`, `1.3`); не версии — мимо. Нет — `null`. */
export function latestTag(tags: readonly string[]): string | null {
  let best: { tag: string; v: Version } | null = null
  for (const tag of tags) {
    const v = parseVersion(tag)
    if (v && (!best || compareVersions(v, best.v) > 0)) best = { tag, v }
  }
  return best?.tag ?? null
}
