// helpers.attr / helpers.list — форма значения из цепочки.
// attr отдаёт только скаляр: не-скаляр — громкая ошибка с ключом и подсказкой,
// а не молчаливый undefined. list — `$[…]` и одиночный скаляр → string[].
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { emptyContext, objectContext, type IContext } from '../../src/core/index.js'
import { buildHelpers } from '../../src/node/helpers.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'
import { programFromText } from '../../src/program/program.js'
import { buildProgramContext } from '../../src/program/context.js'
import { readDecls } from '../../src/program/registry.js'

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-helpers-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function helpersFor(...lines: string[]) {
  return helpersWith(emptyContext, ...lines)
}

async function helpersWith(hostCtx: IContext, ...lines: string[]) {
  const program = programFromText(lines.join('\n'), 'mdz', path.join(dir, 'probe.mdz'))
  const caps = nodeProgramCaps(dir)
  const ctx: IContext = await buildProgramContext({
    program,
    hostCtx,
    chain: { strong: hostCtx, weak: emptyContext },
    caps,
    withRootAttrs: true,
  })
  return buildHelpers({
    ctx,
    meta: {} as never,
    decls: readDecls(program.root, emptyContext),
    caps,
    provider: {} as never,
    env: { render: (t) => t },
    runFn: async () => ({}) as never,
  })
}

const DOC = ['$list: $[a, b]', '$one: x', '$n: 3', '$empty: $[]', '$obj: {a: 1}']

describe('helpers.attr', () => {
  it('скаляр — строка', async () => {
    const h = await helpersFor(...DOC)
    expect(h.attr('one')).toBe('x')
    expect(h.attr('n')).toBe('3')
  })

  it('flow-список — ошибка с ключом, формой и подсказкой', async () => {
    const h = await helpersFor(...DOC)
    expect(() => h.attr('list')).toThrow(
      `ключ "list" — список из 2 элементов, не скаляр: helpers.list('list')`,
    )
  })

  it('$[] — тоже не скаляр', async () => {
    const h = await helpersFor(...DOC)
    expect(() => h.attr('empty')).toThrow(/ключ "empty" — список из 0 элементов/)
  })

  it('объект — ошибка, подсказка ctx.get', async () => {
    const h = await helpersFor(...DOC)
    expect(() => h.attr('obj')).toThrow(/ключ "obj" — объект \(IContext\), не скаляр: ctx\.get/)
  })

  it('отсутствующий ключ — undefined, не ошибка', async () => {
    const h = await helpersFor(...DOC)
    expect(h.attr('none')).toBeUndefined()
  })
})

describe('helpers.list', () => {
  it('flow-список — два элемента', async () => {
    const h = await helpersFor(...DOC)
    expect(h.list('list')).toEqual(['a', 'b'])
  })

  it('скаляр — один элемент', async () => {
    const h = await helpersFor(...DOC)
    expect(h.list('one')).toEqual(['x'])
    expect(h.list('n')).toEqual(['3'])
  })

  it('$[] — пустой список', async () => {
    const h = await helpersFor(...DOC)
    expect(h.list('empty')).toEqual([])
  })

  it('отсутствующий ключ — undefined, не ошибка', async () => {
    const h = await helpersFor(...DOC)
    expect(h.list('none')).toBeUndefined()
  })

  it('вложенный список — ошибка с индексом элемента', async () => {
    // Формат mdz вложенных `$[…]` не пишет — вложенность приходит из хоста.
    const h = await helpersWith(objectContext({ nested: ['x', ['y']] }), ...DOC)
    expect(() => h.list('nested')).toThrow(/ключ "nested", элемент \[1\] — массив из 1 элемента/)
  })

  it('объект — не список', async () => {
    const h = await helpersFor(...DOC)
    expect(() => h.list('obj')).toThrow(/ключ "obj" — объект \(IContext\), не список/)
  })
})

describe('соседи не коэрсят IArray молча', () => {
  it('read(IArray) — ошибка вместо undefined', async () => {
    const h = await helpersFor(...DOC)
    const raw = await listValue()
    expect(() => h.read(raw as never)).toThrow(/helpers\.read — filePath должен быть строкой, получен список из 2 элементов/)
    expect(() => h.readTbl(raw as never)).toThrow(/helpers\.readTbl/)
    expect(() => h.exists(raw as never)).toThrow(/helpers\.exists/)
    expect(() => h.listDir(raw as never)).toThrow(/helpers\.listDir/)
    expect(() => h.write('out.txt', raw as never)).toThrow(/helpers\.write — content/)
  })

  it('render: IArray в data — ошибка с подсказкой helpers.list', async () => {
    const h = await helpersFor(...DOC, '', '## $template t', '%user', 'hi')
    const items = await listValue()
    expect(() => h.render('t', { items })).toThrow(
      /data\.items — список из 2 элементов \(IArray\): передай helpers\.list/,
    )
    expect(h.render('t', { items: ['a', 'b'] })).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('render: IArray в глубине data — ошибка с путём (ABC-162)', async () => {
    const h = await helpersFor(...DOC, '', '## $template t', '%user', 'hi')
    const items = await listValue()
    expect(() => h.render('t', { a: { b: items } })).toThrow(
      /data\.a\.b — список из 2 элементов \(IArray\): передай helpers\.list/,
    )
    expect(() => h.render('t', { xs: [{ c: 1 }, { c: items }] })).toThrow(/data\.xs\[1\]\.c — список/)
    const cyc: Record<string, unknown> = { ok: ['a'] }
    cyc.self = cyc
    expect(h.render('t', { a: { b: ['a', 'b'] }, cyc })).toEqual([{ role: 'user', content: 'hi' }])
  })
})

async function listValue() {
  const program = programFromText('$list: $[a, b]', 'mdz', path.join(dir, 'v.mdz'))
  const ctx = await buildProgramContext({
    program,
    hostCtx: emptyContext,
    caps: nodeProgramCaps(dir),
    withRootAttrs: true,
  })
  return ctx.get(['list'])
}
