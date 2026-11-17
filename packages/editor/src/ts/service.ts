import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { autocompletion } from '@codemirror/autocomplete'
import * as Comlink from 'comlink'
import { tsAutocompleteWorker, tsFacetWorker, tsHoverWorker, tsLinterWorker, tsSyncWorker } from '@valtown/codemirror-ts'
import type { WorkerShape } from '@valtown/codemirror-ts/worker'
import type { Mode } from '../modes'

/** One `initialize()` per Worker: editors may share a worker. */
const ready = new WeakMap<Worker, Promise<WorkerShape>>()

function connect(worker: Worker): Promise<WorkerShape> {
  let shape = ready.get(worker)
  if (!shape) {
    const remote = Comlink.wrap<WorkerShape>(worker) as unknown as WorkerShape
    shape = remote.initialize().then(() => remote)
    ready.set(worker, shape)
  }
  return shape
}

let ownWorker: Worker | null = null

/** The bundled worker, shared by all editors that pass `typescript: true`. */
function defaultWorker(): Worker {
  ownWorker ??= new Worker(new URL('../worker.ts', import.meta.url), { type: 'module', name: 'nr-editor-ts' })
  return ownWorker
}

let fileCounter = 0

/**
 * TS language service extensions for one editor: diagnostics, completion,
 * hover. One virtual file per editor; `.js` files get completion and hover
 * only (checkJs is off).
 */
export async function typescriptService(mode: Mode, worker: Worker | undefined): Promise<Extension> {
  const remote = await connect(worker ?? defaultWorker())
  const path = `/nre-${++fileCounter}.${mode}`
  return [
    tsFacetWorker.of({ worker: remote, path }),
    tsSyncWorker(),
    tsLinterWorker(),
    autocompletion({ override: [tsAutocompleteWorker()] }),
    tsHoverWorker(),
    EditorView.contentAttributes.of({ 'data-nre-ts': 'on' }),
  ]
}
