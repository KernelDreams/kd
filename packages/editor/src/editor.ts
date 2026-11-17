import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { lintKeymap } from '@codemirror/lint'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import {
  atomicEditorTheme,
  atomicMarkdownSyntax,
  autoCloseCodeFence,
  extendEmphasisPair,
  highlightMarkdown,
  imageBlocks,
  inlinePreview,
  readOnlyExtension,
  startAsteriskList,
  tables,
  wikiLinks,
} from '@atomic-editor/editor'
import { type Mode, isMarkdownMode, isScriptMode, modeFromFilename, sigilOf } from './modes'
import { FENCE_LANGUAGES, loadLanguage } from './languages'
import { codeHighlighting, ensureStyles, type Theme } from './theme'
import { mdzMarkdown } from './mdz/markdown-ext'
import { mdzExtension } from './mdz/extension'

export interface EditorOptions {
  parent: HTMLElement
  text?: string
  /** Explicit mode, wins over `filename`. */
  mode?: Mode
  /** Mode by file extension. */
  filename?: string
  readOnly?: boolean
  /** `auto` follows `prefers-color-scheme`. Default `auto`. */
  theme?: Theme
  /** TS language service for ts/tsx/js/jsx. Default `false`. */
  typescript?: boolean | { worker: Worker }
  /** Extra CodeMirror extensions of the consumer. */
  extensions?: Extension[]
  onChange?: (text: string) => void
  /** Mod-s. */
  onSave?: (text: string) => void
  /** Wiki links `[[x]]` and includes `$[[x]]`. */
  onLinkClick?: (target: string) => void
}

export interface EditorHandle {
  view: EditorView
  getText(): string
  /** Replaces the document; undo history is not kept. */
  setText(text: string): void
  setMode(mode: Mode): Promise<void>
  setTheme(theme: Theme): void
  setReadOnly(v: boolean): void
  focus(): void
  destroy(): void
}

const BOM = '\ufeff'

/** CodeMirror's default special chars minus `\r` (kept as content in mixed-EOL files). */
const SPECIAL_CHARS_NO_CR =
  /[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]/

interface RawText {
  bom: boolean
  body: string
  /** Separator CodeMirror splits and joins lines with. */
  separator: '\n' | '\r\n' | '\r'
  /** Line endings are mixed: `\r` survives inside lines as content. */
  mixed: boolean
}

/**
 * Raw text is the source of truth: the BOM is held aside, and the document
 * uses the file's own line separator, so `getText()` returns exactly the
 * bytes `setText()` got. Mixed endings split on `\n` only; a stray `\r`
 * stays in the line as an (invisible) character.
 */
