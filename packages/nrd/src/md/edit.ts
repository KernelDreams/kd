// Point edits of a document's TEXT: change one attribute line, leave every other
// byte where it was. `parse → serialize` rewrites the document in canonical form
// (comments move, blank lines and `## $@` vanish); an editor that writes a file
// on every click needs the opposite — the smallest textual change.
//
// No second scanner: the target is found by the same parser pass (`parse` with
// `positions`), so whatever the parser reads as an attribute of a block is what
// gets edited — including a `$key: v` line inside a code fence in the body.

import type { AttributeValue, Block, ParseOptions, Sigil } from './types.js'
import { parse, parseAttribute } from './parser.js'
import { escapeBodyString, serializeValue, serializeId } from './serialize.js'

export interface BlockSelector {
  name: string
  id?: string
}

/** Path from the root. Empty or undefined — the root zone of the document. */
export type BlockPath = BlockSelector[]

export type EditOptions = Pick<ParseOptions, 'sigil' | 'baseLevel'>

/** The block a path points at does not exist. */
export class EditTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditTargetError'
  }
}

// ---------- Text geometry ----------

/**
 * Line spans in the ORIGINAL text. Breaks are `\r\n`, `\r`, `\n` — exactly the
 * ones the parser normalises — so line N here is line N of the parse.
 */
interface Lines {
  /** Offset of each line's first char. */
  starts: number[]
  /** Offset just past each line's content (where its break starts). */
  ends: number[]
}

function bomLength(text: string): number {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0
}

function scanLines(text: string): Lines {
  const starts: number[] = []
  const ends: number[] = []
  let start = bomLength(text)
  let i = start
  while (i < text.length) {
    const c = text[i]
    if (c === '\n' || c === '\r') {
      starts.push(start)
      ends.push(i)
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      start = i
      continue
    }
    i++
  }
  starts.push(start)
  ends.push(text.length)
  return { starts, ends }
}

/** The document's own line break: the first one met, `\n` if there is none. */
function eolOf(text: string): '\n' | '\r\n' {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
}

// ---------- Target ----------

function pathLabel(path: BlockPath): string {
  if (path.length === 0) return '(root)'
  return path.map((s) => (s.id === undefined ? s.name : `${s.name}[${s.id}]`)).join(' / ')
}

function findBlock(root: Block, path: BlockPath | undefined): Block {
  let cur = root
  for (const sel of path ?? []) {
    const next = cur.children.find(
      (b) => b.name === sel.name && (sel.id === undefined || b.id === sel.id),
    )
    if (!next) throw new EditTargetError(`block not found: ${pathLabel(path ?? [])}`)
    cur = next
  }
  return cur
}

function parseOpts(opts: EditOptions | undefined): ParseOptions {
  return { sigil: opts?.sigil, baseLevel: opts?.baseLevel, positions: true }
}

/** A key the parser reads back as exactly that one name, or Error. */
function checkKey(key: string, sigil: Sigil): void {
  const a = parseAttribute(`${sigil}${key}:`, sigil)
  if (!a || a.key.length !== 1 || a.key[0] !== key || a.rawValue !== '') {
    throw new Error(`invalid attribute key: ${JSON.stringify(key)}`)
  }
}

function attrLine(sigil: Sigil, key: string, v: string): string {
  return v.length > 0 ? `${sigil}${key}: ${v}` : `${sigil}${key}:`
}

// ---------- setAttr ----------

/**
 * Set attribute `key` of the block at `path` to `value`, editing the text in
 * place. An existing attribute: the LAST line with that key (last wins) gets a
 * new value, everything before the value on that line is kept. No attribute:
 * a new line goes right after the block's last attribute, or after its header,
 * or — for a root without attributes — first in the document.
 */
