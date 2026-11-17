/**
 * Line-based tokenizer for the nrd markdown layer (mdz/mds with sigil `$`,
 * md/mdd with sigil `@`). Pure function, no CodeMirror: the editor extension
 * maps its output to decorations, tests use it directly.
 *
 * Grammar: docs/mdz-syntax.md. Highlighting only — nothing is resolved.
 */

export type Sigil = '$' | '@'

export type MdzTokenType =
  | 'heading-mark' // `##` of a block heading or closing line
  | 'block-sigil'
  | 'block-name'
  | 'block-id'
  | 'block-close' // `$@` / `$` of a closing line
  | 'attr-sigil'
  | 'attr-key'
  | 'directive-key' // attribute key `nr-*`
  | 'attr-colon'
  | 'value' // plain string value
  | 'value-quoted'
  | 'value-bool'
  | 'value-null'
  | 'value-number'
  | 'value-list' // `$[a, b]`
  | 'value-object' // `{...}` JSON5
  | 'include' // `$[[path]]`
  | 'placeholder' // `${...}`
  | 'macro' // `{{user}}`
  | 'escape' // `\$`, `\[`, ...
  | 'role' // `%user`
  | 'fence-open' // ````%type
  | 'fence-close'
  | 'comment' // `$// ...`

export interface MdzToken {
  type: MdzTokenType
  /** Column of the first char, relative to the line start. */
  from: number
  /** Column after the last char. */
  to: number
  /** Include target (`path`, `path#Section`, `#Section`). */
  target?: string
}

export type MdzLineKind =
  | 'text'
  | 'block-heading'
  | 'block-close'
  | 'attribute'
  | 'comment'
  | 'role'
  | 'fence-open' // four-backtick typed fence
  | 'fence-body'
  | 'fence-close'
  | 'code' // ordinary markdown fence (``` or ~~~), opening/closing lines included

export interface MdzLine {
  kind: MdzLineKind
  /** Heading level (1–6) for `block-heading` / `block-close`. */
  level?: number
  tokens: MdzToken[]
}

/** Foldable range in line indexes (0-based, inclusive). */
export interface MdzFoldRange {
  startLine: number
  endLine: number
}

