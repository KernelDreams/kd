import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baseWidgets,
  ccv3Widgets,
  check,
  compileExpr,
  createCatalog,
  createExpressions,
  deriveSchema,
  ensureIds,
  fateWidgets,
  formatIssue,
  formToEditor,
  normPath,
  parseEditor,
  type EditorDef,
  type FieldNode,
  type JSONSchema,
  type RepeatNode,
  type SectionNode,
} from '../src/editor/index.js'
import { buildSchema } from '../src/index.js'

const catalog = () => createCatalog([...baseWidgets, ...fateWidgets, ...ccv3Widgets])
const FATE = readFileSync(join(__dirname, 'fixtures', 'probe', 'reference', 'fate.mdz'), 'utf8')

/** Описание из куска mdz: шапка + тело. */
const mdz = (body: string): EditorDef => parseEditor(`$editor: 1\n$id: t\n\n${body}`).def
const errorsOf = (def: EditorDef, schema?: JSONSchema): string[] => check(def, catalog(), schema ? { schema } : {}).errors.map(formatIssue)

describe('parseEditor', () => {
  it('mdz: секции, пути, повторитель от элемента, вычисления, строки атрибутом', () => {
    const { def, issues } = parseEditor(FATE)
    expect(issues).toEqual([])
    expect(def).toMatchObject({ editor: 1, id: 'fate-condensed', title: 'Fate Condensed' })
    const secs = def.nodes as SectionNode[]
    expect(secs.map((s) => s.id)).toEqual(['character', 'aspects', 'skills', 'stunts', 'stress'])
    const [portrait, name] = secs[0]!.children as FieldNode[]
    expect(portrait).toMatchObject({ kind: 'field', path: 'portrait', widget: 'image', props: { aspect: '2:3' }, row: 'r1', line: 8 })
    expect(name).toMatchObject({ path: 'name', required: true, row: 'r1' })
    const physique = secs[2]!.children.find((n) => (n as FieldNode).id === 'physique') as FieldNode
    expect(physique).toMatchObject({ path: 'skills.physique', type: 'integer', min: -2, max: 8, default: 0 })
    const stunts = secs[3]!.children[0] as RepeatNode
    expect(stunts.children.map((c) => (c as FieldNode).path)).toEqual(['name', 'description'])
    expect(secs[4]!.children[0]).toMatchObject({ kind: 'computed', id: 'physicalBoxes', type: 'number' })
  })

  it('группа даёт префикс пути, $path перекрывает; вкладка — атрибут секции', () => {
    const def = mdz('## $section s\n$tab: main\n\n### $group skills\n\n#### $field physique\n$type: integer\n\n#### $field other\n$path: misc.other\n$type: string\n')
    const s = def.nodes[0] as SectionNode
    expect(s.tab).toBe('main')
    const g = s.children[0] as { path: string; children: FieldNode[] }
    expect(g.path).toBe('skills')
    expect(g.children.map((c) => c.path)).toEqual(['skills.physique', 'misc.other'])
  })

  it('JSON: kind или node, nodes или layout, kebab-ключи; ``` и BOM снимаются', () => {
    const json = { editor: 1, id: 'c', layout: [{ node: 'section', id: 'main', children: [{ node: 'field', path: 'kind', 'show-if': { a: ['x'] }, row: 'r' }] }] }
    const a = parseEditor('﻿```json\n' + JSON.stringify(json) + '\n```').def
    const b = parseEditor(json).def
    expect(a).toEqual(b)
    expect((a.nodes[0] as SectionNode).children[0]).toEqual({ kind: 'field', path: 'kind', showIf: { a: ['x'] }, row: 'r' })
  })

  it('битый ввод — E_PARSE и пустое описание; незнакомый атрибут и h7 — предупреждения', () => {
    expect(parseEditor('{oops').issues[0]).toMatchObject({ code: 'E_PARSE' })
    // Битая строка гасится, остальное разобрано.
    const part = parseEditor('$editor: 1\n$id: t\n\n## $section s\n\n### $field a\n$type: string\n$props: {kind: other}\n\n### $field b\n$type: string\n')
    expect(part.issues).toMatchObject([{ code: 'E_PARSE', line: 8, hint: '$props: {kind: other}' }])
    expect((part.def.nodes[0] as SectionNode).children.map((c) => (c as FieldNode).path)).toEqual(['a', 'b'])
    const { issues } = parseEditor('$editor: 1\n$id: t\n\n## $section s\n\n### $field a\n$type: string\n$show_if: {x: [1]}\n\n####### $field deep\n')
    expect(issues.map((i) => i.code)).toEqual(['W_DEPTH', 'W_ATTR'])
    expect(formatIssue(issues[1]!)).toMatch(/section s \/ field a: неизвестный атрибут \$show_if — у field: .*\$show-if/)
  })
})