export function setAttr(
  text: string,
  path: BlockPath | undefined,
  key: string,
  value: AttributeValue,
  opts?: EditOptions,
): string {
  const doc = parse(text, parseOpts(opts))
  const sigil = doc.sigil
  checkKey(key, sigil)
  const block = findBlock(doc.root, path)
  const v = serializeValue(value, sigil)
  if (v.includes('\n') || v.includes('\r')) {
    throw new Error(`attribute value must fit one line: ${key}`)
  }

  const lines = scanLines(text)
  const same = block.attrs.filter((a) => a.key.join('.') === key)
  const last = same[same.length - 1]
  if (last) {
    const li = last.pos!.line - 1
    const start = lines.starts[li]
    const end = lines.ends[li]
    const parsed = parseAttribute(text.slice(start, end), sigil)!
    if (parsed.rawValue === v) return text
    const valueStart = end - parsed.rawValue.length
    return text.slice(0, valueStart) + v + text.slice(end)
  }

  const line = attrLine(sigil, key, v)
  const eol = eolOf(text)
  const anchor = block.attrs.length > 0 ? block.attrs[block.attrs.length - 1].pos : block.pos
  if (!anchor) {
    // Root without attributes: first line of the document, after the BOM.
    const at = bomLength(text)
    return text.slice(0, at) + line + eol + text.slice(at)
  }
  const at = lines.ends[anchor.line - 1]
  return text.slice(0, at) + eol + line + text.slice(at)
}

// ---------- removeAttr ----------

/**
 * Remove EVERY line of attribute `key` in the block at `path`, each with its
 * line break — removing only the last would surface an earlier duplicate.
 * No such attribute — `text` comes back unchanged.
 */
export function removeAttr(
  text: string,
  path: BlockPath | undefined,
  key: string,
  opts?: EditOptions,
): string {
  const doc = parse(text, parseOpts(opts))
  const block = findBlock(doc.root, path)
  const same = block.attrs.filter((a) => a.key.join('.') === key)
  if (same.length === 0) return text

  const { starts, ends } = scanLines(text)
  const removed = new Set(same.map((a) => a.pos!.line - 1))
  const ranges: Array<[number, number]> = [...removed].map((li) => {
    if (li + 1 < starts.length) return [starts[li], starts[li + 1]]
    // The last line has no break of its own: take the break of the nearest kept
    // line above, so the text still ends the way it did (without a newline).
    let j = li - 1
    while (j >= 0 && removed.has(j)) j--
    return j >= 0 ? [ends[j], ends[li]] : [starts[li], ends[li]]
  })
  ranges.sort((a, b) => a[0] - b[0])

  let out = ''
  let pos = 0
  for (const [from, to] of ranges) {
    if (from > pos) out += text.slice(pos, from)
    pos = Math.max(pos, to)
  }
  return out + text.slice(pos)
}

// ---------- ensureBlock ----------

/**
 * Make sure a top-level block exists. Present — `text` unchanged. Absent — a
 * header is appended at the end, after a blank line, with as many `#` as the
 * first top-level block of the document has (two when there is none).
 */
export function ensureBlock(text: string, path: BlockPath, opts?: EditOptions): string {
  if (path.length !== 1) {
    throw new Error(`ensureBlock takes a single top-level selector, got ${pathLabel(path)}`)
  }
  const doc = parse(text, parseOpts(opts))
  const sel = path[0]
  try {
    findBlock(doc.root, path)
    return text
  } catch (e) {
    if (!(e instanceof EditTargetError)) throw e
  }

  const sigil = doc.sigil
  const first = doc.root.children[0]
  const hashes = '#'.repeat(first ? first.level + (opts?.baseLevel ?? 1) - 1 : 2)
  let header = `${hashes} ${sigil}${sel.name}`
  if (sel.id !== undefined) header += ' ' + serializeId(sel.id)

  const eol = eolOf(text)
  let out = text
  if (out.length > bomLength(out)) {
    const endsWithBreak = out.endsWith('\n') || out.endsWith('\r')
    if (!endsWithBreak) out += eol
    const lines = scanLines(out)
    // The line before the final break (scanLines ends with an empty tail line).
    const li = lines.starts.length - 2
    if (lines.ends[li] > lines.starts[li]) out += eol
  }
  out += header + eol

  // The header must read back as the block asked for (a bad name would be body text).
  try {
    findBlock(parse(out, parseOpts(opts)).root, path)
  } catch {
    throw new Error(`invalid block header: ${JSON.stringify(header)}`)
  }
  return out
}

// ---------- setBody / removeBlock (адаптер схем пишет правку, а не перепечатку) ----------

