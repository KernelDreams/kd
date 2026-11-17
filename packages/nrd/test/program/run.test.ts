// Механика программы — перенос rz/test/run.test.ts в части, которая живёт в
// nrd (rz-merge §3.3): загрузка файла, каскад контекста, fn + template.
// Сквозные прогоны документов хостом — в runz/test/documents.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { objectContext, emptyContext, resolve } from '../../src/core/index.js'
import { loadProgram } from '../../src/node/program.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'
import { programFromText } from '../../src/program/program.js'
import { buildProgramContext } from '../../src/program/context.js'
import { readDecls, findDecl, autoSteps } from '../../src/program/registry.js'
import { loadFn } from '../../src/program/fn.js'
import { renderTemplate } from '../../src/program/template.js'

let dir: string
const write = (name: string, ...lines: string[]) => {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n'), 'utf-8')
  return file
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-program-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadProgram — один внутренний вид для трёх форматов', () => {
  it('mdz: блоки документа, сигил $', () => {
    const file = write('a.mdz', '$slug: fight-club', '', '## $fn build', 'код')
    const p = loadProgram(file)
    expect(p.kind).toBe('mdz')
    expect(p.baseDir).toBe(dir)
    expect(p.doc.get(['slug'])).toBe('fight-club')
    expect(p.root.children[0].name).toBe('fn')
  })

  it('mdd: тот же вид, сигил @', () => {
    const file = write('card.mdd', '@slug: tyler', '', '## @char Tyler Durden', 'тело')
    const p = loadProgram(file)
    expect(p.kind).toBe('mdd')
    expect(p.root.children[0].name).toBe('char')
    expect(p.root.children[0].id).toBe('Tyler Durden')
  })

  it('mds: лента через мост, тот же IContext-доступ', () => {
    const file = write(
      'run.mds',
      "%meta {slug: 'fight-club'}",
      '',
      "%fn build {nr: {lang: 'ts'}}",
      'код',
      '',
    )
    const p = loadProgram(file)
    expect(p.kind).toBe('mds')
    expect(p.doc.get(['slug'])).toBe('fight-club')
    expect(p.root.children[0].name).toBe('fn')
  })

  it('--as перебивает расширение', () => {
    const file = write('feed.txt', "%meta {slug: 'x'}", '', '%user', 'привет', '')
    expect(loadProgram(file, 'mds').kind).toBe('mds')
    expect(() => loadProgram(file)).toThrow(/неизвестный тип файла/)
  })

  it('$[[include]] разворачивается при чтении', () => {
    write('parts/head.md', '$model: gpt-4o')
    const file = write('inc.mdz', '$[[parts/head.md]]', '$slug: x')
    expect(loadProgram(file).doc.get(['model'])).toBe('gpt-4o')
  })

  it('programFromText — та же программа без диска', () => {
    const p = programFromText("%meta {slug: 'x'}\n", 'mds', '/virtual/run.mds')
    expect(p.baseDir).toBe('/virtual')
    expect(p.doc.get(['slug'])).toBe('x')
  })
})

describe('buildProgramContext — каскад CLI > документ > конфиг', () => {
  const program = () =>
    programFromText(
      ['$slug: from-doc', '$who: doc', '', '## $source cfg', '$nr-type: inline', '', '$k: v'].join(
        '\n',
      ),
      'mdz',
      path.join(dir, 'cascade.mdz'),
    )

  it('CLI сильнее атрибутов документа', async () => {
    const strong = objectContext({ slug: 'from-cli' })
    const ctx = await buildProgramContext({
      program: program(),
      hostCtx: strong,
      chain: { strong, weak: emptyContext },
      caps: nodeProgramCaps(dir),
      withRootAttrs: true,
    })
    expect(ctx.get(['slug'])).toBe('from-cli')
    expect(ctx.get(['who'])).toBe('doc')
    expect(ctx.get(['k'])).toBe('v')
  })

  it('конфиг/env (слабый слой) НЕ перебивает документ', async () => {
    const weak = objectContext({ slug: 'from-env' })
    const ctx = await buildProgramContext({
      program: program(),
      hostCtx: weak,
      chain: { strong: emptyContext, weak },
      caps: nodeProgramCaps(dir),
      withRootAttrs: true,
    })
    expect(ctx.get(['slug'])).toBe('from-doc')
  })

  it('withRootAttrs: false — атрибуты документа в цепочку не подмешиваются', async () => {
    const ctx = await buildProgramContext({
      program: program(),
      hostCtx: emptyContext,
      caps: nodeProgramCaps(dir),
      withRootAttrs: false,
    })
    expect(ctx.get(['who'])).toBeUndefined()
  })
})

