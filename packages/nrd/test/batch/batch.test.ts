// nrd/batch (batch-spec §1–§3): списки, таблицы, достижимость, $order, CLI, группы.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { objectContext, parseDocument, resolve, chainContext } from '../../src/index.js'
import type { IContext } from '../../src/index.js'
import { BatchError, parseAxisBody, parseList, planBatches, referencedNames } from '../../src/batch/index.js'
import type { BatchOptions } from '../../src/batch/index.js'
import { readTextWithIncludes } from '../../src/node/index.js'

/** Параметры как у comfy: точечные атрибуты — поля нод. */
const dotted: BatchOptions['params'] = (layer) =>
  new Map([...layer.texts].filter(([k]) => k.includes('.')))

function plan(text: string, opts: BatchOptions = {}) {
  return planBatches(parseDocument(text), { params: dotted, ...opts })
}

/** Значение `${}` на комбинации: точка поверх переменных группы. */
function value(text: string, combo: { ctx: IContext }, attrs: IContext, strong?: IContext): string {
  const chain = strong ? chainContext(combo.ctx, strong, attrs) : chainContext(combo.ctx, attrs)
  return resolve(text, chain)
}

describe('списки', () => {
  it('метки, комментарии, диапазоны', () => {
    expect(parseList('a // A\n// x\n# h\n* s\n`c`\n---\n$// off\nb\n1..3/1 // n\n0.5..1/0.25')).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b' },
      { value: '1', label: 'n' },
      { value: '2', label: 'n' },
      { value: '3', label: 'n' },
      { value: '0.50' },
      { value: '0.75' },
      { value: '1.00' },
    ])
  })

  it('фенс — одно значение, не ось', () => {
    const [g] = plan('$n.text: ${p}\n\n## $p\n```\nline one\nline two\n```\n')
    expect(g.axes).toEqual([])
    expect(g.combos).toHaveLength(1)
    expect(value('${p}', g.combos[0], g.attrs)).toBe('line one\nline two')
  })

  it('метка — в labels, без метки — значение; points хранят только явную', () => {
    const [g] = plan('$n.seed: ${seed}\n$n.text: ${p}\n\n## $seed\n1001 // s1\n1002\n\n## $p\ncat\n')
    expect(g.combos.map((c) => c.labels)).toEqual([
      { seed: 's1', p: 'cat' },
      { seed: '1002', p: 'cat' },
    ])
    expect(g.combos[1].points.seed).toEqual({ value: '1002' })
    expect(value('${seed}', g.combos[0], g.attrs)).toBe('1001')
  })

  it('одноимённые блоки — последний выигрывает', () => {
    const [g] = plan('$n.text: ${p}\n\n## $p\na\nb\n\n## $p\nc\n')
    expect(g.combos.map((c) => c.labels.p)).toEqual(['c'])
  })
})

describe('достижимость', () => {
  it('недостижимый список — не ось', () => {
    const [g] = plan('$n.text: ${p}\n\n## $p\na\nb\n\n## $q\nx\ny\n')
    expect(g.axes).toEqual(['p'])
  })

  it('транзитивно через атрибуты и тела блоков', () => {
    const [g] = plan('$n.text: ${full}\n$full: ${p}, ${style}\n\n## $p\nfox ${actor}\n\n## $actor\na\nb\n\n## $style\nink\noil\n')
    expect(g.axes.sort()).toEqual(['actor', 'p', 'style'])
    expect(g.combos).toHaveLength(4)
  })

  it('лексер ${}: путь a.b, вызов функции, вложенный плейсхолдер', () => {
    expect(referencedNames('${a.b} ${f(c, "lit")} ${x.${y}} ${g().z}')).toEqual(['a', 'c', 'x', 'y'])
    // битое выражение не роняет разбор: головы берутся как есть
    expect(referencedNames('${a b} ${c}')).toEqual(['a', 'c'])
    const [g] = plan('$n.text: ${escape(p)}\n\n## $p\na\nb\n')
    expect(g.axes).toEqual(['p'])
  })

  it('без params — все списки оси (imagen)', () => {
    const [g] = planBatches(parseDocument('## $p\na\nb\n\n## $q\nx\n'))
    expect(g.axes).toEqual(['p', 'q'])
    expect(g.combos).toHaveLength(2)
  })

  it('params-функция вернула undefined для группы — у неё все списки оси, у прочих — по корням', () => {
    const text = '## $p\na\nb\n\n## $batch api\n### $q\nx\ny\n\n## $batch wf\n$n.text: ${q}\n### $q\nx\ny\n### $r\n1\n2\n'
    const groups = planBatches(parseDocument(text), {
      params: (layer) => (layer.id === 'wf' ? new Map([...layer.texts].filter(([k]) => k.includes('.'))) : undefined),
    })
    expect(groups.map((g) => [g.id, g.axes])).toEqual([['api', ['p', 'q']], ['wf', ['q']]])
  })
})