export function analyzeText(text: string): RawText {
  const bom = text.startsWith(BOM)
  const body = bom ? text.slice(1) : text
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    if (c === 13) {
      if (body.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else cr++
    } else if (c === 10) lf++
  }
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0)
  if (kinds > 1) return { bom, body, separator: '\n', mixed: true }
  return { bom, body, separator: crlf ? '\r\n' : cr ? '\r' : '\n', mixed: false }
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const doc = opts.parent.ownerDocument
  ensureStyles(doc)

  let mode: Mode = opts.mode ?? (opts.filename ? modeFromFilename(opts.filename) : 'text')
  let theme: Theme = opts.theme ?? 'auto'
  let readOnly = opts.readOnly ?? false
  let raw = analyzeText(opts.text ?? '')
  /** Language of the current code mode once loaded (markdown modes are sync). */
  let languageExt: Extension = []
  let tsExt: Extension = []
  let modeVersion = 0
  /** Include targets of the nrd layer — wiki-link rendering skips them. */
  let includeTargets: ReadonlySet<string> = new Set()

  const root = doc.createElement('div')
  root.className = 'nre-root'
  opts.parent.appendChild(root)

  const modeComp = new Compartment()
  const languageComp = new Compartment()
  const tsComp = new Compartment()
  const themeComp = new Compartment()
  const readOnlyComp = new Compartment()

  const getText = () => (raw.bom ? BOM : '') + view.state.sliceDoc()

  const onLinkClick = (target: string) => opts.onLinkClick?.(target)

  function markdownExtensions(m: Mode): Extension {
    const sigil = sigilOf(m) ?? '@'
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: FENCE_LANGUAGES,
        extensions: [highlightMarkdown, mdzMarkdown(sigil)],
      }),
      atomicMarkdownSyntax,
      atomicEditorTheme,
      Prec.high(keymap.of(markdownKeymap)),
      startAsteriskList,
      extendEmphasisPair,
      autoCloseCodeFence,
      tables(),
      imageBlocks(),
      inlinePreview(),
      wikiLinks({
        onOpen: onLinkClick,
        // Bare `[[x]]` renders as a link labelled with its target.
        resolve: async (target) => ({ target, label: target, status: 'resolved' }),
        // `$[[x]]` / `@[[x]]` is an include: the mdz layer owns it and keeps it visible.
        shouldResolve: (target) => !includeTargets.has(target),
      }),
      mdzExtension({
        sigil,
        onLinkClick,
        onIncludes: (targets) => {
          includeTargets = targets
        },
      }),
      foldGutter(),
      EditorView.lineWrapping,
      highlightActiveLine(),
    ]
  }

  function codeExtensions(): Extension {
    return [
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      codeHighlighting,
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...lintKeymap]),
    ]
  }

  function modeExtensions(m: Mode): Extension {
    return isMarkdownMode(m) ? markdownExtensions(m) : codeExtensions()
  }

  function themeExtension(t: Theme): Extension {
    const dark = t === 'dark' || (t === 'auto' && prefersDark())
    return EditorView.darkTheme.of(dark)
  }

  function readOnlyExtensions(v: boolean): Extension {
    return [EditorState.readOnly.of(v), isMarkdownMode(mode) ? readOnlyExtension(v) : []]
  }

  function applyRootAttributes() {
    const md = isMarkdownMode(mode)
    root.classList.toggle('nre-md', md)
    root.classList.toggle('atomic-cm-editor', md)
    root.classList.toggle('nre-code', !md)
    root.dataset.nreTheme = theme
    root.dataset.nreMode = mode
  }

  function createState(): EditorState {
    return EditorState.create({
      doc: raw.body,
      extensions: [
        EditorState.lineSeparator.of(raw.separator),
        raw.mixed ? highlightSpecialChars({ specialChars: SPECIAL_CHARS_NO_CR }) : highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        search({ top: true }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                opts.onSave?.(getText())
                return true
              },
            },
          ]),
        ),
        keymap.of([...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab, ...defaultKeymap]),
        modeComp.of(modeExtensions(mode)),
        languageComp.of(languageExt),
        tsComp.of(tsExt),
        themeComp.of(themeExtension(theme)),
        readOnlyComp.of(readOnlyExtensions(readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) opts.onChange?.(getText())
        }),
        ...(opts.extensions ?? []),
      ],
    })
  }

  applyRootAttributes()
  const view = new EditorView({ state: createState(), parent: root })

  /** Loads the language and, if enabled, the TS service for a code mode. */
  async function loadModeAsync(m: Mode, version: number): Promise<void> {
    if (isMarkdownMode(m) || m === 'text') return
    const language = await loadLanguage(m)
    if (version !== modeVersion || destroyed) return
    languageExt = language
    view.dispatch({ effects: languageComp.reconfigure(languageExt) })
    const tsOpt = opts.typescript
    if (tsOpt && isScriptMode(m)) {
      const { typescriptService } = await import('./ts/service')
      const ext = await typescriptService(m, typeof tsOpt === 'object' ? tsOpt.worker : undefined)
      if (version !== modeVersion || destroyed) return
      tsExt = ext
      view.dispatch({ effects: tsComp.reconfigure(tsExt) })
    }
  }

  let destroyed = false
  let mediaQuery: MediaQueryList | null = null
  const onSchemeChange = () => {
    if (theme === 'auto') view.dispatch({ effects: themeComp.reconfigure(themeExtension(theme)) })
  }
  if (typeof matchMedia === 'function') {
    mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener?.('change', onSchemeChange)
  }

  const initialLoad = loadModeAsync(mode, modeVersion)
  initialLoad.catch((err: unknown) => console.error('[nr-editor] mode load failed', err))

  const handle: EditorHandle = {
    view,
    getText,
    setText(text: string) {
      raw = analyzeText(text)
      view.setState(createState())
    },
    async setMode(next: Mode) {
      const version = ++modeVersion
      mode = next
      languageExt = []
      tsExt = []
      applyRootAttributes()
      view.dispatch({
        effects: [
          modeComp.reconfigure(modeExtensions(mode)),
          languageComp.reconfigure(languageExt),
          tsComp.reconfigure(tsExt),
          readOnlyComp.reconfigure(readOnlyExtensions(readOnly)),
        ],
      })
      await loadModeAsync(next, version)
    },
    setTheme(next: Theme) {
      theme = next
      applyRootAttributes()
      view.dispatch({ effects: themeComp.reconfigure(themeExtension(theme)) })
    },
    setReadOnly(v: boolean) {
      readOnly = v
      view.dispatch({ effects: readOnlyComp.reconfigure(readOnlyExtensions(readOnly)) })
    },
    focus() {
      view.focus()
    },
    destroy() {
      destroyed = true
      mediaQuery?.removeEventListener?.('change', onSchemeChange)
      view.destroy()
      root.remove()
    },
  }
  return handle
}
