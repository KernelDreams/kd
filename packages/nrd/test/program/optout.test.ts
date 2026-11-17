// opt-out `\${` держится сквозь резолв атрибута контекстом (engine-spec §3.1).
// В контексте лежит сырое значение (эскейп жив) — его читает рекурсия; сворачивают
// только выходы: `resolve`/`resolveValue`/`get`, helpers.attr/list. Plain и quoted —
// одна и та же форма.
import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { emptyContext, objectContext, resolve, resolveValue, get, type IContext } from '../../src/core/index.js'
import { programFromText } from '../../src/program/program.js'
import { buildProgramContext } from '../../src/program/context.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'
import { buildHelpers } from '../../src/node/helpers.js'
import { readDecls } from '../../src/program/registry.js'
import { buildContext } from '../../src/context/index.js'

const dir = os.tmpdir()

async function programCtx(...lines: string[]): Promise<IContext> {
  const program = programFromText(lines.join('\n'), 'mdz', path.join(dir, 'optout.mdz'))
  return buildProgramContext({
    program,
    hostCtx: emptyContext,
    caps: nodeProgramCaps(dir),
    withRootAttrs: true,
  })
}

const PLAIN = ['$b: SUBST', '$u: a \\${b} c']
const QUOTED = ['$b: SUBST', '$u: "a \\\\${b} c"']

describe.each([
  ['plain', PLAIN],
  ['quoted', QUOTED],
])('opt-out сквозь атрибут — %s', (_name, doc) => {
  it("resolve('${u}') — литерал, b не подставлен", async () => {
    const ctx = await programCtx(...doc)
    expect(resolve('${u}', ctx)).toBe('a ${b} c')
    expect(resolveValue('${u}', ctx)).toBe('a ${b} c')
    expect(resolve('x ${u} y', ctx)).toBe('x a ${b} c y')
  })

  it('ctx.get — сырой вид (эскейп жив), get() — свёрнутый', async () => {
    const ctx = await programCtx(...doc)
    expect(ctx.get(['u'])).toBe('a \\${b} c')
    expect(get('u', ctx)).toBe('a ${b} c')
  })

  it('держится через второе звено рекурсии ($v: ${u} / x ${u})', async () => {
    const ctx = await programCtx(...doc, '$v: ${u}', '$w: x ${u}')
    expect(resolve('${v}', ctx)).toBe('a ${b} c')
    expect(resolve('${w}', ctx)).toBe('x a ${b} c')
  })

  it('держится через хост-контекст (значение в цепочке, а не в документе)', async () => {
    const host = await programCtx(...doc)
    const program = programFromText('$v: [${u}]', 'mdz', path.join(dir, 'outer.mdz'))
    const ctx = await buildProgramContext({ program, hostCtx: host, caps: nodeProgramCaps(dir), withRootAttrs: true })
    expect(resolve('${v}', ctx)).toBe('[a ${b} c]')
  })

  it('helpers.attr / list — выход: свёрнуто', async () => {
    const program = programFromText([...doc, '$l: $[\\${b}, x]'].join('\n'), 'mdz', path.join(dir, 'h.mdz'))
    const caps = nodeProgramCaps(dir)
    const ctx = await buildProgramContext({ program, hostCtx: emptyContext, caps, withRootAttrs: true })
    const h = buildHelpers({ ctx, decls: readDecls(program.root), env: objectContext({}), caps, program } as never)
    expect(h.attr('u')).toBe('a ${b} c')
    expect(h.list('l')).toEqual(['${b}', 'x'])
  })
})

describe('живой плейсхолдер рядом с opt-out не задет', () => {
  it('a ${b} \\${b} → a SUBST ${b}', async () => {
    const ctx = await programCtx('$b: SUBST', '$u: a ${b} \\${b}')
    expect(resolve('${u}', ctx)).toBe('a SUBST ${b}')
  })

  it('\\\\${b} (эскейп слэша + живой плейсхолдер) — подставляется', async () => {
    const ctx = await programCtx('$b: SUBST', '$u: a \\\\${b}')
    expect(resolve('${u}', ctx)).toBe('a \\\\SUBST')
  })
})

describe('runtime-контекст (buildContext) — та же форма', () => {
  it('inline-источник: plain и quoted одинаковы', async () => {
    for (const tpl of ['a \\${b} c', '"a \\\\${b} c"']) {
      const ctx = await buildContext(['$b: SUBST', '## $source s', '$nr-type: inline', `$tpl: ${tpl}`].join('\n'))
      expect(ctx.get(['s', 'tpl'])).toBe('a \\${b} c')
      expect(resolve('${s.tpl}', ctx)).toBe('a ${b} c')
    }
  })
})
