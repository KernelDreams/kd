import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge'
import { type Mode, isMarkdownMode, modeFromFilename } from './modes'
import { loadLanguage } from './languages'
import { codeHighlighting, ensureStyles, type Theme } from './theme'

/** `split` — side by side; `unified` — one column, removed lines inline. */
export type DiffLayout = 'split' | 'unified'

export interface DiffOptions {
  parent: HTMLElement
  /** Left side (HEAD, index, a commit). */
  original: string
  /** Right side (working copy or another commit). */
  modified: string
  mode?: Mode
  filename?: string
  layout?: DiffLayout
  theme?: Theme
  /** Right side is editable (working copy). Default `false`. */
  editable?: boolean
  onChange?: (text: string) => void
  /** Mod-s / F2 on the right side. */
  onSave?: (text: string) => void
}

export interface DiffHandle {
  /** Right side text. */
  getText(): string
  /** Replace both sides; edit history is dropped. */
  setTexts(original: string, modified: string): void
  setLayout(layout: DiffLayout): void
  layout(): DiffLayout
  /** Move to the next / previous change; `false` — nothing there. */
  next(): boolean
  prev(): boolean
  /** Number of changed chunks. */
  chunks(): number
  /** The editor that holds the right side (`b` of the split view or the unified one). */
  view(): EditorView
  setTheme(theme: Theme): void
  focus(): void
  destroy(): void
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Diff of two texts on `@codemirror/merge`: side by side (`MergeView`) or one column
 * (`unifiedMergeView`), syntax by file name, jump between changes, editable right side.
 */
export function createDiff(opts: DiffOptions): DiffHandle {
  const doc = opts.parent.ownerDocument
  ensureStyles(doc)
  const mode: Mode = opts.mode ?? (opts.filename ? modeFromFilename(opts.filename) : 'text')
  let theme: Theme = opts.theme ?? 'auto'
  let layout: DiffLayout = opts.layout ?? 'split'
  let original = opts.original
  let modified = opts.modified
  let language: Extension = isMarkdownMode(mode) ? markdown() : []
  const languageComp = new Compartment()
  const themeComp = new Compartment()
  const themeExt = (): Extension => EditorView.darkTheme.of(theme === 'dark' || (theme === 'auto' && prefersDark()))

  const root = doc.createElement('div')
  root.className = 'nre-root nre-code nre-diff'
  root.dataset.nreTheme = theme
  opts.parent.appendChild(root)

  const base = (): Extension[] => [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    codeHighlighting,
    search({ top: true }),
    languageComp.of(language),
    themeComp.of(themeExt()),
  ]
  const saveKeys = Prec.highest(
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (opts.onSave?.(getText()), true) },
      { key: 'F2', preventDefault: true, run: () => (opts.onSave?.(getText()), true) },
      { key: 'Alt-ArrowDown', preventDefault: true, run: goToNextChunk },
      { key: 'Alt-ArrowUp', preventDefault: true, run: goToPreviousChunk },
      { key: 'F7', preventDefault: true, run: goToNextChunk },
      { key: 'Shift-F7', preventDefault: true, run: goToPreviousChunk },
    ]),
  )
  const right = (): Extension[] => [
    ...base(),
    saveKeys,
    highlightActiveLine(),
    history(),
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorState.readOnly.of(!opts.editable),
    EditorView.editable.of(opts.editable === true),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        modified = u.state.doc.toString()
        opts.onChange?.(modified)
      }
    }),
  ]
  const left = (): Extension[] => [...base(), saveKeys, keymap.of([...searchKeymap, ...defaultKeymap]), EditorState.readOnly.of(true), EditorView.editable.of(false)]

  let merge: MergeView | null = null
  let single: EditorView | null = null

  function build(): void {
    root.dataset.nreLayout = layout
    if (layout === 'split') {
      merge = new MergeView({
        a: { doc: original, extensions: left() },
        b: { doc: modified, extensions: right() },
        parent: root,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 8 },
      })
    } else {
      single = new EditorView({
        parent: root,
        state: EditorState.create({ doc: modified, extensions: [...right(), unifiedMergeView({ original, gutter: true, highlightChanges: true, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 8 } })] }),
      })
    }
  }
  function teardown(): void {
    merge?.destroy()
    single?.destroy()
    merge = null
    single = null
  }
  const view = (): EditorView => (merge ? merge.b : single!)
  function getText(): string {
    return view().state.doc.toString()
  }
  const move = (cmd: typeof goToNextChunk): boolean => {
    const v = view()
    return cmd({ state: v.state, dispatch: (tr) => v.dispatch(tr, { scrollIntoView: true }) as void })
  }

  build()
  let destroyed = false
  void loadLanguage(mode)
    .then((ext) => {
      if (destroyed || isMarkdownMode(mode)) return
      language = ext
      for (const v of merge ? [merge.a, merge.b] : [single!]) v.dispatch({ effects: languageComp.reconfigure(language) })
    })
    .catch(() => undefined)

  return {
    getText,
    setTexts(a, b) {
      original = a
      modified = b
      teardown()
      build()
    },
    setLayout(next) {
      if (next === layout) return
      modified = getText()
      layout = next
      teardown()
      build()
    },
    layout: () => layout,
    next: () => move(goToNextChunk),
    prev: () => move(goToPreviousChunk),
    chunks: () => getChunks(view().state)?.chunks.length ?? 0,
    view,
    setTheme(next) {
      theme = next
      root.dataset.nreTheme = theme
      for (const v of merge ? [merge.a, merge.b] : [single!]) v.dispatch({ effects: themeComp.reconfigure(themeExt()) })
    },
    focus: () => view().focus(),
    destroy() {
      destroyed = true
      teardown()
      root.remove()
    },
  }
}
