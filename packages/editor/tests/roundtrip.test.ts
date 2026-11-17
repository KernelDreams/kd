import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditor, type EditorHandle } from '../src/editor'

const samplesDir = resolve(process.cwd(), 'demo/samples') + '/'
const samples = readdirSync(samplesDir).sort()
const BOM = String.fromCharCode(0xfeff)

const open: EditorHandle[] = []
function make(text: string, filename: string, extra: Partial<Parameters<typeof createEditor>[0]> = {}) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const handle = createEditor({ parent, text, filename, ...extra })
  open.push(handle)
  return handle
}

afterEach(() => {
  while (open.length) open.pop()!.destroy()
  document.body.innerHTML = ''
})

describe('round-trip: getText() === text', () => {
  it('has all the samples from the spec', () => {
    expect(samples).toEqual([
      'ci.yaml', 'component.tsx', 'config.json', 'data.mdd', 'game.ts',
      'page.html', 'readme.md', 'recipe.mdz', 'session.mds', 'styles.css',
    ])
  })

  for (const name of samples) {
    const text = readFileSync(samplesDir + name, 'utf8')
    const variants: Record<string, string> = {
      LF: text,
      CRLF: text.replace(/\n/g, '\r\n'),
      'BOM + CRLF': BOM + text.replace(/\n/g, '\r\n'),
      'BOM + LF': BOM + text,
      CR: text.replace(/\n/g, '\r'),
      mixed: text.split('\n').map((l, i) => l + (i % 3 === 0 ? '\r\n' : i % 3 === 1 ? '\n' : '\r')).join(''),
      'trailing spaces/tabs': text.replace(/\n/g, '  \t\n'),
    }
    for (const [variant, input] of Object.entries(variants)) {
      it(`${name} (${variant})`, () => {
        const editor = make(input, name)
        expect(editor.getText()).toBe(input)
        editor.setText(input)
        expect(editor.getText()).toBe(input)
      })
    }
  }

  it('edge cases', () => {
    for (const input of ['', BOM, '\n', '\r\n', '\r', '\n\n\r\n', BOM + '\r\n', 'no newline', 'a\u0000b', '  ']) {
      expect(make(input, 'x.md').getText()).toBe(input)
      expect(make(input, 'x.ts').getText()).toBe(input)
    }
  })

  it('survives a mode switch and re-theme', async () => {
    const input = BOM + readFileSync(samplesDir + 'recipe.mdz', 'utf8').replace(/\n/g, '\r\n')
    const editor = make(input, 'recipe.mdz')
    await editor.setMode('ts')
    editor.setTheme('dark')
    editor.setReadOnly(true)
    await editor.setMode('mdz')
    expect(editor.getText()).toBe(input)
  })
})

describe('editing', () => {
  it('keeps BOM and CRLF in onChange and new lines', () => {
    const changes: string[] = []
    const editor = make(`${BOM}a\r\nb`, 'x.md', { onChange: (t) => changes.push(t) })
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '\r\nc' } })
    expect(editor.getText()).toBe(`${BOM}a\r\nb\r\nc`)
    expect(changes).toEqual([`${BOM}a\r\nb\r\nc`])
    // Enter inserts the file's own separator.
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: editor.view.state.lineBreak + 'd' } })
    expect(editor.getText()).toBe(`${BOM}a\r\nb\r\nc\r\nd`)
  })

  it('setText does not fire onChange', () => {
    const changes: string[] = []
    const editor = make('a', 'x.md', { onChange: (t) => changes.push(t) })
    editor.setText('b')
    expect(changes).toEqual([])
    expect(editor.getText()).toBe('b')
  })

  it('readOnly blocks user edits', () => {
    const editor = make('a', 'x.md', { readOnly: true })
    expect(editor.view.state.readOnly).toBe(true)
    editor.setReadOnly(false)
    expect(editor.view.state.readOnly).toBe(false)
  })
})