describe('fn + template поверх реестра', () => {
  it('fn исполняется и регистрирует ${name()} через export const fn', async () => {
    const p = programFromText(
      [
        '## $fn build',
        '```ts',
        'export default async (ctx: any) => ({ output: "id=" + ctx.get(["slug"]) })',
        'export const fn = () => "pure"',
        '```',
      ].join('\n'),
      'mdz',
      path.join(dir, 'fn.mdz'),
    )
    const decls = readDecls(p.root, emptyContext)
    const loaded = await loadFn(findDecl(decls, 'fn', 'build')!, nodeProgramCaps(dir))
    const res = (await loaded.run(objectContext({ slug: 'zz' }))) as { output: string }
    expect(res.output).toBe('id=zz')
    expect(loaded.func?.([], emptyContext)).toBe('pure')
  })

  it('template: text и chat дают разные формы результата', () => {
    const p = programFromText(
      [
        '## $tpl plain',
        'привет, << slug >>',
        '',
        '## $prompt talk',
        '````',
        '%system',
        'ты << slug >>',
        '',
        '%user',
        'привет',
        '````',
      ].join('\n'),
      'mdz',
      path.join(dir, 'tpl.mdz'),
    )
    const decls = readDecls(p.root, emptyContext)
    const caps = nodeProgramCaps(dir)
    const env = { render: (t: string, d: unknown) => t.replace('<< slug >>', String((d as Record<string, string>).slug)) }

    expect(renderTemplate(findDecl(decls, 'template', 'plain')!, { slug: 'бот' }, env, caps))
      .toBe('привет, бот')

    const msgs = renderTemplate(findDecl(decls, 'template', 'talk')!, { slug: 'бот' }, env, caps)
    expect(msgs).toEqual([
      { role: 'system', content: 'ты бот' },
      { role: 'user', content: 'привет' },
    ])
  })

  it('фенс из 4+ бэктиков прячет чат-разметку шаблона от сканера ленты', () => {
    const p = programFromText(
      ["%meta {}", '', '%template talk', '````', '%system', 'внутри', '````', ''].join('\n'),
      'mds',
      path.join(dir, 'fence.mds'),
    )
    const decls = readDecls(p.root, emptyContext)
    // одна нода-шаблон, а не три: `%system` внутри фенса не разрезал ленту
    expect(decls.map((d) => d.blockName)).toEqual(['template'])
  })
})

describe('порядок шагов блокнота — порядок документа', () => {
  it('mds: только auto-шаги, в порядке ленты', () => {
    const p = programFromText(
      [
        '%meta {}',
        '',
        '%source cfg {nr: {type: "inline"}}',
        '',
        '%step one',
        'код 1',
        '',
        '%fn helper',
        'код',
        '',
        '%step two',
        'код 2',
        '',
      ].join('\n'),
      'mds',
      path.join(dir, 'nb.mds'),
    )
    const decls = readDecls(p.root, emptyContext)
    expect(autoSteps(decls).map((d) => d.id)).toEqual(['one', 'two'])
  })
})

describe('${} в декларациях резолвится тем же каскадом, что код', () => {
  it('путь источника собирается из CLI-значения', async () => {
    write('mdd/fight-club.md', '@title: Fight Club')
    const strong = objectContext({ slug: 'fight-club' })
    const p = programFromText(
      ["## $source row", "$nr: {type: 'file', parse: 'mdd'}", "$path: ./mdd/${slug}.md"].join('\n'),
      'mdz',
      path.join(dir, 'src.mdz'),
    )
    const ctx = await buildProgramContext({
      program: p,
      hostCtx: strong,
      chain: { strong, weak: emptyContext },
      caps: nodeProgramCaps(dir),
      withRootAttrs: true,
    })
    expect(resolve('${row.title}', ctx)).toBe('Fight Club')
  })
})
