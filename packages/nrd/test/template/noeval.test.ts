/**
 * nunjucks без кодогенерации ( → nrd в): рендер обходом AST даёт тот же
 * вывод, что родной компилятор. `noEvalTemplate` — один шаблон, экземпляр не трогается;
 * `installNoEvalNunjucks` — весь экземпляр (Worker), поэтому — на отдельной копии модуля.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createEnvWith, noEvalTemplate, type Nunjucks } from '../../src/template/index.js'

const require = createRequire(import.meta.url)
const nj = require('nunjucks') as Nunjucks & { Environment: new (l: unknown, o?: object) => { renderString(s: string, c: object): string } }

const CORPUS: Array<[string, Record<string, unknown>]> = [
  ['plain text, без тегов', {}],
  ['{{ a }} и {{ b.c }} и {{ arr[1] }} и {{ missing }}', { a: 'A', b: { c: 'C' }, arr: [1, 2] }],
  ['{{ a | upper }} {{ list | join(", ") }} {{ x | default("нет") }} {{ s | replace("a", "b") | trim }}', { a: 'abc', list: ['x', 'y'], s: ' banana ' }],
  ['{% if n > 2 and not off %}много{% elif n == 2 %}два{% else %}мало{% endif %}', { n: 3, off: false }],
  ['{% if n > 2 and not off %}много{% elif n == 2 %}два{% else %}мало{% endif %}', { n: 2 }],
  ['{% for x in xs %}{{ loop.index }}:{{ x }}{% if not loop.last %},{% endif %}{% else %}пусто{% endfor %}', { xs: ['a', 'b', 'c'] }],
  ['{% for x in xs %}{{ x }}{% else %}пусто{% endfor %}', { xs: [] }],
  ['{% for k, v in o %}{{ k }}={{ v }};{% endfor %}', { o: { a: 1, b: 2 } }],
  ['{% for a, b in pairs %}{{ a }}{{ b }} {% endfor %}', { pairs: [[1, 2], [3, 4]] }],
  ['{% set y = x * 2 + 1 %}{{ y }} {{ "s" ~ y }} {{ 7 // 2 }} {{ 7 % 3 }} {{ 2 ** 3 }} {{ -x }}', { x: 5 }],
  ['{{ "да" if ok else "нет" }} {{ "в" if "a" in s }} {{ x is defined }} {{ n is odd }}', { ok: true, s: 'cat', n: 3 }],
  ['{{ f(1, 2) }} {{ o.m("z") }} {{ {a: 1, "b": 2}.b }} {{ [1, 2, 3] | length }}', { f: (a: number, b: number) => a + b, o: { m: (z: string) => z + z } }],
  ['{%- if a -%}  тримы  {%- endif -%} | {{- " x " -}} |', { a: true }],
  ['{% set block %}внутри {{ a }}{% endset %}[{{ block }}]', { a: 1 }],
  ['{{ html }} {{ html | safe }}', { html: '<b>&</b>' }],
  ['{{ xs | selectattr("found") | length }} {{ xs | sum(attribute="n") }} {{ 2.567 | round(1) }} {{ "7" | int + 1 }}', { xs: [{ found: true, n: 2 }, { found: false, n: 3 }] }],
]

/** Кодогенерации нет: `new Function` — ошибка, как в Workers и под CSP. */
function withoutEval<T>(fn: () => T): T {
  const real = globalThis.Function
  globalThis.Function = new Proxy(real, { construct: () => { throw new EvalError('Code generation from strings disallowed') } }) as FunctionConstructor
  try {
    return fn()
  } finally {
    globalThis.Function = real
  }
}

describe('ntpl без кодогенерации', () => {
  it('noEvalTemplate: вывод как у родного компилятора, экземпляр не тронут', () => {
    const env = () => new nj.Environment(null, { autoescape: true })
    const native = CORPUS.map(([src, ctx]) => env().renderString(src, ctx))
    const e = env()
    const mine = withoutEval(() => CORPUS.map(([src, ctx]) => noEvalTemplate(nj, e, src).render(ctx)))
    expect(mine).toEqual(native)
    expect((nj.Template.prototype as { __nrNoEval?: boolean }).__nrNoEval).toBeUndefined()
  })

  it('ntpl-среда синхронно: делимитеры, фильтры nrd (pluck, flatten)', () => {
    const env = createEnvWith(nj as never)
    const src = '<< sessions | pluck("clues") | flatten | selectattr("found") | length >><{ if x }>+<{ endif }>'
    const ctx = { x: true, sessions: [{ clues: [{ found: true }, { found: false }] }, { clues: [{ found: true }] }] }
    expect(withoutEval(() => noEvalTemplate(nj, env, src).render(ctx))).toBe('2+')
  })

  it('неподдержанное — ошибкой с именем узла', () => {
    const env = new nj.Environment(null)
    expect(() => noEvalTemplate(nj, env, '{% macro m() %}x{% endmacro %}{{ m() }}').render({})).toThrow(/без кодогенерации: узел Macro не поддержан/)
  })
})
