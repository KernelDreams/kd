import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import atomicCss from '@atomic-editor/editor/styles.css?inline'

export type Theme = 'light' | 'dark' | 'auto'

type Palette = Record<string, string>

/** Theme tokens. Every color in the editor reads one of these. */
const LIGHT: Palette = {
  '--nre-bg': '#ffffff',
  '--nre-fg': '#1f2328',
  '--nre-fg-muted': '#59636e',
  '--nre-fg-faint': '#8c959f',
  '--nre-accent': '#6639ba',
  '--nre-accent-soft': '#c4b5fd',
  '--nre-link': '#6d28d9',
  '--nre-border': '#d0d7de',
  '--nre-panel': '#f6f8fa',
  '--nre-surface': '#eaeef2',
  '--nre-selection': 'rgba(130, 80, 223, 0.18)',
  '--nre-active-line': 'rgba(130, 80, 223, 0.05)',
  '--nre-code-bg': '#f5f3fb',
  '--nre-gutter-fg': '#8c959f',
  '--nre-search': 'rgba(251, 189, 8, 0.35)',
  '--nre-search-active': 'rgba(251, 189, 8, 0.6)',

  '--nre-hl-keyword': '#cf222e',
  '--nre-hl-string': '#0a3069',
  '--nre-hl-number': '#0550ae',
  '--nre-hl-comment': '#6e7781',
  '--nre-hl-type': '#953800',
  '--nre-hl-function': '#8250df',
  '--nre-hl-property': '#0550ae',
  '--nre-hl-regexp': '#116329',
  '--nre-hl-escape': '#0550ae',
  '--nre-hl-tag': '#116329',
  '--nre-hl-attribute': '#953800',
  '--nre-hl-variable': '#1f2328',
  '--nre-hl-operator': '#cf222e',
  '--nre-hl-invalid': '#82071e',

  '--nre-mdz-block': '#8250df',
  '--nre-mdz-block-bg': 'rgba(130, 80, 223, 0.07)',
  '--nre-mdz-id': '#bc4c00',
  '--nre-mdz-id-bg': 'rgba(188, 76, 0, 0.09)',
  '--nre-mdz-sigil': '#8250df',
  '--nre-mdz-key': '#0550ae',
  '--nre-mdz-directive': '#cf222e',
  '--nre-mdz-punct': '#8c959f',
  '--nre-mdz-string': '#1f2328',
  '--nre-mdz-quoted': '#0a3069',
  '--nre-mdz-number': '#0550ae',
  '--nre-mdz-bool': '#cf222e',
  '--nre-mdz-null': '#8c959f',
  '--nre-mdz-list': '#116329',
  '--nre-mdz-object': '#953800',
  '--nre-mdz-include': '#0969da',
  '--nre-mdz-placeholder': '#9a6700',
  '--nre-mdz-placeholder-bg': 'rgba(212, 167, 44, 0.16)',
  '--nre-mdz-macro': '#1a7f37',
  '--nre-mdz-escape': '#8c959f',
  '--nre-mdz-role': '#ffffff',
  '--nre-mdz-role-bg': '#0969da',
  '--nre-mdz-role-rule': 'rgba(9, 105, 218, 0.35)',
  '--nre-mdz-muted': '#8c959f',
  '--nre-mdz-fence-bg': '#f6f8fa',
  '--nre-mdz-comment': '#6e7781',
}