export interface MdzResult {
  lines: MdzLine[]
  folds: MdzFoldRange[]
}

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*'
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const ESCAPABLE = new Set(['$', '@', '[', '{', ',', '\\', '.'])
const MD_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const TYPED_FENCE_OPEN_RE = /^````[ \t]*%[A-Za-z_][\w.-]*/
const TYPED_FENCE_CLOSE_RE = /^````[ \t]*$/
const ROLE_RE = /^%[A-Za-z_][\w.-]*(?=[ \t]|$)/
const ATX_RE = /^(#{1,6})(?:[ \t]|$)/

function esc(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

interface SigilRegexps {
  heading: RegExp
  close: RegExp
  attribute: RegExp
  comment: RegExp
}

const regexpCache = new Map<Sigil, SigilRegexps>()

function regexps(sigil: Sigil): SigilRegexps {
  let r = regexpCache.get(sigil)
  if (!r) {
    const s = esc(sigil)
    r = {
      heading: new RegExp(`^(#{1,6})([ \\t]+)(${s})(${NAME})(?:([ \\t]+)(\\S(?:.*\\S)?))?[ \\t]*$`),
      close: new RegExp(`^(#{1,6})([ \\t]+)(${s}@?)[ \\t]*$`),
      attribute: new RegExp(`^(${s})(${NAME})(:)(.*)$`),
      comment: new RegExp(`^${s}\\/\\/`),
    }
    regexpCache.set(sigil, r)
  }
  return r
}

/** Matches lines that the markdown parser must leave alone (see markdown-ext). */
export function mdzLineKind(text: string, sigil: Sigil): 'block-heading' | 'block-close' | 'attribute' | 'comment' | 'role' | null {
  const line = stripCR(text)
  const r = regexps(sigil)
  if (line.startsWith('#')) {
    if (r.heading.test(line)) return 'block-heading'
    if (r.close.test(line)) return 'block-close'
    return null
  }
  if (line.startsWith(sigil)) {
    if (r.comment.test(line)) return 'comment'
    if (r.attribute.test(line)) return 'attribute'
    return null
  }
  if (line.startsWith('%') && ROLE_RE.test(line)) return 'role'
  return null
}

export function isTypedFenceOpen(text: string): boolean {
  return TYPED_FENCE_OPEN_RE.test(text)
}

export function isTypedFenceClose(text: string): boolean {
  return TYPED_FENCE_CLOSE_RE.test(stripCR(text))
}

/** A trailing `\r` (mixed line endings kept byte-exact) is not content. */
function stripCR(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

/**
 * Inline scan: escapes, placeholders `${...}` (nested), includes `$[[...]]`,
 * macros `{{...}}`. Works on `text[from, to)`; columns are absolute in the line.
 */
export function scanInline(text: string, sigil: Sigil, from = 0, to = text.length): MdzToken[] {
  const tokens: MdzToken[] = []
  let i = from
  while (i < to) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (i + 1 < to && next !== undefined && ESCAPABLE.has(next)) {
        tokens.push({ type: 'escape', from: i, to: i + 2 })
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === sigil && text[i + 1] === '{') {
      const end = matchBraces(text, i + 1, to)
      if (end > 0) {
        tokens.push({ type: 'placeholder', from: i, to: end })
        i = end
        continue
      }
    }
    if (ch === sigil && text[i + 1] === '[' && text[i + 2] === '[') {
      const close = text.indexOf(']]', i + 3)
      if (close !== -1 && close + 2 <= to) {
        const target = text.slice(i + 3, close)
        if (target.trim() && !target.includes('[')) {
          tokens.push({ type: 'include', from: i, to: close + 2, target: target.trim() })
          i = close + 2
          continue
        }
      }
    }
    if (ch === '{' && text[i + 1] === '{') {
      const close = text.indexOf('}}', i + 2)
      if (close !== -1 && close + 2 <= to && close > i + 2) {
        tokens.push({ type: 'macro', from: i, to: close + 2 })
        i = close + 2
        continue
      }
    }
    i += 1
  }
  return tokens
}

/**
 * Given `text[open] === '{'`, returns the index after the matching `}`, or -1.
 * Escapes inside are skipped, so `${a.\}}` keeps going.
 */
function matchBraces(text: string, open: number, to: number): number {
  let depth = 0
  for (let i = open; i < to; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function valueTokens(text: string, sigil: Sigil, start: number, end: number): MdzToken[] {
  let from = start
  while (from < end && (text[from] === ' ' || text[from] === '\t')) from++
  let to = end
  while (to > from && (text[to - 1] === ' ' || text[to - 1] === '\t')) to--
  if (from >= to) return []
  const value = text.slice(from, to)
  const inline = (a: number, b: number) => scanInline(text, sigil, a, b)

  if (value === 'true' || value === 'false') return [{ type: 'value-bool', from, to }]
  if (value === 'null') return [{ type: 'value-null', from, to }]
  if (NUMBER_RE.test(value)) return [{ type: 'value-number', from, to }]

  if (value.startsWith(`${sigil}[[`)) {
    // An include used as the value.
    return [{ type: 'value', from, to }, ...inline(from, to)]
  }
  if (value.startsWith(`${sigil}[`) && value.endsWith(']')) {
    return [{ type: 'value-list', from, to }, ...inline(from + 2, to - 1)]
  }
  if (value.startsWith('{') && value.endsWith('}') && !value.startsWith('{{')) {
    return [{ type: 'value-object', from, to }, ...inline(from, to)]
  }
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return [{ type: 'value-quoted', from, to }, ...inline(from, to)]
  }
  return [{ type: 'value', from, to }, ...inline(from, to)]
}

function tokenizeAttribute(text: string, m: RegExpExecArray, sigil: Sigil): MdzToken[] {
  const key = m[2]!
  const keyEnd = 1 + key.length
  return [
    { type: 'attr-sigil', from: 0, to: 1 },
    { type: key.startsWith('nr-') ? 'directive-key' : 'attr-key', from: 1, to: keyEnd },
    { type: 'attr-colon', from: keyEnd, to: keyEnd + 1 },
    ...valueTokens(text, sigil, keyEnd + 1, text.length),
  ]
}

function tokenizeHeading(m: RegExpExecArray): MdzToken[] {
  const hashes = m[1]!
  const gap = m[2]!
  const name = m[4]!
  let pos = hashes.length + gap.length
  const tokens: MdzToken[] = [
    { type: 'heading-mark', from: 0, to: hashes.length },
    { type: 'block-sigil', from: pos, to: pos + 1 },
    { type: 'block-name', from: pos + 1, to: pos + 1 + name.length },
  ]
  pos += 1 + name.length
  if (m[6] !== undefined) {
    pos += m[5]!.length
    tokens.push({ type: 'block-id', from: pos, to: pos + m[6].length })
  }
  return tokens
}

/** Splits like CodeMirror does by default: `\r\n`, `\r`, `\n`. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * Tokenizes a whole document. `input` is either the raw text or its lines
 * (CodeMirror passes lines so columns line up with `line.from`).
 */
export function tokenizeMdz(input: string | readonly string[], sigil: Sigil): MdzResult {
  const rawLines = typeof input === 'string' ? splitLines(input) : input
  const r = regexps(sigil)
  const lines: MdzLine[] = []
  const folds: MdzFoldRange[] = []

  // Open block headings waiting for their fold end: [lineIndex, level].
  const openBlocks: Array<{ line: number; level: number }> = []
  const closeBlocksUpTo = (level: number, before: number) => {
    while (openBlocks.length && openBlocks[openBlocks.length - 1]!.level >= level) {
      const block = openBlocks.pop()!
      pushFold(block.line, before - 1)
    }
  }
  const pushFold = (start: number, end: number) => {
    // Trailing blank lines stay outside the fold.
    while (end > start && stripCR(rawLines[end] ?? '').trim() === '') end--
    if (end > start) folds.push({ startLine: start, endLine: end })
  }

  let mdFence: { marker: string; length: number } | null = null
  let typedFenceStart = -1

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!
    const text = stripCR(raw)

    if (typedFenceStart >= 0) {
      if (TYPED_FENCE_CLOSE_RE.test(text)) {
        lines.push({ kind: 'fence-close', tokens: [{ type: 'fence-close', from: 0, to: text.length }] })
        pushFold(typedFenceStart, index)
        typedFenceStart = -1
      } else {
        lines.push({ kind: 'fence-body', tokens: [] })
      }
      continue
    }

    if (mdFence) {
      const m = MD_FENCE_RE.exec(text)
      if (m && m[1]![0] === mdFence.marker && m[1]!.length >= mdFence.length && text.slice(m[0].length).trim() === '') {
        mdFence = null
      }
      lines.push({ kind: 'code', tokens: [] })
      continue
    }

    if (TYPED_FENCE_OPEN_RE.test(text)) {
      typedFenceStart = index
      lines.push({ kind: 'fence-open', tokens: [{ type: 'fence-open', from: 0, to: text.length }] })
      continue
    }

    const fence = MD_FENCE_RE.exec(text)
    if (fence) {
      mdFence = { marker: fence[1]![0]!, length: fence[1]!.length }
      lines.push({ kind: 'code', tokens: [] })
      continue
    }

    if (text.startsWith('#')) {
      const heading = r.heading.exec(text)
      if (heading) {
        const level = heading[1]!.length
        closeBlocksUpTo(level, index)
        openBlocks.push({ line: index, level })
        lines.push({ kind: 'block-heading', level, tokens: tokenizeHeading(heading) })
        continue
      }
      const close = r.close.exec(text)
      if (close) {
        const level = close[1]!.length
        closeBlocksUpTo(level, index)
        const markFrom = close[1]!.length + close[2]!.length
        lines.push({
          kind: 'block-close',
          level,
          tokens: [
            { type: 'heading-mark', from: 0, to: close[1]!.length },
            { type: 'block-close', from: markFrom, to: markFrom + close[3]!.length },
          ],
        })
        continue
      }
      const atx = ATX_RE.exec(text)
      if (atx) closeBlocksUpTo(atx[1]!.length, index)
      lines.push({ kind: 'text', tokens: scanInline(text, sigil) })
      continue
    }

    if (text.startsWith(sigil)) {
      if (r.comment.test(text)) {
        lines.push({ kind: 'comment', tokens: [{ type: 'comment', from: 0, to: text.length }] })
        continue
      }
      const attr = r.attribute.exec(text)
      if (attr) {
        lines.push({ kind: 'attribute', tokens: tokenizeAttribute(text, attr, sigil) })
        continue
      }
    }

    if (text.startsWith('%')) {
      const role = ROLE_RE.exec(text)
      if (role) {
        lines.push({
          kind: 'role',
          tokens: [{ type: 'role', from: 0, to: role[0].length }, ...scanInline(text, sigil, role[0].length)],
        })
        continue
      }
    }

    lines.push({ kind: 'text', tokens: scanInline(text, sigil) })
  }

  closeBlocksUpTo(1, rawLines.length)
  // An unterminated typed fence runs to the end of the document.
  if (typedFenceStart >= 0) pushFold(typedFenceStart, rawLines.length - 1)
  folds.sort((a, b) => a.startLine - b.startLine)
  return { lines, folds }
}
