import type { MarkdownConfig } from '@lezer/markdown'
import { isTypedFenceClose, isTypedFenceOpen, mdzLineKind, scanInline, type Sigil } from './tokenizer'

/**
 * Teaches the markdown parser to leave nrd lines alone: block headings,
 * closing lines, attributes, comments, `%role` envelopes and four-backtick
 * typed fences become opaque leaf nodes. Live preview then has nothing to
 * hide or restyle there (the `##` of `## $step` stays visible, `$[[x]]` is
 * not a wiki link, an attribute line never turns into a setext heading),
 * and the mdz decoration layer styles them instead.
 *
 * Inline, includes `$[[x]]`, placeholders `${x}` and nrd escapes (`\$`, `\{`,
 * `\,`) become opaque too, so a body-text include is not rendered as a
 * markdown link and its brackets stay visible.
 */
export function mdzMarkdown(sigil: Sigil): MarkdownConfig {
  const isMdzLine = (text: string) => mdzLineKind(text, sigil) !== null
  return {
    defineNodes: [
      { name: 'MdzLine', block: true },
      { name: 'MdzFence', block: true },
      'MdzInline',
    ],
    parseInline: [
      {
        name: 'MdzInline',
        before: 'Escape',
        parse(cx, next, pos) {
          const sigilCode = sigil.charCodeAt(0)
          if (next !== sigilCode && next !== 92 /* \\ */) return -1
          if (next === 92) {
            const c = cx.char(pos + 1)
            if (c !== sigilCode && c !== 123 /* { */ && c !== 44 /* , */) return -1
            return cx.addElement(cx.elt('MdzInline', pos, pos + 2))
          }
          // Longest include/placeholder may run to the end of the paragraph line.
          const lineEnd = cx.slice(pos, cx.end).indexOf('\n')
          const to = lineEnd === -1 ? cx.end : pos + lineEnd
          const token = scanInline(cx.slice(pos, to), sigil)[0]
          if (!token || token.from !== 0 || (token.type !== 'include' && token.type !== 'placeholder')) return -1
          return cx.addElement(cx.elt('MdzInline', pos, pos + token.to))
        },
      },
    ],
    parseBlock: [
      {
        name: 'MdzFence',
        before: 'FencedCode',
        parse(cx, line) {
          if (line.pos !== 0 || !isTypedFenceOpen(line.text)) return false
          const from = cx.lineStart
          let to = from + line.text.length
          while (cx.nextLine()) {
            to = cx.lineStart + line.text.length
            if (isTypedFenceClose(line.text)) {
              cx.nextLine()
              break
            }
          }
          cx.addElement(cx.elt('MdzFence', from, to))
          return true
        },
        endLeaf: (_cx, line) => line.pos === 0 && isTypedFenceOpen(line.text),
      },
      {
        name: 'MdzLine',
        before: 'ATXHeading',
        parse(cx, line) {
          if (line.pos !== 0 || !isMdzLine(line.text)) return false
          cx.addElement(cx.elt('MdzLine', cx.lineStart, cx.lineStart + line.text.length))
          cx.nextLine()
          return true
        },
        endLeaf: (_cx, line) => line.pos === 0 && isMdzLine(line.text),
      },
    ],
  }
}
