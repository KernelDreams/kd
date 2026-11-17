// parseEditor: `*.editor.mdz` и JSON-запись → EditorDef (universal-editor-spec §2).
// Документ с ошибкой разбирается тем, что разобралось: неизвестный узел остаётся в дереве,
// `check` его называет.

import { parse as parseMdz, type Attribute, type Block } from '@kerneldreams/nrd/md'
import {
  type AnyNode,
  type ComputedType,
  type EditorDef,
  type FieldType,
  type Issue,
  type JSONSchema,
  type ShowIf,
} from './types.js'

export type EditorFormat = 'mdz' | 'json'

export interface ParseEditorOptions {
  /** Нет — по содержимому: `{` в начале — JSON, иначе mdz. */
  format?: EditorFormat
}

export interface ParseEditorResult {
  def: EditorDef
  /** Ошибки разбора (`E_PARSE`) и предупреждения о незнакомых атрибутах (`W_ATTR`). */
  issues: Issue[]
}

const EMPTY = (): EditorDef => ({ editor: 1, id: '', nodes: [] })

/** Снять markdown-обёртку ```…``` вокруг всего текста (так отвечают модели). */
function unwrap(text: string): string {
  const m = /^\s*```[a-z0-9-]*\n([\s\S]*?)\n```\s*$/i.exec(text)
  return m ? m[1]! : text
}

export function parseEditor(input: string | object, opts: ParseEditorOptions = {}): ParseEditorResult {
  if (typeof input !== 'string') return fromJson(input)
  const text = unwrap(input.replace(/^﻿/, ''))
  const format = opts.format ?? (/^\s*\{/.test(text) ? 'json' : 'mdz')
  if (format === 'json') {
    let obj: unknown
    try {
      obj = JSON.parse(text)
    } catch (e) {
      return { def: EMPTY(), issues: [{ code: 'E_PARSE', where: '', message: `JSON не разбирается: ${(e as Error).message}` }] }
    }
    return fromJson(obj)
  }
  return fromMdz(text)
}

// ---------- общее ----------

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

function joinPath(prefix: string, name: string | undefined): string | undefined {
  if (!name) return undefined
  return prefix ? `${prefix}.${name}` : name
}

/** Атрибуты узла по видам: известные ключи, остальное — предупреждение. */
const ATTRS: Record<string, string[]> = {
  section: ['title', 'collapsed', 'showIf', 'hideIf', 'tab'],
  field: ['path', 'type', 'label', 'description', 'widget', 'enum', 'min', 'max', 'default', 'required', 'props', 'showIf', 'hideIf', 'row', 'generators'],
  repeat: ['path', 'label', 'itemTitle', 'showIf', 'hideIf', 'row'],
  group: ['path', 'label', 'showIf', 'hideIf'],
  computed: ['expr', 'type', 'label', 'showIf', 'hideIf', 'row'],
  text: ['text', 'showIf', 'hideIf'],
}

/** Объект без ключей со значением `undefined` (exactOptionalPropertyTypes). */
function clean<T>(o: object): T {
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
  return o as T
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
const bool = (v: unknown): boolean | undefined => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
/** Список id: `$[a, b]` (массив) или строка через запятую; пусто — нет. */
const list = (v: unknown): string[] | undefined => {
  const arr = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []
  const out = arr.map((x) => x.trim()).filter(Boolean)
  return out.length ? out : undefined
}
const showIf = (v: unknown): ShowIf | undefined => (v === undefined ? undefined : (v as ShowIf))

interface Raw {
  kind: string
  id?: string
  attrs: Record<string, unknown>
  body?: string
  line?: number
  children: Raw[]
}

/**
 * Raw → узел. `prefix` — путь групп-предков в текущей области (корень или элемент повторителя).
 * `named` — у mdz имя узла даёт путь (`### $field physique` в группе `skills` → `skills.physique`);
 * в JSON `path` пишется полностью.
 */
function toNode(r: Raw, prefix: string, named: boolean, issues: Issue[], where: string): AnyNode {
  const a = r.attrs
  const here = `${where ? `${where} / ` : ''}${r.kind}${r.id ? ` ${r.id}` : a.path ? ` ${String(a.path)}` : ''}`
  const known = ATTRS[r.kind]
  if (known) {
    for (const k of Object.keys(a))
      if (!known.includes(k))
        issues.push(clean({ code: 'W_ATTR', where: here, message: `неизвестный атрибут $${kebab(k)}`, hint: `у ${r.kind}: ${known.map((x) => '$' + kebab(x)).join(', ')}`, line: r.line }))
  }
  const base = { line: r.line, showIf: showIf(a.showIf), hideIf: showIf(a.hideIf) }
  const pathOf = (): string => str(a.path) ?? (named ? joinPath(prefix, r.id) : r.id) ?? ''
  switch (r.kind) {
    case 'section':
      return clean({
        kind: 'section',
        id: r.id ?? '',
        title: str(a.title),
        collapsed: bool(a.collapsed),
        tab: str(a.tab),
        ...base,
        children: r.children.map((c) => toNode(c, prefix, named, issues, here)),
      })
    case 'field':
      return clean({
        kind: 'field',
        id: r.id,
        path: pathOf(),
        type: str(a.type) as FieldType | undefined,
        label: str(a.label),
        description: str(a.description),
        widget: str(a.widget),
        enum: Array.isArray(a.enum) ? a.enum : undefined,
        min: num(a.min),
        max: num(a.max),
        default: a.default,
        required: bool(a.required),
        props: obj(a.props),
        row: str(a.row),
        generators: list(a.generators),
        ...base,
      })
    case 'repeat': {
      const path = pathOf()
      return clean({
        kind: 'repeat',
        id: r.id,
        path,
        label: str(a.label),
        itemTitle: str(a.itemTitle),
        row: str(a.row),
        ...base,
        children: r.children.map((c) => toNode(c, '', named, issues, here)),
      })
    }
    case 'group': {
      const path = pathOf()
      return clean({
        kind: 'group',
        id: r.id,
        path,
        label: str(a.label),
        ...base,
        children: r.children.map((c) => toNode(c, path, named, issues, here)),
      })
    }
    case 'computed':
      return clean({
        kind: 'computed',
        id: r.id ?? '',
        expr: str(a.expr) ?? '',
        type: str(a.type) as ComputedType,
        label: str(a.label),
        row: str(a.row),
        ...base,
      })
    case 'text':
      return clean({ kind: 'text', text: str(a.text) ?? r.body ?? '', ...base })
    default:
      return clean({ kind: r.kind, id: r.id, ...base, children: r.children.map((c) => toNode(c, prefix, named, issues, here)) })
  }
}

// ---------- mdz ----------

function attrValue(v: Attribute['value']): unknown {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && 'raw' in x ? x.raw : x))
  if (v && typeof v === 'object' && 'raw' in v && 'placeholders' in v) return v.raw
  return v
}

