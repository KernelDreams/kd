/**
 * Шапка mdz без nrd: корневые `$ключ: значение` до первого `## ` — манифест весов 1–2 (plugin-registry-spec §5:
 * `$title`, `$api`, `$places`…; у артефакта — `meta.mdz`). Списки — `$[a, b]` или `a, b`. Комментарии `$//` мимо.
 */

export function mdzHeader(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const tick = /^(`{3,})/.exec(line)?.[1]
    if (tick) {
      fence = fence === null ? tick : line.trim() === fence ? null : fence
      continue
    }
    if (fence !== null) continue
    if (line.startsWith('## ')) break
    const m = /^\$([\w-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    out[m[1]!] = m[2]!.trim()
  }
  return out
}

/** Список из значения шапки: `$[a, b]`, `[a, b]` или `a, b`; пусто — `[]`. */
export function headerList(value: string | undefined): string[] {
  if (!value) return []
  const inner = /^\$?\[(.*)\]$/.exec(value.trim())?.[1] ?? value
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

/** Есть ли в документе секция формы (`## $form`) — признак плагина-файла. */
export function hasFormSection(text: string): boolean {
  // Плагин-файл без параметров («удалить фон» без формы) — с местом `$places` в шапке; форма не обязательна.
  return /^## \$form\b/m.test(text) || /^\$places:\s*\S/m.test(text)
}

const oneLine = (v: string): string => v.replace(/\r?\n/g, ' ').trim()

/** Шапка mdz строками из пар (порядок сохраняется); пустые значения — мимо. */
export function renderHeader(fields: ReadonlyArray<readonly [string, string | readonly string[] | undefined]>, comment?: string): string {
  const lines: string[] = []
  if (comment) for (const c of comment.split('\n')) lines.push('$// ' + c)
  for (const [k, v] of fields) {
    if (v === undefined) continue
    const text = typeof v === 'string' ? oneLine(v) : v.length ? '$[' + v.map(oneLine).join(', ') + ']' : ''
    if (text) lines.push('$' + k + ': ' + text)
  }
  return lines.join('\n') + '\n'
}
