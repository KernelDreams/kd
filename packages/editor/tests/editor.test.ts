import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syntaxTree } from '@codemirror/language'
import { runScopeHandlers } from '@codemirror/view'
import { createEditor, type EditorHandle } from '../src/editor'

const sample = (name: string) => readFileSync(resolve(process.cwd(), 'demo/samples', name), 'utf8')

const open: EditorHandle[] = []
function make(opts: Partial<Parameters<typeof createEditor>[0]>) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const handle = createEditor({ parent, ...opts })
  open.push(handle)
  return handle
}
afterEach(() => {
  while (open.length) open.pop()!.destroy()
})

function nodeNames(editor: EditorHandle, line: number): string[] {
  const { state } = editor.view
  const pos = state.doc.line(line).from
  const names: string[] = []
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) names.push(node.name)
  return names
}

describe('modes', () => {
  it('mode wins over filename; filename picks by extension', () => {
    expect(make({ filename: 'a.ts', mode: 'json' }).view.dom.parentElement!.dataset.nreMode).toBe('json')
    expect(make({ filename: 'a.mdz' }).view.dom.parentElement!.dataset.nreMode).toBe('mdz')
    expect(make({}).view.dom.parentElement!.dataset.nreMode).toBe('text')
  })

  it('markdown modes get live-preview classes, code modes do not', () => {
    const md = make({ filename: 'a.md', text: '# hi' }).view.dom.parentElement!
    expect(md.classList.contains('atomic-cm-editor')).toBe(true)
    const ts = make({ filename: 'a.ts' }).view.dom.parentElement!
    expect(ts.classList.contains('nre-code')).toBe(true)
    expect(ts.classList.contains('atomic-cm-editor')).toBe(false)
  })

  it('code languages load lazily', async () => {
    const editor = make({ filename: 'a.json', text: '{"a": 1}' })
    await editor.setMode('json')
    expect(syntaxTree(editor.view.state).topNode.name).toBe('JsonText')
  })

  it('theme attribute follows setTheme', () => {
    const editor = make({ filename: 'a.md', theme: 'dark' })
    const root = editor.view.dom.parentElement!
    expect(root.dataset.nreTheme).toBe('dark')
    editor.setTheme('light')
    expect(root.dataset.nreTheme).toBe('light')
  })
})

describe('nrd layer in markdown modes', () => {
  it('nrd lines are opaque for the markdown parser', () => {
    const editor = make({ filename: 'recipe.mdz', text: sample('recipe.mdz') })
    const lines = editor.view.state.doc.toString().split('\n')
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix)) + 1
    expect(nodeNames(editor, at('## $step load'))).toContain('MdzLine')
    expect(nodeNames(editor, at('## $step load'))).not.toContain('ATXHeading2')
    expect(nodeNames(editor, at('$title:'))).toContain('MdzLine')
    expect(nodeNames(editor, at('## $@'))).toContain('MdzLine')
    expect(nodeNames(editor, at('### Rules'))).toContain('ATXHeading3')
  })

  it('body-text includes, placeholders and nrd escapes are not markdown links/escapes', () => {
    const editor = make({ filename: 'a.mdz', text: 'see $[[snippets/a.mdz]] and ${x.[0]} \\$no \\[md]' })
    const names = (needle: string, offset = 1) => {
      const text = editor.view.state.doc.toString()
      return syntaxTree(editor.view.state).resolveInner(text.indexOf(needle) + offset, 1).name
    }
    expect(names('$[[', 3)).toBe('MdzInline')
    expect(names('${', 3)).toBe('MdzInline')
    expect(names('\\$', 0)).toBe('MdzInline')
    expect(names('\\[', 0)).toBe('Escape')
  })

  it('typed fences are opaque nodes in mds', () => {
    const editor = make({ filename: 'session.mds', text: sample('session.mds') })
    const lines = editor.view.state.doc.toString().split('\n')
    const fence = lines.indexOf('````%thinking') + 1
    expect(nodeNames(editor, fence)).toContain('MdzFence')
    expect(nodeNames(editor, fence + 2)).toContain('MdzFence')
    expect(nodeNames(editor, lines.indexOf('%user') + 1)).toContain('MdzLine')
  })

  it('foreign sigil is plain markdown', () => {
    const editor = make({ filename: 'data.mdd', text: '$model: x\n@model: y' })
    expect(nodeNames(editor, 1)).not.toContain('MdzLine')
    expect(nodeNames(editor, 2)).toContain('MdzLine')
  })

  it('renders token classes', () => {
    const editor = make({ filename: 'recipe.mdz', text: '## $step load\n$nr-type: file\n$n: 4\nText ${x} $[[a/b.mdz#S]]' })
    const dom = editor.view.contentDOM
    expect(dom.querySelector('.nre-mdz-block-name')?.textContent).toBe('step')
    expect(dom.querySelector('.nre-mdz-block-id')?.textContent).toBe('load')
    expect(dom.querySelector('.nre-mdz-directive')?.textContent).toBe('nr-type')
    expect(dom.querySelector('.nre-mdz-value-number')?.textContent).toBe('4')
    expect(dom.querySelector('.nre-mdz-placeholder')?.textContent).toBe('${x}')
    expect(dom.querySelector('[data-nre-include]')?.getAttribute('data-nre-include')).toBe('a/b.mdz#S')
    expect(dom.querySelector('.nre-mdz-line-heading.nre-mdz-h2')).not.toBeNull()
  })

  it('include click → onLinkClick(target)', () => {
    const onLinkClick = vi.fn()
    const editor = make({ filename: 'a.mdz', text: 'see $[[cards/base.mdz]]', onLinkClick })
    const el = editor.view.contentDOM.querySelector('[data-nre-include]')!
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(onLinkClick).toHaveBeenCalledWith('cards/base.mdz')
  })

  it('folds a block heading to its end', async () => {
    const { foldable } = await import('@codemirror/language')
    const editor = make({ filename: 'a.mdz', text: '## $a\n$k: 1\nbody\n## $b\nx' })
    const { state } = editor.view
    expect(foldable(state, state.doc.line(1).from, state.doc.line(1).to)).toEqual({ from: 5, to: state.doc.line(3).to })
  })
})

describe('keymap', () => {
  it('Mod-s → onSave(text)', () => {
    const onSave = vi.fn()
    const editor = make({ filename: 'a.md', text: 'x', onSave })
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true })
    runScopeHandlers(editor.view, event, 'editor')
    expect(onSave).toHaveBeenCalledWith('x')
  })
})
