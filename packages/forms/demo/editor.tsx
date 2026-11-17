/**
 * Тестовая страница <ObjectEditor> (spec §11, шаги 1–6): фикстуры пакета, без бэкенда.
 *   ?def=fate|ccv3|broken   описание (fate — эталон пробы, объект «Ярослава»; ccv3 — персона)
 *   ?view=sheet|inspector|both
 *   ?sheet=parchment        скин листа (пространство --nr-sheet-*)
 *   ?frame=1                физический трек — виджетом-артефактом `fate.stress-track-alt` (iframe)
 *   ?theme=dark, ?lang=en
 * `window.__doc` — документ (e2e читает объект и историю).
 */

import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { baseWidgets, ccv3Widgets, check, createCatalog, createDocument, fateWidgets, parseEditor, type EditorDef, type FieldNode, type ObjectDocument } from '../src/editor/index.js'
import { EDITOR_LABELS_RU, ObjectEditor, useDocument } from '../src/react.js'
import ccv3Mdz from '../tests/fixtures/editor/ccv3.editor.mdz?raw'
import brokenMdz from '../tests/fixtures/editor/broken.editor.mdz?raw'
import fateMdz from '../tests/fixtures/editor/fate.editor.mdz?raw'
import persona from '../tests/fixtures/editor/persona.json'
import yaroslava from '../tests/fixtures/editor/yaroslava.json'
import './editor.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.skin = 'shell'
document.documentElement.dataset.mode = params.get('theme') === 'dark' ? 'dark' : 'light'
if (params.get('sheet')) document.documentElement.dataset.sheet = params.get('sheet')!

/** Виджет-артефакт: ряд ячеек в iframe, говорит мостом v2 (`__host.widget`). */
const STRESS_ALT = `<!doctype html><html><head><style>
body{margin:0;font:13px system-ui;background:transparent}
.r{display:flex;gap:6px;padding:4px}
b{width:26px;height:26px;border-radius:50%;border:2px solid var(--a,#985518);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--a,#985518)}
b.on{background:var(--a,#985518);color:#fff}
</style></head><body><div class="r" id="r"></div><script>
var cur=[],n=0;
function draw(){var r=document.getElementById('r');r.innerHTML='';for(var i=0;i<n;i++){var b=document.createElement('b');b.textContent=i+1;b.dataset.i=i;if(cur[i])b.className='on';b.onclick=function(e){var k=+e.target.dataset.i;var next=[];for(var j=0;j<n;j++)next.push(j===k?!cur[j]:!!cur[j]);__host.widget.change(next)};r.appendChild(b)}}
__host.widget.onInit(function(p){cur=p.value||[];n=+p.props.boxes||0;if(p.theme&&p.theme.vars['--nr-accent'])document.body.style.setProperty('--a',p.theme.vars['--nr-accent']);draw()});
</script></body></html>`

const catalog = createCatalog([...baseWidgets, ...fateWidgets, ...ccv3Widgets])
catalog.register({
  id: 'fate.stress-track-alt',
  types: ['boolean[]'],
  props: { type: 'object', properties: { boxes: { type: ['integer', 'number'] } }, required: ['boxes'] },
  description: 'ряд ячеек стресса кружками (виджет-артефакт)',
  frame: { srcdoc: STRESS_ALT },
})

function load(): { def: EditorDef; object: unknown; text: string } {
  const which = params.get('def') ?? 'fate'
  const text = which === 'ccv3' ? ccv3Mdz : which === 'broken' ? brokenMdz : fateMdz
  const parsed = parseEditor(text)
  const def = parsed.def
  if (params.get('frame')) {
    const walk = (ns: EditorDef['nodes']): void =>
      ns.forEach((n) => {
        if (n.kind === 'field' && (n as FieldNode).path === 'stress.physical') (n as FieldNode).widget = 'fate.stress-track-alt'
        walk((n as { children?: EditorDef['nodes'] }).children ?? [])
      })
    walk(def.nodes)
  }
  return { def, text, object: structuredClone(which === 'ccv3' ? persona : yaroslava) }
}

const { def, object, text } = load()
const doc = createDocument(object, def, { catalog })
const issues = [...parseEditor(text).issues.filter((i) => i.code.startsWith('E_')), ...check(def, catalog).errors]
;(window as unknown as { __doc: ObjectDocument }).__doc = doc

function Toolbar(): React.ReactNode {
  useDocument(doc)
  const [text, setText] = useState(false)
  const btn = 'rounded-nr border border-nr-line px-nr-2 py-nr-1 text-nr-sm text-nr-fg disabled:opacity-40'
  return (
    <div className="flex flex-col gap-nr-2">
      <div className="flex items-center gap-nr-2">
        <button type="button" data-testid="demo-undo" className={btn} disabled={!doc.canUndo} onClick={() => doc.undo()}>
          ↶
        </button>
        <button type="button" data-testid="demo-redo" className={btn} disabled={!doc.canRedo} onClick={() => doc.redo()}>
          ↷
        </button>
        <span data-testid="demo-history" className="text-nr-xs text-nr-muted">
          {doc.history.length}
        </span>
        {doc.dirty ? (
          <span data-testid="demo-dirty" className="text-nr-xs text-nr-accent">
            ●
          </span>
        ) : null}
        <button type="button" data-testid="demo-as-text" className={`${btn} ml-auto`} onClick={() => setText(!text)}>
          {text ? 'Редактор' : 'Как текст'}
        </button>
      </div>
      {text ? (
        <pre data-testid="demo-text" className="nr-mono max-h-96 overflow-auto rounded-nr border border-nr-line bg-nr-surface p-nr-3 text-nr-xs">
          {JSON.stringify(doc.object, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function Page(): React.ReactNode {
  const view = params.get('view') ?? 'sheet'
  const labels = useMemo(() => (params.get('lang') === 'en' ? {} : EDITOR_LABELS_RU), [])
  const sheet = <ObjectEditor doc={doc} view="sheet" labels={labels} issues={issues} />
  const inspector = <ObjectEditor doc={doc} view="inspector" labels={labels} issues={view === 'both' ? [] : issues} />
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-nr-4 p-nr-4">
      <Toolbar />
      {view === 'both' ? (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start gap-nr-4">
          {sheet}
          <aside className="rounded-nr border border-nr-line">{inspector}</aside>
        </div>
      ) : view === 'inspector' ? (
        <aside className="mx-auto w-full max-w-md rounded-nr border border-nr-line">{inspector}</aside>
      ) : (
        sheet
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