const DARK: Palette = {
  '--nre-bg': '#1e1e22',
  '--nre-fg': '#dcddde',
  '--nre-fg-muted': '#9a9aa3',
  '--nre-fg-faint': '#6b6b74',
  '--nre-accent': '#a78bfa',
  '--nre-accent-soft': '#7c6bb8',
  '--nre-link': '#a5b4fc',
  '--nre-border': '#3a3a42',
  '--nre-panel': '#26262c',
  '--nre-surface': '#2e2e35',
  '--nre-selection': 'rgba(167, 139, 250, 0.28)',
  '--nre-active-line': 'rgba(255, 255, 255, 0.035)',
  '--nre-code-bg': '#25252b',
  '--nre-gutter-fg': '#6b6b74',
  '--nre-search': 'rgba(251, 189, 8, 0.25)',
  '--nre-search-active': 'rgba(251, 189, 8, 0.5)',

  '--nre-hl-keyword': '#c792ea',
  '--nre-hl-string': '#c3e88d',
  '--nre-hl-number': '#f78c6c',
  '--nre-hl-comment': '#7f8590',
  '--nre-hl-type': '#ffcb6b',
  '--nre-hl-function': '#82aaff',
  '--nre-hl-property': '#89ddff',
  '--nre-hl-regexp': '#f07178',
  '--nre-hl-escape': '#89ddff',
  '--nre-hl-tag': '#f07178',
  '--nre-hl-attribute': '#ffcb6b',
  '--nre-hl-variable': '#dcddde',
  '--nre-hl-operator': '#89ddff',
  '--nre-hl-invalid': '#ff5370',

  '--nre-mdz-block': '#c4a7ff',
  '--nre-mdz-block-bg': 'rgba(167, 139, 250, 0.10)',
  '--nre-mdz-id': '#ffb86b',
  '--nre-mdz-id-bg': 'rgba(255, 184, 107, 0.12)',
  '--nre-mdz-sigil': '#a78bfa',
  '--nre-mdz-key': '#82aaff',
  '--nre-mdz-directive': '#ff7a93',
  '--nre-mdz-punct': '#6b6b74',
  '--nre-mdz-string': '#dcddde',
  '--nre-mdz-quoted': '#c3e88d',
  '--nre-mdz-number': '#f78c6c',
  '--nre-mdz-bool': '#c792ea',
  '--nre-mdz-null': '#7f8590',
  '--nre-mdz-list': '#7ee0b5',
  '--nre-mdz-object': '#ffcb6b',
  '--nre-mdz-include': '#6cb6ff',
  '--nre-mdz-placeholder': '#ffd866',
  '--nre-mdz-placeholder-bg': 'rgba(255, 216, 102, 0.12)',
  '--nre-mdz-macro': '#7ee0b5',
  '--nre-mdz-escape': '#6b6b74',
  '--nre-mdz-role': '#0d1117',
  '--nre-mdz-role-bg': '#6cb6ff',
  '--nre-mdz-role-rule': 'rgba(108, 182, 255, 0.35)',
  '--nre-mdz-muted': '#6b6b74',
  '--nre-mdz-fence-bg': '#232329',
  '--nre-mdz-comment': '#7f8590',
}

/** Non-color tokens, same in both themes. */
const SHARED: Palette = {
  '--nre-font-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--nre-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  '--nre-font-size': '15px',
}

/** Atomic Editor reads `--atomic-editor-*`; feed it from ours. */
const ATOMIC_BRIDGE: Palette = {
  '--atomic-editor-fg': 'var(--nre-fg)',
  '--atomic-editor-fg-muted': 'var(--nre-fg-muted)',
  '--atomic-editor-fg-faint': 'var(--nre-fg-faint)',
  '--atomic-editor-bg': 'var(--nre-bg)',
  '--atomic-editor-bg-panel': 'var(--nre-panel)',
  '--atomic-editor-bg-surface': 'var(--nre-surface)',
  '--atomic-editor-border': 'var(--nre-border)',
  '--atomic-editor-accent': 'var(--nre-accent)',
  '--atomic-editor-accent-bright': 'var(--nre-accent)',
  '--atomic-editor-accent-soft': 'var(--nre-accent-soft)',
  '--atomic-editor-link': 'var(--nre-link)',
  '--atomic-editor-link-hover': 'var(--nre-accent)',
  '--atomic-editor-code-bg': 'var(--nre-code-bg)',
  '--atomic-editor-selection-bg': 'var(--nre-selection)',
  '--atomic-editor-search-bg': 'var(--nre-search)',
  '--atomic-editor-search-bg-active': 'var(--nre-search-active)',
  '--atomic-editor-font': 'var(--nre-font)',
  '--atomic-editor-font-mono': 'var(--nre-font-mono)',
  '--atomic-editor-body-size': 'var(--nre-font-size)',
  ...Object.fromEntries(
    ['keyword', 'string', 'number', 'comment', 'type', 'function', 'property', 'regexp', 'escape', 'tag', 'variable', 'operator', 'invalid'].map(
      (k) => [`--atomic-editor-hl-${k}`, `var(--nre-hl-${k})`],
    ),
  ),
}

const decls = (p: Palette) =>
  Object.entries(p)
    .map(([k, v]) => `${k}:${v};`)
    .join('')

