// Перевод описаний пробы с блоков row/tabs на атрибуты $row/$tab (universal-editor-spec §2).
// Общий для скрипта фикстур (mdz, JSON, YAML) и загрузчика теста (HTML).

/** Дерево узлов (`node` или `kind`): row → `row: rN` у детей, tabs → `tab: <id секции>` у секций. */
export function rowTabsTree(nodes, counter = { n: 0 }) {
  const out = []
  for (const n of nodes ?? []) {
    const kind = n.node ?? n.kind
    const kids = rowTabsTree(n.children, counter)
    if (kind === 'row') {
      const row = `r${++counter.n}`
      for (const c of kids) out.push({ ...c, row })
    } else if (kind === 'tabs') {
      for (const c of kids) out.push((c.node ?? c.kind) === 'section' ? { ...c, tab: c.id } : c)
    } else out.push(n.children ? { ...n, children: kids } : n)
  }
  return out
}

const HEAD = /^(#{2,6}) \$([A-Za-z_][\w-]*)(?: +(\S.*))?\s*$/

/** mdz: заголовки `### $row` / `### $tabs` снимаются, потомки поднимаются на уровень, детям — атрибут. */
export function rowTabsMdz(text) {
  let lines = text.split('\n')
  let n = 0
  for (;;) {
    const i = lines.findIndex((l) => {
      const m = HEAD.exec(l)
      return m && (m[2] === 'row' || m[2] === 'tabs')
    })
    if (i < 0) break
    const [, hashes, kind] = HEAD.exec(lines[i])
    const L = hashes.length
    let j = i + 1
    while (j < lines.length) {
      const m = HEAD.exec(lines[j])
      if (m && m[1].length <= L) break
      j++
    }
    const row = `r${++n}`
    const body = []
    for (let k = i + 1; k < j; k++) {
      const m = HEAD.exec(lines[k])
      if (!m) {
        body.push(lines[k])
        continue
      }
      const level = m[1].length
      body.push(lines[k].replace(/^#+/, '#'.repeat(level - 1)))
      if (level === L + 1) {
        if (kind === 'row') body.push(`$row: ${row}`)
        else if (m[2] === 'section') body.push(`$tab: ${m[3]}`)
      }
    }
    lines = [...lines.slice(0, i), ...body, ...lines.slice(j)]
    // Пустая строка после снятого заголовка — одна.
    if (lines[i] === '' && lines[i - 1] === '') lines.splice(i, 1)
  }
  return lines.join('\n')
}
