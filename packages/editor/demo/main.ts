import { createEditor, modeFromFilename, type EditorHandle, type Theme } from '../src/index.js'
import './style.css'

const samples = import.meta.glob('./samples/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const files = Object.keys(samples)
  .map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), text: samples[path]! }))
  .sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))

function order(name: string): number {
  const ext = name.slice(name.lastIndexOf('.') + 1)
  return ['md', 'mdz', 'mds', 'mdd'].includes(ext) ? 0 : 1
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const editorHost = $<HTMLDivElement>('editor')
const filesNav = $<HTMLElement>('files')
const themeSelect = $<HTMLSelectElement>('theme')
const tsToggle = $<HTMLInputElement>('ts')
const roToggle = $<HTMLInputElement>('ro')
const status = $<HTMLSpanElement>('status')
const dumpPanel = $<HTMLElement>('dump-panel')
const dumpResult = $<HTMLSpanElement>('dump-result')
const dumpText = $<HTMLPreElement>('dump-text')

const params = new URLSearchParams(location.search)
let current = files.find((f) => f.name === params.get('file')) ?? files[0]!
let theme = (params.get('theme') as Theme | null) ?? 'auto'
let editor: EditorHandle | null = null

themeSelect.value = theme
tsToggle.checked = params.get('ts') === '1'
document.documentElement.dataset.theme = theme

function say(text: string) {
  status.textContent = text
}

function mount() {
  editor?.destroy()
  editor = createEditor({
    parent: editorHost,
    text: current.text,
    filename: current.name,
    theme,
    readOnly: roToggle.checked,
    typescript: tsToggle.checked,
    onChange: () => {
      if (!dumpPanel.hidden) dump()
    },
    onSave: (text) => say(`onSave: ${current.name}, ${text.length} chars`),
    onLinkClick: (target) => say(`onLinkClick → ${target}`),
  })
  for (const button of filesNav.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.name === current.name))
  }
  say(`${current.name} · mode ${modeFromFilename(current.name)}${tsToggle.checked ? ' · TS service on' : ''}`)
  if (!dumpPanel.hidden) dump()
}

function dump() {
  if (!editor) return
  const text = editor.getText()
  const identical = text === current.text
  dumpResult.innerHTML = `getText() — ${text.length} chars · <span class="${identical ? 'ok' : 'bad'}">identical: ${identical}</span>`
  dumpText.textContent = text
  dumpPanel.hidden = false
}

for (const file of files) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.name = file.name
  button.innerHTML = `${file.name}<span class="mode">${modeFromFilename(file.name)}</span>`
  button.addEventListener('click', () => {
    current = file
    mount()
  })
  filesNav.appendChild(button)
}

themeSelect.addEventListener('change', () => {
  theme = themeSelect.value as Theme
  document.documentElement.dataset.theme = theme
  editor?.setTheme(theme)
})
tsToggle.addEventListener('change', mount)
roToggle.addEventListener('change', () => editor?.setReadOnly(roToggle.checked))
$('dump').addEventListener('click', dump)
$('dump-close').addEventListener('click', () => {
  dumpPanel.hidden = true
})

mount()
// For scripted screenshots.
Object.assign(window, { nre: () => editor })
