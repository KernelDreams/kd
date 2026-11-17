/** Маски Far и быстрый поиск по началу имени — для любой коллекции. */

import type { Item } from './item.js'

/**
 * Маска Far: несколько через `;` или `,`, исключения после `|` (`*.png;*.jpg|tmp*`).
 * `*` — любая строка, `?` — один символ; без регистра. Маска без `*`/`?`/`.` — подстрока
 * (`foo` = `*foo*`), как фильтр по имени.
 */
export function compileMask(mask: string): (name: string) => boolean {
  const [incl = '', excl = ''] = mask.split('|', 2)
  const parts = (s: string): RegExp[] =>
    s
      .split(/[;,]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((m) => {
        const glob = /[*?.]/.test(m) ? m : `*${m}*`
        const re = glob.replace(/[\\^$+()[\]{}]/g, '\\$&').replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')
        return new RegExp(`^${re}$`, 'i')
      })
  const yes = parts(incl)
  const no = parts(excl)
  return (name) => (yes.length === 0 || yes.some((r) => r.test(name))) && !no.some((r) => r.test(name))
}

/**
 * Быстрый поиск Far (Alt+буквы, у нас — просто набор в панели): первая запись, чьё имя
 * начинается с `prefix` (без регистра), начиная с `from` и по кругу; нет — подстрока; нет — `-1`.
 */
export function quickFind(entries: readonly Pick<Item, 'name'>[], prefix: string, from = 0): number {
  if (prefix === '' || entries.length === 0) return -1
  const p = prefix.toLowerCase()
  const n = entries.length
  for (const test of [(s: string) => s.startsWith(p), (s: string) => s.includes(p)]) {
    for (let i = 0; i < n; i++) {
      const k = (from + i) % n
      if (test(entries[k]!.name.toLowerCase())) return k
    }
  }
  return -1
}