function attrsOf(b: Block): Record<string, unknown> {
  return Object.fromEntries(b.attrs.map((a) => [camel(a.key.join('.')), attrValue(a.value)]))
}

function rawOf(b: Block): Raw {
  const body = typeof b.body === 'string' ? b.body : b.body?.raw
  return clean({ kind: b.name, id: b.id, attrs: attrsOf(b), body: body?.trim() || undefined, line: b.pos?.line, children: b.children.map(rawOf) })
}

function fromMdz(text: string): ParseEditorResult {
  // Битая строка (JSON5 атрибута и т.п.) не роняет описание: она гасится, ошибка — с номером строки.
  const issues: Issue[] = []
  const lines = text.split('\n')
  let doc
  for (let tries = 0; ; tries++) {
    try {
      doc = parseMdz(lines.join('\n'), { positions: true })
      break
    } catch (e) {
      const msg = (e as Error).message
      const line = Number(/\(line (\d+)\)/.exec(msg)?.[1])
      if (!line || tries >= 50 || lines[line - 1] === '') {
        issues.push({ code: 'E_PARSE', where: '', message: `mdz не разбирается: ${msg}` })
        return { def: EMPTY(), issues }
      }
      issues.push({ code: 'E_PARSE', where: '', message: `строка не разбирается: ${msg.replace(/^\$?[\w.-]+ \(line \d+\): /, '')}`, hint: lines[line - 1]!.trim(), line })
      lines[line - 1] = ''
    }
  }
  // Глубже ###### mdz заголовков не знает: строка уходит в тело, атрибуты — родителю.
  text.split('\n').forEach((l, i) => {
    if (/^#{7,} \$/.test(l))
      issues.push({ code: 'W_DEPTH', where: '', message: `«${l.trim()}» глубже ###### — не узел, его атрибуты достались родителю`, hint: 'секция (h2) + до четырёх уровней; строки и вкладки — атрибутами, не блоками', line: i + 1 })
  })
  const root = attrsOf(doc.root)
  const nodes = doc.root.children.map((b) => toNode(rawOf(b), '', true, issues, ''))
  return { def: meta(root, nodes), issues }
}

function meta(root: Record<string, unknown>, nodes: AnyNode[]): EditorDef {
  const v = num(root.editor)
  return clean({
    editor: (v ?? root.editor) as 1,
    id: str(root.id) ?? '',
    title: str(root.title),
    version: num(root.version),
    schema: obj(root.schema) as JSONSchema | undefined,
    showIf: showIf(root.showIf),
    nodes,
  })
}

// ---------- JSON ----------

/** Узел JSON: `kind` (или `node` — запись пробы), ключи camelCase или kebab-case, дети — `children`. */
function rawOfJson(n: unknown): Raw {
  const o = obj(n)
  if (!o) return { kind: '?', attrs: {}, children: [] }
  const { kind, node, id, children, ...rest } = o
  const attrs = Object.fromEntries(Object.entries(rest).map(([k, v]) => [camel(k), v]))
  return clean({ kind: String(kind ?? node ?? '?'), id: str(id), attrs, children: Array.isArray(children) ? children.map(rawOfJson) : [] })
}

function fromJson(input: unknown): ParseEditorResult {
  const o = obj(input)
  if (!o) return { def: EMPTY(), issues: [{ code: 'E_PARSE', where: '', message: 'описание — не объект' }] }
  const list = o.nodes ?? o.layout
  const issues: Issue[] = []
  if (!Array.isArray(list)) issues.push({ code: 'E_PARSE', where: '', message: 'нет массива узлов', hint: '"nodes": [ {"kind": "section", …} ]' })
  const nodes = (Array.isArray(list) ? list : []).map((n) => toNode(rawOfJson(n), '', false, issues, ''))
  return { def: meta(o, nodes), issues }
}