describe('ось-таблица', () => {
  const doc = [
    '$enc.prompt: ${prompt}, ${style}',
    '$ref1.image: ${ref1}',
    '$ref2.image: ${ref2}',
    '',
    '## $shot',
    'prompt | ref1 | ref2 | label',
    'fox in snow | refs/fox.png | | fox',
    'wolf and fox | refs/wolf.png | refs/fox.png | pair',
    '',
    '## $style',
    'watercolor',
    'ink sketch // ink',
    '',
  ].join('\n')

  it('строка = точка со всеми колонками; с другими осями перемножается', () => {
    const [g] = plan(doc)
    expect(g.axes).toEqual(['shot', 'style'])
    expect(g.combos).toHaveLength(4)
    expect(g.combos.map((c) => c.labels)).toEqual([
      { shot: 'fox', style: 'watercolor' },
      { shot: 'fox', style: 'ink' },
      { shot: 'pair', style: 'watercolor' },
      { shot: 'pair', style: 'ink' },
    ])
    const c = g.combos[3]
    expect(value('${prompt}, ${style}', c, g.attrs)).toBe('wolf and fox, ink sketch')
    expect(value('${ref2}', c, g.attrs)).toBe('refs/fox.png')
    expect(value('[${ref2}]', g.combos[0], g.attrs)).toBe('[]') // пустая ячейка — пустая строка
  })

  it('нет колонки label — метка из первой колонки', () => {
    const [g] = plan('$n.text: ${prompt}\n\n## $shot\nprompt | ref1\ncat | a.png\ndog | b.png\n')
    expect(g.combos.map((c) => c.labels.shot)).toEqual(['cat', 'dog'])
    expect(g.combos[0].points.shot.label).toBe('cat')
  })

  it('типы колонок: число, список склеивается через ", "', () => {
    const [g] = plan('$n.text: ${p} ${n} ${tags}\n\n## $t\np | n:number | tags:list(;)\ncat | 2 | a;b\n')
    expect(value('${p} ${n} ${tags}', g.combos[0], g.attrs)).toBe('cat 2 a, b')
    expect(g.combos[0].points.t.vars?.n).toBe(2)
  })

  it('число ячеек не совпало — список и предупреждение', () => {
    const warns: string[] = []
    const [g] = plan('$n.text: ${p}\n\n## $p\na | b\nc\n', { warn: (m) => warns.push(m) })
    expect(g.combos.map((c) => c.labels.p)).toEqual(['a | b', 'c'])
    expect(warns[0]).toMatch(/ось p.*список/)
  })

  it('одна строка с | — значение списка, не таблица', () => {
    expect(parseAxisBody('a | b')).toEqual({ kind: 'list', points: [{ value: 'a | b' }] })
  })

  it('достаточно одной достижимой колонки; недостижимая — предупреждение', () => {
    const warns: string[] = []
    const [g] = plan('$n.text: ${prompt}\n\n## $shot\nprompt | reff\ncat | a.png\n', { warn: (m) => warns.push(m) })
    expect(g.axes).toEqual(['shot'])
    expect(warns).toEqual(['колонка reff оси shot ни на что не влияет'])
  })

  it('колонка с именем другой оси — ошибка', () => {
    expect(() => plan('$n.text: ${style}\n\n## $shot\nprompt | style\na | b\n\n## $style\nx\n')).toThrow(BatchError)
  })
})

describe('$order и CLI', () => {
  const doc = '$n.a: ${a}\n$n.b: ${b}\n\n## $a\n1\n2\n\n## $b\nx // X\ny // Y\n'

  it('$order: первая — самая медленная', () => {
    const [g] = plan('$order: b, a\n' + doc)
    expect(g.combos.map((c) => `${c.labels.a}${c.labels.b}`)).toEqual(['1X', '2X', '1Y', '2Y'])
    const [h] = plan(doc, { strong: objectContext({ order: 'b' }) })
    expect(h.combos.map((c) => `${c.labels.a}${c.labels.b}`)).toEqual(['1X', '2X', '1Y', '2Y'])
  })

  it('CLI по значению и по метке схлопывает ось в точку', () => {
    const [g] = plan(doc, { strong: objectContext({ b: 'Y' }) })
    expect(g.combos.map((c) => c.labels)).toEqual([{ a: '1', b: 'Y' }, { a: '2', b: 'Y' }])
    expect(value('${b}', g.combos[0], g.attrs)).toBe('y')
    const [h] = plan(doc, { strong: objectContext({ a: '2' }) })
    expect(h.combos.map((c) => c.labels.a)).toEqual(['2', '2'])
  })

  it('CLI без совпадения: список уходит (значение из сильного слоя), таблица — ошибка', () => {
    const strong = objectContext({ a: '7' })
    const [g] = plan(doc, { strong })
    expect(g.axes).toEqual(['b'])
    expect(value('${a}', g.combos[0], g.attrs, strong)).toBe('7')
    const t = '$n.text: ${prompt}\n\n## $shot\nprompt | label\ncat | c\ndog | d\n'
    expect(plan(t, { strong: objectContext({ shot: 'd' }) })[0].combos.map((c) => c.labels.shot)).toEqual(['d'])
    expect(() => plan(t, { strong: objectContext({ shot: 'zzz' }) })).toThrow(/нет точки «zzz»; есть: c, d/)
  })

  it('колонка, заданная в CLI, — сильный слой выигрывает', () => {
    const strong = objectContext({ prompt: 'owl' })
    const [g] = plan('$n.text: ${prompt}\n\n## $shot\nprompt | label\ncat | c\n', { strong })
    expect(value('${prompt}', g.combos[0], g.attrs, strong)).toBe('owl')
  })
})

