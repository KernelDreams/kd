import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { NrEditor } from '../src/react'
import type { EditorHandle } from '../src/editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('<NrEditor>', () => {
  it('ref gives the handle; value is controlled; onChange reports edits', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const ref = createRef<EditorHandle>()
    const onChange = vi.fn()
    const render = (value: string, mode: 'md' | 'ts' = 'md') =>
      act(() => root.render(createElement(NrEditor, { value, mode, onChange, ref, theme: 'dark' })))

    await render('# one')
    expect(ref.current!.getText()).toBe('# one')
    expect(host.querySelector('.nre-root')!.getAttribute('data-nre-theme')).toBe('dark')

    await render('# two\r\n')
    expect(ref.current!.getText()).toBe('# two\r\n')
    expect(onChange).not.toHaveBeenCalled()

    act(() => ref.current!.view.dispatch({ changes: { from: 0, insert: 'x' } }))
    expect(onChange).toHaveBeenLastCalledWith('x# two\r\n')

    await render('x# two\r\n', 'ts')
    expect(host.querySelector('.nre-root')!.getAttribute('data-nre-mode')).toBe('ts')

    await act(() => root.unmount())
    expect(host.querySelector('.nre-root')).toBeNull()
  })
})
