/**
 * TypeScript language service for the editor, run inside a Web Worker.
 *
 * Self-contained: the TypeScript compiler and the standard lib `.d.ts` files
 * are bundled in, nothing is fetched from a CDN (works offline / in a LAN).
 *
 *   import TsWorker from '@kerneldreams/editor/worker?worker'   // Vite
 *   createEditor({ ..., typescript: { worker: new TsWorker() } })
 */
import * as Comlink from 'comlink'
import ts from 'typescript'
import { createSystem, createVirtualTypeScriptEnvironment } from '@typescript/vfs'
import { createWorker } from '@valtown/codemirror-ts/worker'

const LIBS = import.meta.glob(
  '../node_modules/typescript/lib/lib.{es5,es2015*,es2016*,es2017*,es2018*,es2019*,es2020*,es2021*,es2022*,dom,dom.iterable,dom.asynciterable,decorators,decorators.legacy}.d.ts',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

/** Lets `.tsx` files use JSX without React typings (imports are out of scope). */
const JSX_SHIM = `declare namespace JSX {
  interface Element {}
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicElements { [name: string]: any }
}
`

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
}

export const workerApi = createWorker(() => {
  const fsMap = new Map<string, string>()
  for (const [path, source] of Object.entries(LIBS)) {
    fsMap.set(`/${path.slice(path.lastIndexOf('/') + 1)}`, source)
  }
  fsMap.set('/nre-jsx-shim.d.ts', JSX_SHIM)
  const system = createSystem(fsMap)
  return createVirtualTypeScriptEnvironment(system, ['/nre-jsx-shim.d.ts'], ts, COMPILER_OPTIONS)
})

Comlink.expose(workerApi)