describe('deriveSchema', () => {
  it('JSON Schema 2020-12 из полей: типы, required, enum, границы, массивы объектов, группы', () => {
    const s = deriveSchema(parseEditor(FATE).def)
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(s.required).toEqual(['name'])
    expect(s.properties!.skills!.properties!.physique).toEqual({ type: 'integer', title: 'Physique', minimum: -2, maximum: 8, default: 0 })
    expect(s.properties!.stress!.properties!.physical).toMatchObject({ type: 'array', items: { type: 'boolean' } })
    expect(s.properties!.stunts).toMatchObject({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } } })
  })
})

describe('check', () => {
  it('эталон Fate — чисто', () => {
    const r = check(parseEditor(FATE).def, catalog())
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('виджет не по типу — путь узла и подсказка', () => {
    const def = mdz('## $section stress\n\n### $field physical\n$path: stress.physical\n$type: integer\n$widget: fate.stress-track\n$props: {boxes: 3}\n')
    expect(errorsOf(def)).toEqual(['section stress / field physical: виджет fate.stress-track ждёт boolean[], а тип integer — к integer подходят: number, slider, fate.ladder, fate.fate-points (строка 6)'])
  })

  it('неизвестный узел row/tabs — с подсказкой про атрибуты; поле на верхнем уровне', () => {
    const def = mdz('## $section s\n\n### $row\n\n#### $field a\n$type: string\n')
    expect(errorsOf(def)[0]).toMatch(/section s \/ row: неизвестный узел "row" — строки — атрибутом \$row/)
    const top = parseEditor({ editor: 1, id: 't', nodes: [{ kind: 'field', path: 'a', type: 'string' }] }).def
    expect(errorsOf(top)[0]).toMatch(/field a: на верхнем уровне — только section/)
  })

  it('пути: мимо схемы, путь в повторителе от корня', () => {
    const def = parseEditor({
      editor: 1,
      id: 't',
      schema: { type: 'object', properties: { stunts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } },
      nodes: [{ kind: 'section', id: 's', children: [{ kind: 'repeat', path: 'stunts', children: [{ kind: 'field', path: 'stunts.name' }] }, { kind: 'field', path: 'nope' }] }],
    }).def
    expect(errorsOf(def)).toEqual([
      'section s / repeat stunts / field stunts.name: путь "stunts.name" мимо схемы — в повторителе путь — от элемента: name',
      'section s / field nope: путь "nope" мимо схемы',
    ])
  })

  it('select без enum, неизвестный виджет, нет виджета по умолчанию', () => {
    const def = mdz('## $section s\n\n### $field a\n$type: string\n$widget: select\n\n### $field b\n$type: string\n$widget: fate.laddr\n\n### $field c\n$type: object[]\n')
    const e = errorsOf(def)
    expect(e[0]).toMatch(/field a: виджет select ждёт поле с \$enum/)
    expect(e[1]).toMatch(/field b: неизвестный виджет "fate.laddr" — похожие: fate.ladder/)
    expect(e[2]).toMatch(/field c: для типа object\[\] нет виджета по умолчанию — укажи \$widget или используй \$repeat/)
  })

  it('show-if: путь мимо, значение не из enum, флаг в кавычках, не список', () => {
    const def = mdz(
      '## $section s\n\n### $field kind\n$type: string\n$enum: $[bot, persona]\n\n### $field on\n$type: boolean\n\n' +
        '## $section a\n$show-if: {kind: ["npc"]}\n\n### $text\n$text: x\n\n' +
        '## $section b\n$show-if: {on: ["true"], missing: ["x"]}\n\n### $text\n$text: y\n\n' +
        '## $section c\n$show-if: {kind: "bot"}\n\n### $text\n$text: z\n',
    )
    expect(errorsOf(def).map((e) => e.replace(/ \(строка \d+\)/, ''))).toEqual([
      'section a: $show-if.kind: "npc" нет в $enum — значения: "bot", "persona"',
      'section b: $show-if.on: "true" не boolean — флаг — без кавычек: [true]',
      'section b: $show-if: путь "missing" мимо схемы',
      'section c: $show-if.kind — не список значений — {kind: ["bot"]}',
    ])
  })

  it('props: "=id" без вычисления, обязательный prop, enum prop, путь refreshFrom', () => {
    const def = mdz(
      '## $section s\n\n### $field t\n$type: boolean[]\n$widget: fate.stress-track\n$props: {boxes: "=nope"}\n\n' +
        '### $field u\n$type: boolean[]\n$widget: fate.stress-track\n\n' +
        '### $field c\n$type: string\n$widget: fate.consequence\n$props: {severity: "huge"}\n\n' +
        '### $field fp\n$type: integer\n$widget: fate.fate-points\n$props: {refreshFrom: "refresh"}\n',
    )
    const e = errorsOf(def).map((x) => x.replace(/ \(строка \d+\)/, ''))
    expect(e[0]).toMatch(/field t: \$props.boxes = "=nope" — нет вычисления nope/)
    expect(e[1]).toMatch(/field u: виджету fate.stress-track нужен \$props.boxes/)
    expect(e[2]).toMatch(/field c: \$props.severity: "huge" — одно из "mild", "moderate", "severe"/)
    expect(e[3]).toMatch(/field fp: \$props.refreshFrom: путь "refresh" мимо схемы/)
  })

  it('выражения: {% %}, неизвестный фильтр, переменная мимо схемы, голое имя вычисления, item вне повторителя, тип', () => {
    const def = mdz(
      '## $section s\n\n### $field n\n$type: integer\n\n' +
        '### $computed a\n$type: number\n$expr: "{% if n %}1{% endif %}"\n\n' +
        '### $computed b\n$type: number\n$expr: "<< xs | map(\'x\') | length >>"\n\n' +
        '### $computed c\n$type: number\n$expr: "<< missing.thing + 1 >>"\n\n' +
        '### $computed d\n$type: number\n$expr: "<< base + 1 >>"\n\n' +
        '### $computed base\n$type: number\n$expr: "<< n * 2 >>"\n\n' +
        '### $computed e\n$type: number\n$expr: "<< item.x >>"\n\n' +
        '### $computed f\n$type: number\n$expr: "<< \'abc\' >>"\n',
    )
    const e = errorsOf(def).map((x) => x.replace(/ \(строка \d+\)/, ''))
    expect(e).toContain('section s / computed a: $expr: {% … %} — не ntpl — блоки — <{ … }>, значения — << … >>')
    expect(e.find((x) => x.startsWith('section s / computed b: $expr не считается: Error: filter not found: map — фильтры: '))).toBeTruthy()
    expect(e).toContain('section s / computed b: $expr: переменная xs мимо схемы')
    expect(e).toContain('section s / computed c: $expr: переменная missing.thing мимо схемы')
    expect(e).toContain('section s / computed d: $expr: переменная base мимо схемы — другое вычисление — calc.base')
    expect(e).toContain('section s / computed e: $expr: item — только внутри repeat')
    expect(e).toContain('section s / computed f: $expr не число: "abc"')
  })

  it('цикл вычислений — ошибка с цепочкой', () => {
    const def = mdz('## $section s\n\n### $computed a\n$type: number\n$expr: "<< calc.b + 1 >>"\n\n### $computed b\n$type: number\n$expr: "<< calc.a + 1 >>"\n\n### $computed c\n$type: number\n$expr: "<< calc.zz >>"\n')
    const e = errorsOf(def)
    expect(e).toContain('computed a: цикл вычислений: a → b → a — вычисление не может зависеть от себя через calc.*')
    expect(e.some((x) => x.includes('computed c: $expr: calc.zz — нет такого вычисления'))).toBe(true)
  })

  it('редактор против схемы типа: поле вне схемы и другой тип — ошибки, не новое поле', () => {
    const typeSchema = deriveSchema(parseEditor(FATE).def)
    const card = mdz('## $section card\n\n### $field name\n$type: string\n\n### $field refresh\n$type: string\n\n### $field wealth\n$path: stress.wealth\n$type: boolean[]\n$widget: fate.stress-track\n$props: {boxes: 2}\n')
    expect(errorsOf(card, typeSchema).map((x) => x.replace(/ \(строка \d+\)/, ''))).toEqual([
      'section card / field refresh: тип в описании string, в схеме integer — одно поле — один тип у всех редакторов типа',
      'section card / field wealth: путь "stress.wealth" мимо схемы — поле вне схемы типа: добавь его в редактор по умолчанию или в $schema типа',
    ])
    expect(errorsOf(card)).toEqual([]) // без схемы типа — своя выведенная
  })

  it('одно поле с разными типами в одном описании — ошибка', () => {
    const def = mdz('## $section s\n\n### $field a\n$type: string\n\n### $field a2\n$path: a\n$type: integer\n')
    expect(errorsOf(def)[0]).toMatch(/field a2: поле a уже объявлено с типом string, здесь integer/)
  })

  it('json-виджет над объектом и вложенное поле — разрешено, покрытие без предупреждений', () => {
    const def = mdz('## $section s\n\n### $field ext\n$type: object\n$widget: json\n\n### $field kind\n$path: ext.nrchat.kind\n$type: string\n')
    const r = check(def, catalog())
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('разорванная строка — предупреждение', () => {
    const def = mdz('## $section s\n\n### $field a\n$type: string\n$row: r\n\n### $field b\n$type: string\n\n### $field c\n$type: string\n$row: r\n')
    expect(check(def, catalog()).warnings.map(formatIssue)).toEqual(['section s / field c: строка "r" разорвана другими узлами — поля одной строки — подряд'])
  })
})

describe('выражения', () => {
  const def = parseEditor(FATE).def
  const fate = (physique: number) => ({ skills: { physique, will: 0 } })

  it('Fate: трек от Physique, без new Function', () => {
    const ex = createExpressions(def)
    const real = globalThis.Function
    globalThis.Function = new Proxy(real, { construct: () => { throw new EvalError('Code generation from strings disallowed') } }) as FunctionConstructor
    try {
      expect(ex.evaluate(fate(2)).values).toEqual({ physicalBoxes: 4, mentalBoxes: 3 })
      expect(ex.evaluate(fate(3)).values.physicalBoxes).toBe(5)
    } finally {
      globalThis.Function = real
    }
  })

  it('зависимости из AST и пересчёт только зависимых, транзитивно', () => {
    expect(compileExpr("<< item.scenes | pluck('clues') | flatten | selectattr('found') | length >>").deps).toEqual(['item.scenes'])
    expect(compileExpr('<{ for s in sessions }><< s.title >><{ endfor }><< (x | dump).split(",") | length >>').deps).toEqual(['sessions', 'x'])
    const d = mdz(
      '## $section s\n\n### $field n\n$type: integer\n\n### $field m\n$type: integer\n\n' +
        '### $computed a\n$type: number\n$expr: "<< n + 1 >>"\n\n### $computed b\n$type: number\n$expr: "<< calc.a * 2 >>"\n\n### $computed c\n$type: number\n$expr: "<< m >>"\n',
    )
    const ex = createExpressions(d)
    expect(ex.order).toEqual(['a', 'b', 'c'])
    expect(ex.affected(['n'])).toEqual(['a', 'b'])
    expect(ex.affected(['/m'])).toEqual(['c'])
    expect(ex.evaluate({ n: 1, m: 7 }).values).toEqual({ a: 2, b: 4, c: 7 })
  })

  it('вычисление в повторителе — на каждую строку по _id', () => {
    const d = mdz(
      '## $section s\n\n### $repeat sessions\n\n#### $computed found\n$type: number\n$expr: "<< item.scenes | pluck(\'clues\') | flatten | selectattr(\'found\') | length >>"\n\n' +
        '#### $repeat scenes\n\n##### $repeat clues\n\n###### $field found\n$type: boolean\n',
    )
    expect(check(d, catalog()).errors).toEqual([])
    const ex = createExpressions(d)
    const obj = {
      sessions: [
        { _id: 'a1', scenes: [{ clues: [{ found: true }, { found: false }] }, { clues: [{ found: true }] }] },
        { scenes: [] },
      ],
    }
    expect(ex.evaluate(obj).values).toEqual({ 'sessions[a1].found': 2, 'sessions[1].found': 0 })
    expect(ex.affected(['sessions[a1].scenes[x].clues[y].found'])).toEqual(['found'])
    expect(normPath('/sessions/@a1/scenes/0/title')).toBe('sessions.scenes.title')
  })
})

describe('каталог', () => {
  it('виджет по умолчанию по рангу; register добавляет сразу', () => {
    const c = catalog()
    const f = (type: string, extra: object = {}) => ({ type, path: 'x', schema: {}, ...extra })
    expect(c.pick(f('string'))?.id).toBe('text')
    expect(c.pick(f('string', { enum: ['a'] }))?.id).toBe('select')
    expect(c.pick(f('integer'))?.id).toBe('number')
    expect(c.pick(f('string', { format: 'date' }))?.id).toBe('date')
    expect(c.pick(f('object[]'))).toBeUndefined()
    c.register({ id: 'fate.stress-track-alt', types: ['boolean[]'], description: 'трек артефактом', frame: { srcdoc: '<div></div>' } })
    expect(c.get('fate.stress-track-alt')?.frame).toBeTruthy()
  })

  it('prompt: формат, атрибуты строк/вкладок, фильтры с flatten, все виджеты с props, пример', () => {
    const p = catalog().prompt()
    for (const w of [...baseWidgets, ...fateWidgets, ...ccv3Widgets]) expect(p).toContain(`| \`${w.id}\` |`)
    expect(p).toContain('`$row: <имя>`')
    expect(p).toContain('`flatten`')
    expect(p).toContain('`pluck`')
    expect(p).toContain('`boxes` (integer|number)')
    expect(p).toContain('$props: {boxes: "=physicalBoxes"}')
  })
})

describe('ensureIds', () => {
  const schema = deriveSchema(mdz('## $section s\n\n### $repeat sessions\n\n#### $field t\n$type: string\n\n#### $repeat scenes\n\n##### $field k\n$type: string\n\n### $field tags\n$type: string[]\n'))
  let n = 0
  const id = () => `id${++n}`

  it('проставляет вглубь, существующие не трогает, повторы заменяет, исходник цел', () => {
    const obj = { tags: ['a'], sessions: [{ _id: 'keep', t: 'x', scenes: [{ k: '1' }, { _id: 'dup', k: '2' }, { _id: 'dup', k: '3' }] }, { t: 'y' }] }
    const before = JSON.stringify(obj)
    const out = ensureIds(obj, schema, { id })
    expect(JSON.stringify(obj)).toBe(before)
    expect(out.sessions[0]!._id).toBe('keep')
    expect(out.sessions[0]!.scenes!.map((s) => s._id)).toEqual(['id1', 'dup', 'id2'])
    expect(out.sessions[1]).toEqual({ _id: 'id3', t: 'y' })
    expect(out.tags).toBe(obj.tags)
  })

  it('всё на месте — тот же объект', () => {
    const obj = { sessions: [{ _id: 'a', scenes: [] }] }
    expect(ensureIds(obj, schema)).toBe(obj)
  })
})

describe('форма рецепта → описание', () => {
  it('секции, $nr-show-if → showIf, $nr-collapsed → collapsed, порядок и подписи как есть', () => {
    const form = buildSchema(
      [
        { name: 'run', spec: 'select greet, run // Режим', section: '' },
        { name: 'prompt', spec: 'text // Промпт', section: '' },
        { name: 'steps', spec: 'number // Шаги', section: 'tune' },
        { name: 'model', spec: 'model? // Модель', section: 'tune' },
      ],
      { run: 'greet', steps: '20' },
      { sections: [{ id: '', title: '' }, { id: 'tune', title: 'Тонко', collapsed: true, showIf: { run: ['run'] } }] },
    )
    const def = formToEditor(form, { id: 'recipe', title: 'Рецепт' })
    expect(def.nodes).toMatchObject([
      { kind: 'section', id: 'main', children: [{ path: 'run', type: 'string', widget: 'select', enum: ['greet', 'run'], label: 'Режим', default: 'greet', required: true }, { path: 'prompt', widget: 'textarea' }] },
      { kind: 'section', id: 'tune', title: 'Тонко', collapsed: true, showIf: { run: ['run'] }, children: [{ path: 'steps', type: 'number', default: 20 }, { path: 'model', widget: 'model' }] },
    ])
    const c = catalog()
    c.register({ id: 'model', types: ['string'], description: 'модель (nrchat)' })
    expect(check(def, c).errors).toEqual([])
  })
})

describe('корневой $show-if описания (ABC-723)', () => {
  it('разбирается в def.showIf', async () => {
    const { parseEditor } = await import('../src/editor/index.js')
    const { def } = parseEditor('$editor: 1\n$id: bot-nr\n$show-if: {"extensions.nrchat.type": ["nr"]}\n## $section s\n### $field name\n$type: string\n')
    expect(def.showIf).toEqual({ 'extensions.nrchat.type': ['nr'] })
  })
})
