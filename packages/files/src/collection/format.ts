/** Подписи колонок: размер и время по-человечески. */

/** Размер по-человечески: `1.2 МБ`. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Дата Far-колонки: сегодня — `ЧЧ:ММ`, этот год — `ДД.ММ ЧЧ:ММ`, иначе `ДД.ММ.ГГГГ`. */
export function formatTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${hm}`
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}
