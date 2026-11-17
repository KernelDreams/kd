// Форма рецепта (`## $form`, forms-spec) — частный случай описания (spec §2): FormSchema → EditorDef.
// `$nr-show-if` секции → `showIf` один в один (та же семантика И/ИЛИ, `sectionVisible`),
// `$nr-collapsed` → `collapsed`; подписи и порядок — как есть.

import { orderedFields, sectionsOf, type FormSchema } from '../schema.js'
import type { EditorDef, FieldNode, FieldType, SectionNode } from './types.js'

/** Виджет FormView → виджет каталога. `model`, `file` регистрирует nrchat. */
const WIDGET: Record<string, string> = { input: 'text' }

/** Имя секции без id (форма без `## $form <id>`). */
export const FORM_MAIN_SECTION = 'main'

export function formToEditor(form: FormSchema, meta: { id: string; title?: string }): EditorDef {
  const sections = sectionsOf(form)
  const byId = new Map<string, SectionNode>()
  const out: SectionNode[] = []
  for (const s of sections) {
    const node: SectionNode = { kind: 'section', id: s.id || FORM_MAIN_SECTION, children: [] }
    if (s.title) node.title = s.title
    if (s.collapsed !== undefined) node.collapsed = s.collapsed
    if (s.showIf) node.showIf = s.showIf
    byId.set(s.id, node)
    out.push(node)
  }
  const required = new Set(form.required)
  for (const [name, f] of orderedFields(form)) {
    const ui = f['x-ui']
    const type: FieldType = f.type === 'array' ? 'string[]' : f.type
    const node: FieldNode = { kind: 'field', id: name, path: name, type, widget: WIDGET[ui.widget] ?? ui.widget }
    if (f.title) node.label = f.title
    if (f.enum) node.enum = f.enum
    if (f.minimum !== undefined) node.min = f.minimum
    if (f.maximum !== undefined) node.max = f.maximum
    if (f.default !== undefined) node.default = f.default
    if (required.has(name)) node.required = true
    if (ui.labels) node.props = { labels: ui.labels }
    let sec = byId.get(ui.section)
    if (!sec) {
      sec = { kind: 'section', id: ui.section || FORM_MAIN_SECTION, children: [] }
      byId.set(ui.section, sec)
      out.push(sec)
    }
    sec.children.push(node)
  }
  const def: EditorDef = { editor: 1, id: meta.id, nodes: out.filter((s) => s.children.length) }
  if (meta.title) def.title = meta.title
  return def
}