const EDITOR_CSS = `
:where(.nre-root){${decls(SHARED)}${decls(LIGHT)}--nre-font:var(--nre-font-mono);}
.nre-root.atomic-cm-editor{${decls(ATOMIC_BRIDGE)}}
:where(.nre-root.nre-md){--nre-font:var(--nre-font-sans);}
:where(.nre-root[data-nre-theme="dark"]){${decls(DARK)}}
@media (prefers-color-scheme: dark){:where(.nre-root[data-nre-theme="auto"]){${decls(DARK)}}}

.nre-root{position:relative;height:100%;width:100%;background:var(--nre-bg);color:var(--nre-fg);overflow:hidden}
.nre-root .cm-editor{height:100%;background:var(--nre-bg);color:var(--nre-fg);font-size:var(--nre-font-size)}
.nre-root .cm-editor.cm-focused{outline:none}
.nre-root .cm-scroller{font-family:var(--nre-font);}
.nre-root.nre-code .cm-content{caret-color:var(--nre-accent)}
.nre-root.nre-code .cm-cursor{border-left-color:var(--nre-accent)}
.nre-root .cm-gutters{background:var(--nre-bg);color:var(--nre-gutter-fg);border-right:1px solid var(--nre-border)}
.nre-root .cm-activeLineGutter{background:var(--nre-active-line);color:var(--nre-fg-muted)}
.nre-root.nre-code .cm-activeLine{background:var(--nre-active-line)}
.nre-root .cm-editor .cm-selectionBackground,.nre-root .cm-editor.cm-focused .cm-selectionBackground,.nre-root .cm-content ::selection{background:var(--nre-selection)}
.nre-root .cm-searchMatch{background:var(--nre-search)}
.nre-root .cm-searchMatch-selected{background:var(--nre-search-active)}
.nre-root .cm-panels{background:var(--nre-panel);color:var(--nre-fg);border-color:var(--nre-border)}
.nre-root .cm-panels input,.nre-root .cm-panels button{color:inherit}
.nre-root .cm-textfield{background:var(--nre-bg);border:1px solid var(--nre-border);color:var(--nre-fg)}
.nre-root .cm-button{background:var(--nre-surface);background-image:none;border:1px solid var(--nre-border);color:var(--nre-fg)}
.nre-root .cm-tooltip{background:var(--nre-panel);color:var(--nre-fg);border:1px solid var(--nre-border);border-radius:6px;font-family:var(--nre-font-sans);max-width:min(560px,90vw)}
.nre-root .cm-tooltip-autocomplete ul li[aria-selected]{background:var(--nre-accent);color:var(--nre-bg)}
.nre-root .cm-tooltip code,.nre-root .cm-tooltip pre{font-family:var(--nre-font-mono)}
.nre-root .cm-foldPlaceholder{background:var(--nre-surface);border:1px solid var(--nre-border);color:var(--nre-fg-muted);padding:0 6px;border-radius:4px}
.nre-root .cm-foldGutter span{color:var(--nre-fg-faint)}
.nre-root .cm-matchingBracket{background:var(--nre-selection);outline:none}
.nre-root .cm-diagnostic{font-family:var(--nre-font-sans)}
.nre-root.nre-md .cm-gutters{border-right:none}
.nre-root.nre-md .cm-content{padding-top:12px;padding-left:16px;padding-right:16px;box-sizing:border-box}
@media (max-width:640px){.nre-root.nre-md .cm-content{padding-left:10px;padding-right:10px}}

/* nrd layer (mdz / mds / mdd / md). Markup stays visible, only styled. */
.nre-root .nre-mdz-line-heading{font-family:var(--nre-font-mono);font-weight:600;color:var(--nre-mdz-block);background:var(--nre-mdz-block-bg);border-radius:4px;padding-top:2px!important;padding-bottom:2px!important}
.nre-root .nre-mdz-line-heading.nre-mdz-h1{font-size:1.45em;margin-top:.4em}
.nre-root .nre-mdz-line-heading.nre-mdz-h2{font-size:1.25em}
.nre-root .nre-mdz-line-heading.nre-mdz-h3{font-size:1.1em}
.nre-root .nre-mdz-line-heading.nre-mdz-h4,.nre-root .nre-mdz-line-heading.nre-mdz-h5,.nre-root .nre-mdz-line-heading.nre-mdz-h6{font-size:1em}
.nre-root .nre-mdz-heading-mark{color:var(--nre-mdz-muted);font-weight:400}
.nre-root .nre-mdz-block-sigil{color:var(--nre-mdz-sigil)}
.nre-root .nre-mdz-block-name{color:var(--nre-mdz-block);font-weight:700}
.nre-root .nre-mdz-block-id{color:var(--nre-mdz-id);background:var(--nre-mdz-id-bg);border-radius:4px;padding:0 4px;font-weight:500}
.nre-root .nre-mdz-line-close{font-family:var(--nre-font-mono);color:var(--nre-mdz-muted);font-size:.85em;opacity:.75}
.nre-root .nre-mdz-block-close{color:var(--nre-mdz-muted)}
.nre-root .nre-mdz-line-attr{font-family:var(--nre-font-mono);font-size:.9em}
.nre-root .nre-mdz-attr-sigil{color:var(--nre-mdz-sigil)}
.nre-root .nre-mdz-attr-key{color:var(--nre-mdz-key)}
.nre-root .nre-mdz-directive{color:var(--nre-mdz-directive);font-weight:600}
.nre-root .nre-mdz-attr-colon{color:var(--nre-mdz-punct)}
.nre-root .nre-mdz-value{color:var(--nre-mdz-string)}
.nre-root .nre-mdz-value-quoted{color:var(--nre-mdz-quoted)}
.nre-root .nre-mdz-value-number{color:var(--nre-mdz-number)}
.nre-root .nre-mdz-value-bool{color:var(--nre-mdz-bool);font-weight:600}
.nre-root .nre-mdz-value-null{color:var(--nre-mdz-null);font-style:italic}
.nre-root .nre-mdz-value-list{color:var(--nre-mdz-list)}
.nre-root .nre-mdz-value-object{color:var(--nre-mdz-object)}
.nre-root .nre-mdz-include{color:var(--nre-mdz-include);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--nre-mdz-include) 45%,transparent);text-underline-offset:2px;cursor:pointer}
.nre-root .nre-mdz-placeholder{color:var(--nre-mdz-placeholder);background:var(--nre-mdz-placeholder-bg);border-radius:3px;font-family:var(--nre-font-mono);font-size:.94em}
.nre-root .nre-mdz-placeholder .nre-mdz-placeholder{background:none}
.nre-root .nre-mdz-macro{color:var(--nre-mdz-macro);font-family:var(--nre-font-mono);font-size:.94em}
.nre-root .nre-mdz-escape{color:var(--nre-mdz-escape)}
.nre-root .nre-mdz-line-role{border-top:2px solid var(--nre-mdz-role-rule);margin-top:10px;padding-top:4px!important}
.nre-root .nre-mdz-role{color:var(--nre-mdz-role);background:var(--nre-mdz-role-bg);border-radius:4px;padding:1px 7px;font-family:var(--nre-font-mono);font-size:.82em;font-weight:700;letter-spacing:.02em}
.nre-root .nre-mdz-line-fence{font-family:var(--nre-font-mono);font-size:.88em;color:var(--nre-mdz-muted);background:var(--nre-mdz-fence-bg);padding-left:10px!important;border-left:3px solid var(--nre-border)}
.nre-root .nre-mdz-fence-mark{color:var(--nre-mdz-muted);font-weight:600}
.nre-root .nre-mdz-line-comment{font-style:italic;font-family:var(--nre-font-mono);font-size:.9em}
.nre-root .nre-mdz-comment{color:var(--nre-mdz-comment)}
`

