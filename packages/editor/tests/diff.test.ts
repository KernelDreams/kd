import { describe, expect, it, vi } from 'vitest'
import { createDiff } from '../src/diff'

const A = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'].join('\n')
const B = A.replace('two', 'TWO').replace('fourteen', 'FOURTEEN')

describe('createDiff', () => {
  it('split: two editors, chunks, next/prev, read-only by default', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const d = createDiff({ parent, original: A, modified: B, filename: 'x.ts' })
    expect(parent.querySelectorAll('.cm-editor')).toHaveLength(2)
    expect(parent.querySelector('.nre-diff')!.getAttribute('data-nre-layout')).toBe('split')
    expect(d.chunks()).toBe(2)
    expect(d.next()).toBe(true)
    const line = (): number => d.view().state.doc.lineAt(d.view().state.selection.main.head).number
    expect(line()).toBe(2)
    expect(d.next()).toBe(true)
    expect(line()).toBe(14)
    expect(d.prev()).toBe(true)
    expect(line()).toBe(2)
    expect(d.view().state.readOnly).toBe(true)
    d.destroy()
    expect(parent.children).toHaveLength(0)
  })

  it('unified, editable right side, save, layout switch keeps edits', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const onSave = vi.fn()
    const onChange = vi.fn()
    const d = createDiff({ parent, original: A, modified: B, layout: 'unified', editable: true, onSave, onChange })
    expect(parent.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect(d.chunks()).toBe(2)
    d.view().dispatch({ changes: { from: 0, insert: 'X' } })
    expect(onChange).toHaveBeenLastCalledWith(`X${B}`)
    d.setLayout('split')
    expect(parent.querySelectorAll('.cm-editor')).toHaveLength(2)
    expect(d.getText()).toBe(`X${B}`)
    d.setTexts('a', 'a')
    expect(d.chunks()).toBe(0)
    d.destroy()
  })
})
