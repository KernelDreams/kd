/**
 * `installNoEvalNunjucks` — подмена на весь экземпляр nunjucks (Worker): отдельный файл,
 * чтобы прототип не подменился под остальными тестами.
 */

import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { installNoEvalNunjucks } from '../../src/template/index.js'

const nj = createRequire(import.meta.url)('nunjucks')

const CORPUS: Array<[string, Record<string, unknown>]> = [
  ['{% for x in xs %}{{ loop.index }}:{{ x | upper }}{% endfor %} {{ "да" if ok else "нет" }}', { xs: ['a', 'b'], ok: false }],
  ['{% set y = x * 2 %}{{ y }} {{ o.k | default("—") }}', { x: 4, o: {} }],
]

it('installNoEvalNunjucks: весь экземпляр, идемпотентно, без new Function', () => {
  const render = () => CORPUS.map(([src, ctx]) => new nj.Environment(null, { autoescape: true }).renderString(src, ctx))
  const native = render()
  installNoEvalNunjucks(nj)
  installNoEvalNunjucks(nj)
  const real = globalThis.Function
  globalThis.Function = new Proxy(real, { construct: () => { throw new EvalError('Code generation from strings disallowed') } }) as FunctionConstructor
  try {
    expect(render()).toEqual(native)
  } finally {
    globalThis.Function = real
  }
})