/** Injects the editor stylesheet (Atomic live preview + ours) once per document. */
export function ensureStyles(doc: Document): void {
  if (doc.getElementById('nre-styles')) return
  const style = doc.createElement('style')
  style.id = 'nre-styles'
  style.textContent = `${atomicCss}\n${EDITOR_CSS}`
  doc.head.appendChild(style)
}

/** Syntax colors for code modes. */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--nre-hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--nre-hl-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--nre-hl-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--nre-hl-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: 'var(--nre-hl-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--nre-hl-function)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--nre-hl-property)' },
  { tag: [t.regexp], color: 'var(--nre-hl-regexp)' },
  { tag: [t.escape], color: 'var(--nre-hl-escape)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--nre-hl-tag)' },
  { tag: [t.attributeName], color: 'var(--nre-hl-attribute)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--nre-hl-variable)' },
  { tag: [t.operator, t.derefOperator], color: 'var(--nre-hl-operator)' },
  { tag: [t.invalid], color: 'var(--nre-hl-invalid)' },
  { tag: [t.heading], fontWeight: '700', color: 'var(--nre-hl-keyword)' },
  { tag: [t.link, t.url], color: 'var(--nre-link)', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--nre-fg-muted)' },
])

export const codeHighlighting = syntaxHighlighting(codeHighlightStyle)
