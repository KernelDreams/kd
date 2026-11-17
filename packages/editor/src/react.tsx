import { type CSSProperties, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { Extension } from '@codemirror/state'
import { createEditor, type EditorHandle } from './editor'
import { createDiff, type DiffHandle, type DiffLayout } from './diff'
import { type Mode, modeFromFilename } from './modes'
import type { Theme } from './theme'

export interface NrEditorProps {
  /** Controlled text: a change that differs from the editor's text → `setText`. */
  value: string
  onChange?: (text: string) => void
  mode?: Mode
  filename?: string
  theme?: Theme
  readOnly?: boolean
  typescript?: boolean | { worker: Worker }
  /** Captured at mount. */
  extensions?: Extension[]
  onSave?: (text: string) => void
  onLinkClick?: (target: string) => void
  className?: string
  style?: CSSProperties
}

/** Thin React wrapper over the vanilla core; `ref` gives the `EditorHandle`. */
export const NrEditor = forwardRef<EditorHandle | null, NrEditorProps>(function NrEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<EditorHandle | null>(null)
  // Callbacks change every render; the editor reads them through this ref.
  const latest = useRef(props)
  latest.current = props

  // `typescript` is mount-time; an inline `{ worker }` object must not remount on every render.
  const tsKey = typeof props.typescript === 'object' ? props.typescript.worker : Boolean(props.typescript)

  // Layout effect, declared before useImperativeHandle: the ref sees the handle.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = latest.current
    const handle = createEditor({
      parent: host,
      text: p.value,
      mode: p.mode,
      filename: p.filename,
      theme: p.theme,
      readOnly: p.readOnly,
      typescript: p.typescript,
      extensions: p.extensions,
      onChange: (text) => latest.current.onChange?.(text),
      onSave: (text) => latest.current.onSave?.(text),
      onLinkClick: (target) => latest.current.onLinkClick?.(target),
    })
    handleRef.current = handle
    return () => {
      handle.destroy()
      handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsKey])

  useImperativeHandle(ref, () => handleRef.current as EditorHandle, [tsKey])

  useEffect(() => {
    const handle = handleRef.current
    if (handle && props.value !== handle.getText()) handle.setText(props.value)
  }, [props.value])

  const modeKey = props.mode ?? props.filename
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || modeKey === undefined) return
    const { mode, filename } = latest.current
    void handle.setMode(mode ?? modeFromFilename(filename!))
  }, [modeKey])

  useEffect(() => {
    handleRef.current?.setTheme(props.theme ?? 'auto')
  }, [props.theme])

  useEffect(() => {
    handleRef.current?.setReadOnly(props.readOnly ?? false)
  }, [props.readOnly])

  return <div ref={hostRef} className={props.className} style={{ height: '100%', ...props.style }} />
})

export interface NrDiffProps {
  /** Left side; a change rebuilds the view. */
  original: string
  /** Right side; a change that differs from the editor's text rebuilds the view. */
  modified: string
  mode?: Mode
  filename?: string
  layout?: DiffLayout
  theme?: Theme
  editable?: boolean
  onChange?: (text: string) => void
  onSave?: (text: string) => void
  className?: string
  style?: CSSProperties
}

/** Diff of two texts (`@codemirror/merge`); `ref` gives the `DiffHandle`. File name/mode — at mount. */
export const NrDiff = forwardRef<DiffHandle | null, NrDiffProps>(function NrDiff(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<DiffHandle | null>(null)
  const latest = useRef(props)
  latest.current = props
  const modeKey = props.mode ?? props.filename ?? ''

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = latest.current
    const handle = createDiff({
      parent: host,
      original: p.original,
      modified: p.modified,
      mode: p.mode,
      filename: p.filename,
      layout: p.layout,
      theme: p.theme,
      editable: p.editable,
      onChange: (text) => latest.current.onChange?.(text),
      onSave: (text) => latest.current.onSave?.(text),
    })
    handleRef.current = handle
    return () => {
      handle.destroy()
      handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeKey, props.editable])

  useImperativeHandle(ref, () => handleRef.current as DiffHandle, [modeKey, props.editable])

  const lastOriginal = useRef(props.original)
  useEffect(() => {
    const h = handleRef.current
    if (!h) return
    if (props.original !== lastOriginal.current || props.modified !== h.getText()) h.setTexts(props.original, props.modified)
    lastOriginal.current = props.original
  }, [props.original, props.modified])

  useEffect(() => {
    if (props.layout) handleRef.current?.setLayout(props.layout)
  }, [props.layout])

  useEffect(() => {
    handleRef.current?.setTheme(props.theme ?? 'auto')
  }, [props.theme])

  return <div ref={hostRef} className={props.className} style={{ height: '100%', overflow: 'auto', ...props.style }} />
})

export type { EditorHandle } from './editor'
export type { DiffHandle, DiffLayout } from './diff'
export type { Mode } from './modes'
export type { Theme } from './theme'