/** Lines (0-based) of every header in the document, ascending. */
function headerLines(root: Block): Array<{ line: number; level: number }> {
  const out: Array<{ line: number; level: number }> = []
  const walk = (b: Block): void => {
    for (const c of b.children) {
      out.push({ line: c.pos!.line - 1, level: c.level })
      walk(c)
    }
  }
  walk(root)
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Replace the body of the block at `path` (the text before its first child block)
 * with `body`, editing the text in place: attribute lines, children, comments
 * elsewhere stay byte for byte. Lines that would read back as structure get the
 * sigil escaped (`\$`). Empty `body` removes the body. No body yet — it goes
 * after the block's attributes, separated by a blank line.
 */
export function setBody(text: string, path: BlockPath | undefined, body: string, opts?: EditOptions): string {
  const doc = parse(text, parseOpts(opts))
  const sigil = doc.sigil
  const block = findBlock(doc.root, path)
  const lines = scanLines(text)
  const eol = eolOf(text)
  const heads = headerLines(doc.root)
  const startLine = block.pos ? block.pos.line : 0 // first line after the header (0-based)
  const next = heads.find((h) => h.line >= startLine)
  const endLine = next ? next.line : lines.starts.length // exclusive
  const attrLines = new Set(block.attrs.map((a) => a.pos!.line - 1))
  const lineText = (i: number) => text.slice(lines.starts[i], lines.ends[i])
  let first = -1
  let last = -1
  for (let i = startLine; i < endLine; i++) {
    if (attrLines.has(i) || lineText(i).trim() === '') continue
    if (first < 0) first = i
    last = i
  }
  for (let i = first; first >= 0 && i <= last; i++) {
    if (attrLines.has(i)) throw new Error('body of ' + pathLabel(path ?? []) + ' is interleaved with attributes — not editable in place')
  }
  const esc = body.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  const newText = esc === '' ? '' : escapeBodyString(esc, sigil).split('\n').join(eol)

  let out: string
  if (first >= 0) {
    if (newText === '') {
      // drop the body lines and the blank lines right before them
      let from = first
      while (from - 1 >= startLine && !attrLines.has(from - 1) && lineText(from - 1).trim() === '') from--
      const a = from > 0 ? lines.ends[from - 1] : lines.starts[from]
      const b = from > 0 ? lines.ends[last] : last + 1 < lines.starts.length ? lines.starts[last + 1] : lines.ends[last]
      out = text.slice(0, a) + text.slice(b)
    } else {
      if (lines.starts[first] === undefined) throw new Error('internal: body span')
      out = text.slice(0, lines.starts[first]) + newText + text.slice(lines.ends[last])
    }
  } else {
    if (newText === '') return text
    const anchorLine = Math.max(startLine - 1, ...[...attrLines].filter((i) => i < endLine))
    if (anchorLine < 0) {
      // root without anything before the first header
      const at = bomLength(text)
      out = text.slice(0, at) + newText + eol + (next ? eol : '') + text.slice(at)
    } else {
      const at = lines.ends[anchorLine]
      const hasNextBlank = anchorLine + 1 < endLine && lineText(anchorLine + 1).trim() === ''
      out = text.slice(0, at) + eol + eol + newText + (next && !hasNextBlank ? eol : '') + text.slice(at)
    }
  }
  // The edit must read back as exactly that body.
  const check = findBlock(parse(out, parseOpts(opts)).root, path).body
  const got = check === undefined ? '' : typeof check === 'string' ? check : check.raw
  if (got !== esc && !(typeof check !== 'string' && check !== undefined)) {
    throw new Error('setBody: body did not read back for ' + pathLabel(path ?? []))
  }
  return out
}

/**
 * Remove the block at `path` with all its children — from its header to the next
 * header of the same or a higher level (or the end), with the blank lines that
 * separated it from the previous block when it was last.
 */
export function removeBlock(text: string, path: BlockPath, opts?: EditOptions): string {
  if (path.length === 0) throw new Error('removeBlock: path to a block required')
  const doc = parse(text, parseOpts(opts))
  const block = findBlock(doc.root, path)
  const lines = scanLines(text)
  const start = block.pos!.line - 1
  const next = headerLines(doc.root).find((h) => h.line > start && h.level <= block.level)
  if (next) return text.slice(0, lines.starts[start]) + text.slice(lines.starts[next.line])
  // last block: also eat the blank lines before it, keep the document's final break style
  let from = start
  const blank = (i: number) => text.slice(lines.starts[i], lines.ends[i]).trim() === ''
  while (from - 1 >= 0 && blank(from - 1)) from--
  const endsWithBreak = /\r?\n$/.test(text)
  if (from === 0) return ''
  return text.slice(0, lines.ends[from - 1]) + (endsWithBreak ? eolOf(text) : '')
}
