/**
 * Адрес файла (file-panel-spec §1a): хост + абсолютный POSIX-путь. Без хоста — хост хаба.
 * Чистые функции над путями: без `node:path`, работают в браузере.
 */

export interface FileAddress {
  /** Хост из `envs/contours.mdz` (`mini`, `linux`); нет — хост хаба. */
  host?: string
  /** Абсолютный путь, POSIX-слэши. */
  path: string
}

/** Адрес; пустой хост — без хоста. */
export function address(path: string, host?: string): FileAddress {
  return host ? { host, path: normalizePath(path) } : { path: normalizePath(path) }
}

/** Ключ адреса для карт и сравнения: `host:path` (без хоста — `:path`). */
export function addressKey(a: FileAddress): string {
  return `${a.host ?? ''}:${a.path}`
}

/** Один и тот же хост (пустой = хост хаба = `hub`, если назван). */
export function sameHost(a: string | undefined, b: string | undefined, hub?: string): boolean {
  const n = (h: string | undefined): string => (h === undefined || h === '' ? (hub ?? '') : h)
  return n(a) === n(b)
}

/** `//a/./b/` → `/a/b`; `..` поднимается, выше корня — корень. Относительный (`~` тоже) — как есть, без лишних слэшей. */
export function normalizePath(p: string): string {
  if (p === '') return p
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(part)
  }
  const body = out.join('/')
  return abs ? `/${body}` : body
}

/** Имя последнего сегмента: `/a/b.png` → `b.png`, `/` → `/`. */
export function baseName(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  return n.slice(n.lastIndexOf('/') + 1)
}

/** Родитель: `/a/b` → `/a`, `/a` → `/`, `/` → `/`. */
export function parentPath(p: string): string {
  const n = normalizePath(p)
  if (n === '/' || !n.includes('/')) return n.startsWith('/') ? '/' : ''
  const i = n.lastIndexOf('/')
  return i === 0 ? '/' : n.slice(0, i)
}

/** Склеить и нормализовать: `joinPath('/a', 'b/c')` → `/a/b/c`. */
export function joinPath(dir: string, ...parts: string[]): string {
  return normalizePath([dir, ...parts].join('/'))
}

/** `child` лежит под `dir` (или совпадает). */
export function isUnder(child: string, dir: string): boolean {
  const c = normalizePath(child)
  const d = normalizePath(dir)
  return c === d || (d === '/' ? c.startsWith('/') : c.startsWith(`${d}/`))
}

/** Путь от `dir` до `child` (`child` под `dir`); иначе `null`. */
export function relativeTo(child: string, dir: string): string | null {
  const c = normalizePath(child)
  const d = normalizePath(dir)
  if (c === d) return ''
  if (!isUnder(c, d)) return null
  return d === '/' ? c.slice(1) : c.slice(d.length + 1)
}

/** Цепочка от корня до пути: `/a/b` → `['/', '/a', '/a/b']` (хлебные крошки). */
export function ancestors(p: string): string[] {
  const n = normalizePath(p)
  if (!n.startsWith('/')) return [n]
  const out = ['/']
  let cur = ''
  for (const part of n.split('/').filter(Boolean)) {
    cur += `/${part}`
    out.push(cur)
  }
  return out
}

/** Расширение в нижнем регистре без точки: `a.Tar.GZ` → `gz`, `.env` → `` (скрытый файл без расширения). */
export function extOf(name: string): string {
  const b = baseName(name)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}

/** Имя без расширения: `a.tar.gz` → `a.tar`. */
export function stemOf(name: string): string {
  const b = baseName(name)
  const i = b.lastIndexOf('.')
  return i <= 0 ? b : b.slice(0, i)
}
