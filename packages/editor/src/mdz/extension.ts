import { type Extension, type Range, StateField, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { foldService } from '@codemirror/language'
import { type MdzLineKind, type MdzResult, type MdzTokenType, type Sigil, tokenizeMdz } from './tokenizer'

export interface MdzExtensionConfig {
  sigil: Sigil
  /** Click on an include `$[[path]]` → its target (`path`, `path#Section`). */
  onLinkClick?: (target: string) => void
  /** Receives the set of include targets after every change (see editor.ts). */
  onIncludes?: (targets: ReadonlySet<string>) => void
}

const TOKEN_CLASS: Record<MdzTokenType, string> = {
  'heading-mark': 'nre-mdz-heading-mark',
  'block-sigil': 'nre-mdz-block-sigil',
  'block-name': 'nre-mdz-block-name',
  'block-id': 'nre-mdz-block-id',
  'block-close': 'nre-mdz-block-close',
  'attr-sigil': 'nre-mdz-attr-sigil',
  'attr-key': 'nre-mdz-attr-key',
  'directive-key': 'nre-mdz-directive',
  'attr-colon': 'nre-mdz-attr-colon',
  value: 'nre-mdz-value',
  'value-quoted': 'nre-mdz-value nre-mdz-value-quoted',
  'value-bool': 'nre-mdz-value nre-mdz-value-bool',
  'value-null': 'nre-mdz-value nre-mdz-value-null',
  'value-number': 'nre-mdz-value nre-mdz-value-number',
  'value-list': 'nre-mdz-value nre-mdz-value-list',
  'value-object': 'nre-mdz-value nre-mdz-value-object',
  include: 'nre-mdz-include',
  placeholder: 'nre-mdz-placeholder',
  macro: 'nre-mdz-macro',
  escape: 'nre-mdz-escape',
  role: 'nre-mdz-role',
  'fence-open': 'nre-mdz-fence-mark',
  'fence-close': 'nre-mdz-fence-mark',
  comment: 'nre-mdz-comment',
}

const LINE_CLASS: Partial<Record<MdzLineKind, string>> = {
  'block-heading': 'nre-mdz-line-heading',
  'block-close': 'nre-mdz-line-close',
  attribute: 'nre-mdz-line-attr',
  comment: 'nre-mdz-line-comment',
  role: 'nre-mdz-line-role',
  'fence-open': 'nre-mdz-line-fence nre-mdz-line-fence-open',
  'fence-body': 'nre-mdz-line-fence',
  'fence-close': 'nre-mdz-line-fence nre-mdz-line-fence-close',
}

const markCache = new Map<string, Decoration>()
function mark(cls: string): Decoration {
  let deco = markCache.get(cls)
  if (!deco) {
    deco = Decoration.mark({ class: cls })
    markCache.set(cls, deco)
  }
  return deco
}

const lineCache = new Map<string, Decoration>()
function lineDeco(cls: string): Decoration {
  let deco = lineCache.get(cls)
  if (!deco) {
    deco = Decoration.line({ class: cls })
    lineCache.set(cls, deco)
  }
  return deco
}

function docLines(doc: Text): string[] {
  const lines: string[] = []
  for (const line of doc.iterLines()) lines.push(line)
  return lines
}

interface MdzState {
  result: MdzResult
  decorations: DecorationSet
  includes: Set<string>
  /** Fold end line index by start line index. */
  folds: Map<number, number>
}

function build(doc: Text, sigil: Sigil): MdzState {
  const result = tokenizeMdz(docLines(doc), sigil)
  const ranges: Range<Decoration>[] = []
  const includes = new Set<string>()
  result.lines.forEach((line, index) => {
    const { from } = doc.line(index + 1)
    let cls = LINE_CLASS[line.kind]
    if (cls) {
      if (line.level) cls += ` nre-mdz-h${line.level}`
      ranges.push(lineDeco(cls).range(from))
    }
    for (const token of line.tokens) {
      if (token.to <= token.from) continue
      if (token.type === 'include' && token.target !== undefined) {
        includes.add(token.target)
        ranges.push(
          Decoration.mark({
            class: TOKEN_CLASS.include,
            attributes: { 'data-nre-include': token.target, title: token.target },
          }).range(from + token.from, from + token.to),
        )
        continue
      }
      ranges.push(mark(TOKEN_CLASS[token.type]).range(from + token.from, from + token.to))
    }
  })
  const folds = new Map(result.folds.map((f) => [f.startLine, f.endLine]))
  return { result, decorations: Decoration.set(ranges, true), includes, folds }
}

/** Tokens of the nrd layer for the current document (shared with fold/tests). */
export const mdzStateField = (sigil: Sigil, onIncludes?: (t: ReadonlySet<string>) => void) =>
  StateField.define<MdzState>({
    create(state) {
      const value = build(state.doc, sigil)
      onIncludes?.(value.includes)
      return value
    },
    update(value, tr) {
      if (!tr.docChanged) return value
      const next = build(tr.state.doc, sigil)
      onIncludes?.(next.includes)
      return next
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  })

export function mdzExtension(config: MdzExtensionConfig): Extension {
  const field = mdzStateField(config.sigil, config.onIncludes)
  return [
    field,
    foldService.of((state, lineStart) => {
      const mdz = state.field(field, false)
      if (!mdz) return null
      const line = state.doc.lineAt(lineStart)
      const endLine = mdz.folds.get(line.number - 1)
      if (endLine === undefined) return null
      const end = state.doc.line(endLine + 1)
      return { from: line.to, to: end.to }
    }),
    EditorView.domEventHandlers({
      mousedown(event) {
        if (!config.onLinkClick || event.button !== 0) return false
        const el = event.target instanceof Element ? event.target.closest('[data-nre-include]') : null
        const target = el?.getAttribute('data-nre-include')
        if (target == null) return false
        event.preventDefault()
        config.onLinkClick(target)
        return true
      },
    }),
  ]
}