describe('группы', () => {
  const doc = [
    '$output: out',
    '$steps: 20',
    '$n.steps: ${steps}',
    '$n.text: ${positive}, ${style}',
    '',
    '## $style',
    'watercolor',
    'ink sketch // ink',
    '',
    '## $batch cats',
    '$steps: 30',
    '$n.text: ${prompt}, ${style}',
    '### $shot',
    'prompt | label',
    'cat | c',
    'kitten | k',
    '',
    '## $batch backs',
    '### $positive',
    'room',
    'attic',
    '### $style',
    'pencil',
    '',
  ].join('\n')

  it('группы по порядку; корневая ось общая; ось группы перекрывает корневую', () => {
    const gs = plan(doc)
    expect(gs.map((g) => g.id)).toEqual(['cats', 'backs'])
    expect(gs[0].axes).toEqual(['style', 'shot'])
    expect(gs[0].combos).toHaveLength(4)
    expect(gs[1].combos.map((c) => c.labels)).toEqual([
      { positive: 'room', style: 'pencil' },
      { positive: 'attic', style: 'pencil' },
    ])
  })

  it('атрибуты группы — слой поверх корня', () => {
    const [cats, backs] = plan(doc)
    expect(cats.texts.get('steps')).toBe('30')
    expect(cats.texts.get('n.text')).toBe('${prompt}, ${style}')
    expect(cats.attrs.get(['steps'])).toBe('30')
    expect(backs.attrs.get(['steps'])).toBe('20')
    expect(backs.attrs.get(['output'])).toBe('out')
    expect(cats.values.get(['steps'])).toBe(30)
    expect(value('${prompt}, ${style}', cats.combos[2], cats.attrs)).toBe('cat, ink sketch')
  })

  it('--batch выбирает группы; неизвестное имя — ошибка со списком', () => {
    expect(plan(doc, { batches: ['backs'] }).map((g) => g.id)).toEqual(['backs'])
    expect(() => plan(doc, { batches: ['dogs'] })).toThrow(/нет групп: dogs; есть: cats, backs/)
  })

  it('values: атрибут-список остаётся списком', () => {
    const [g] = plan('$refs: $[a.png, b.png]\n$n.text: x\n')
    const refs = g.values.get(['refs']) as { length(): number }
    expect(refs.length()).toBe(2)
    expect(g.texts.get('refs')).toBe('')
  })

  it('документ без групп — одна безымянная', () => {
    const gs = plan('$n.text: ${p}\n\n## $p\na\n')
    expect(gs).toHaveLength(1)
    expect(gs[0].id).toBeUndefined()
  })

  it('инклюд профиля внутри группы даёт атрибуты группы (last-wins)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-batch-'))
    try {
      fs.mkdirSync(path.join(dir, 'workflows'))
      fs.writeFileSync(path.join(dir, 'workflows', 'prof.md'), '$sampler.steps: ${steps}\n$steps: 8\n$enc.prompt: ${prompt}\n')
      fs.writeFileSync(
        path.join(dir, 'doc.md'),
        '$output: o\n\n## $batch a\n$[[prof.md]]\n$steps: 12\n### $prompt\ncat\ndog\n\n## $batch b\n$[[prof.md]]\n### $prompt\nowl\n',
      )
      const text = readTextWithIncludes(path.join(dir, 'doc.md'), undefined, '[t]', {
        fallbackDirs: [path.join(dir, 'workflows')],
      })
      const [a, b] = plan(text)
      expect(a.texts.get('sampler.steps')).toBe('${steps}')
      expect(a.attrs.get(['steps'])).toBe('12')
      expect(b.attrs.get(['steps'])).toBe('8')
      expect(a.combos.map((c) => c.labels.prompt)).toEqual(['cat', 'dog'])
      expect(b.combos.map((c) => c.labels.prompt)).toEqual(['owl'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
