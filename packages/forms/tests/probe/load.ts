// Загрузка фикстуры пробы в вход parseEditor: mdz и JSON — текстом, YAML — объектом,
// HTML (формат пробы, пакетом не поддержан) — деревом по разметке `data-*`, как валидатор пробы.

import { readFileSync } from 'node:fs'
import { parseDocument } from 'htmlparser2'
import YAML from 'yaml'
import { rowTabsTree } from './row-tabs.mjs'

type El = { type: string; name: string; data?: string; attribs: Record<string, string>; children?: El[] }

function fromHtml(text: string): object {
  const dom = parseDocument(text, { lowerCaseAttributeNames: true, recognizeSelfClosing: true }) as unknown as El
  const els = (n: El): El[] => (n.children ?? []).filter((c) => c.type === 'tag' || c.type === 'script' || c.type === 'style')
  const textOf = (n: El): string => (n.children ?? []).map((c) => (c.type === 'text' ? c.data ?? '' : textOf(c))).join('')
  const find = (n: El, pred: (e: El) => boolean): El | null => {
    for (const c of els(n)) {
      if (pred(c)) return c
      const r = find(c, pred)
      if (r) return r
    }
    return null
  }
  const root = find(dom, (e) => e.name === 'nr-editor')
  if (!root) throw new Error('нет <nr-editor>')
  const sc = find(root, (e) => e.name === 'script' && e.attribs.type === 'application/schema+json')
  const json = (e: El, k: string): unknown => (e.attribs[k] === undefined ? undefined : JSON.parse(e.attribs[k]!))
  const labelOf = (e: El, parent?: El): string | undefined => e.attribs['data-label'] ?? (parent?.name === 'label' ? textOf(parent).trim() || undefined : undefined)
  const conv = (e: El, parent?: El): object[] => {
    const at = e.attribs
    const kids = (): object[] => els(e).flatMap((c) => conv(c, e))
    if (e.name === 'script' || e.name === 'style') return []
    if (at['data-section'] !== undefined)
      return [{ kind: 'section', id: at['data-section'], title: at['data-title'], collapsed: at['data-collapsed'] !== undefined || undefined, showIf: json(e, 'data-show-if'), children: kids() }]
    if (at['data-tabs'] !== undefined) return [{ kind: 'tabs', children: kids() }]
    if (at['data-row'] !== undefined) return [{ kind: 'row', children: kids() }]
    if (at['data-repeat'] !== undefined)
      return [{ kind: 'repeat', path: at['data-repeat'], itemTitle: at['data-item-title'], label: at['data-label'], showIf: json(e, 'data-show-if'), children: kids() }]
    if (at['data-computed'] !== undefined) return [{ kind: 'computed', id: at['data-computed'], type: at['data-type'], label: at['data-label'], expr: textOf(e).trim() }]
    if (at['data-path'] !== undefined) {
      const tagWidget =
        e.name === 'textarea' ? 'textarea' : e.name === 'select' ? 'select' : e.name === 'input' && at.type === 'checkbox' ? 'checkbox' : e.name === 'input' && at.type === 'number' ? 'number' : undefined
      return [{ kind: 'field', path: at['data-path'], widget: at['data-widget'] ?? tagWidget, label: labelOf(e, parent), props: json(e, 'data-props'), showIf: json(e, 'data-show-if') }]
    }
    return kids()
  }
  const drop = (o: object): object => JSON.parse(JSON.stringify(o)) as object
  return drop({ editor: 1, id: root.attribs.id, title: root.attribs.title, schema: sc ? JSON.parse(textOf(sc)) : undefined, nodes: rowTabsTree(els(root).flatMap((c) => conv(c, root))) })
}

export function loadFixture(file: string): string | object {
  const text = readFileSync(file, 'utf8')
  if (file.endsWith('.yaml')) return YAML.parse(text) as object
  if (file.endsWith('.html')) return fromHtml(text)
  return text
}
