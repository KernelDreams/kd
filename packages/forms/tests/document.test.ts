import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  baseWidgets,
  ccv3Widgets,
  createCatalog,
  createDocument,
  fateWidgets,
  fromRfc6902,
  parseEditor,
  toPointer,
  toRfc6902,
  type EditorDef,
  type PatchOp,
} from '../src/editor/index.js'

const FIX = join(__dirname, 'fixtures', 'editor')
const read = (f: string): string => readFileSync(join(FIX, f), 'utf8')
const FATE = parseEditor(read('fate.editor.mdz')).def
const CCV3 = parseEditor(read('ccv3.editor.mdz')).def
const yaroslava = (): Record<string, any> => JSON.parse(read('yaroslava.json'))
const catalog = createCatalog([...baseWidgets, ...fateWidgets, ...ccv3Widgets])

let n = 0
const seq = (): string => `id${String(++n).padStart(3, '0')}`
const open = (obj = yaroslava(), def: EditorDef = FATE) => createDocument(obj, def, { catalog, id: seq, now: () => 1 })

describe('пути и указатели', () => {
  it('путь команды → @_id строк, индекс скаляров', () => {
    const o = yaroslava()
    expect(toPointer(o, 'aspects[asp002].text')).toBe('/aspects/@asp002/text')
    expect(toPointer(o, 'aspects[1].text')).toBe('/aspects/@asp002/text')
    expect(toPointer(o, 'stress.physical[2]')).toBe('/stress/physical/2')
    expect(toPointer(o, '/aspects/@x/text')).toBe('/aspects/@x/text')
    expect(() => toPointer(o, 'aspects[nope].text')).toThrow(/E_ROW/)
  })
})

describe('createDocument: команды', () => {
  it('set → вычисление пересчитано, undo/redo, dirty', () => {
    const doc = open()
    expect(doc.calc('physicalBoxes')).toBe(4)
    const events: string[] = []
    doc.on('change', (e) => events.push(`${e.type}:${e.paths.join(',')}`))
    const r = doc.exec('object.set', { path: 'skills.physique', value: 3 })
    expect(r.ok).toBe(true)
    expect(r.patches).toEqual([{ op: 'replace', path: '/skills/physique', value: 3 }])
    expect(doc.calc('physicalBoxes')).toBe(5)
    expect(doc.calc('mentalBoxes')).toBe(4)
    expect(doc.dirty).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.calc('physicalBoxes')).toBe(4)
    expect(doc.dirty).toBe(false)
    expect(doc.redo()).toBe(true)
    expect((doc.object as any).skills.physique).toBe(3)
    expect(events).toEqual(['exec:skills.physique', 'undo:skills.physique', 'redo:skills.physique'])
  })

  it('пересчёт — только зависимых', () => {
    const doc = open()
    const before = doc.computed
    doc.exec('object.set', { path: 'name', value: 'Яра' })
    expect(doc.computed).toBe(before) // ничего не зависит от name — счёт не трогали
    doc.exec('object.set', { path: 'skills.will', value: 3 })
    expect(doc.calc('mentalBoxes')).toBe(5)
    expect(doc.calc('physicalBoxes')).toBe(4)
  })

  it('set в отсутствующий путь создаёт объекты; undo убирает', () => {
    const o = yaroslava()
    delete o.consequences
    const doc = open(o)
    const r = doc.exec('object.set', { path: 'consequences.mild', value: 'Ушиб' })
    expect(r.patches).toEqual([{ op: 'add', path: '/consequences', value: { mild: 'Ушиб' } }])
    doc.undo()
    expect('consequences' in (doc.object as object)).toBe(false)
  })

  it('то же значение — без записи истории', () => {
    const doc = open()
    const r = doc.exec('object.set', { path: 'name', value: 'Ярослава' })
    expect(r.ok).toBe(true)
    expect(doc.history).toHaveLength(0)
  })

  it('insert со своим id (адрес из файла); занятый id — ошибка', () => {
    const doc = open()
    const r = doc.exec('object.insert', { path: 'aspects', id: 'mine', item: { _id: 'ignored', text: 'Свой' } })
    expect(r).toMatchObject({ ok: true, id: 'mine' })
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp001', 'asp002', 'mine'])
    expect(doc.exec('object.insert', { path: 'aspects', id: 'asp001', item: {} }).errors?.[0]).toMatch(/E_ID/)
  })

  it('insert ставит _id, remove по _id, undo возвращает на место', () => {
    const doc = open()
    const r = doc.exec('object.insert', { path: 'aspects', item: { text: 'Новый' }, before: 'asp002' })
    expect(r.ok).toBe(true)
    const id = r.id!
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp001', id, 'asp002'])
    doc.exec('object.remove', { path: 'aspects', id: 'asp001' })
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual([id, 'asp002'])
    doc.undo()
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp001', id, 'asp002'])
    doc.undo()
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp001', 'asp002'])
  })

  it('ошибка команды — ok:false, документ цел', () => {
    const doc = open()
    const before = doc.object
    expect(doc.exec('object.remove', { path: 'aspects', id: 'zzz' }).errors?.[0]).toMatch(/^E_ROW/)
    expect(doc.exec('object.set', { value: 1 }).errors?.[0]).toMatch(/^E_ARGS: нет "path"/)
    expect(doc.exec('object.nope', {}).errors?.[0]).toMatch(/^E_COMMAND/)
    expect(doc.exec('object.set', { path: 'name.first', value: 1 }).ok).toBe(false)
    expect(doc.object).toBe(before)
    expect(doc.history).toHaveLength(0)
  })

  it('ошибки данных — в errors, правка проходит', () => {
    const doc = open()
    expect(doc.errors).toEqual([])
    const r = doc.exec('object.set', { path: 'name', value: '' })
    expect(r.ok).toBe(true)
    expect(doc.errors.map((e) => `${e.code} ${e.where}`)).toEqual(['E_REQUIRED name'])
    doc.exec('object.set', { path: 'skills.lore', value: 'много' })
    expect(doc.errors.map((e) => e.code)).toContain('E_VALUE')
    expect(doc.errors.map((e) => e.code)).not.toContain('E_EXPR')
    doc.exec('object.set', { path: 'skills.physique', value: 'x' })
    expect(doc.errors.some((e) => e.code === 'E_EXPR' && e.where === 'physicalBoxes')).toBe(false) // 'x' >= 1 считается в nunjucks
    doc.exec('object.set', { path: 'skills.athletics', value: 12 })
    expect(doc.errors.some((e) => e.code === 'E_RANGE' && e.where === 'skills.athletics')).toBe(true)
  })

  it('required скрытой секции не требуется', () => {
    const def = parseEditor('$editor: 1\n$id: t\n\n## $section a\n$show-if: {kind: ["bot"]}\n\n### $field kind\n$type: string\n\n### $field name\n$type: string\n$required: true').def
    const doc = createDocument({ kind: 'persona' }, def)
    expect(doc.errors).toEqual([])
    doc.exec('object.set', { path: 'kind', value: 'bot' })
    // kind сам в секции: секция видна, name пусто
    expect(doc.errors.map((e) => e.code)).toEqual(['E_REQUIRED'])
  })
})

describe('пачки и группы', () => {
  it('batch — одна запись undo', () => {
    const doc = open()
    const r = doc.batch('Агент: трек богатства', [
      { name: 'object.set', args: { path: 'skills.physique', value: 3 } },
      { name: 'object.insert', args: { path: 'aspects', item: { text: 'Богатство' } } },
      { name: 'object.set', args: { path: 'stress.physical', value: [true, false, false, false, false] } },
    ])
    expect(r.ok).toBe(true)
    expect(doc.history).toHaveLength(1)
    expect(doc.history[0]!.label).toBe('Агент: трек богатства')
    expect(doc.history[0]!.patches).toHaveLength(3)
    expect(doc.calc('physicalBoxes')).toBe(5)
    doc.undo()
    expect(doc.object).toEqual(yaroslava())
    doc.redo()
    expect((doc.object as any).aspects).toHaveLength(3)
  })

  it('ошибка шага откатывает всю пачку', () => {
    const doc = open()
    const before = doc.object
    const r = doc.batch('сломанная', [
      { name: 'object.set', args: { path: 'name', value: 'Яра' } },
      { name: 'object.remove', args: { path: 'aspects', id: 'нет-такой' } },
    ])
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toMatch(/^\[1\] object\.remove: E_ROW/)
    expect(doc.object).toBe(before)
    expect(doc.history).toHaveLength(0)
    expect(doc.dirty).toBe(false)
  })

  it('begin/end — одна запись, abort откатывает', () => {
    const doc = open()
    doc.begin('скрипт')
    doc.exec('object.set', { path: 'name', value: 'A' })
    doc.begin('вложенная')
    doc.exec('object.set', { path: 'trouble', value: 'B' })
    doc.end()
    expect(doc.undo()).toBe(false)
    doc.end()
    expect(doc.history.map((h) => h.label)).toEqual(['скрипт'])
    doc.undo()
    expect(doc.object).toEqual(yaroslava())

    doc.begin('отмена')
    doc.exec('object.set', { path: 'name', value: 'C' })
    expect(doc.dirty).toBe(true)
    doc.abort()
    expect((doc.object as any).name).toBe('Ярослава')
    expect(doc.history).toHaveLength(0)
  })

  it('markClean — точка сохранения', () => {
    const doc = open()
    doc.exec('object.set', { path: 'name', value: 'A' })
    doc.markClean()
    expect(doc.dirty).toBe(false)
    doc.exec('object.set', { path: 'name', value: 'B' })
    expect(doc.dirty).toBe(true)
    doc.undo()
    expect(doc.dirty).toBe(false)
    doc.undo()
    expect(doc.dirty).toBe(true)
  })
})

describe('патчи по _id', () => {
  it('переживают перестановку строк', () => {
    const doc = open()
    doc.exec('object.set', { path: 'aspects[asp002].text', value: 'Тропы знаю' })
    const patch = doc.history[0]!.patches
    expect(patch).toEqual([{ op: 'replace', path: '/aspects/@asp002/text', value: 'Тропы знаю' }])
    // Переставить строки и применить тот же патч к переставленному объекту — правка той же строки.
    const reordered = { ...yaroslava(), aspects: [...yaroslava().aspects].reverse() }
    const out = applyPatches(reordered, patch)
    expect(out.aspects.map((a: any) => [a._id, a.text])).toEqual([
      ['asp002', 'Тропы знаю'],
      ['asp001', 'Сестра пропала на Купалу'],
    ])
    // undo после move — обратные патчи по _id тоже.
    doc.exec('object.move', { path: 'aspects', id: 'asp002', before: 'asp001' })
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp002', 'asp001'])
    doc.undo()
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp001', 'asp002'])
    doc.undo()
    expect(doc.object).toEqual(yaroslava())
  })

  it('move: в конец, на своё место — без записи', () => {
    const doc = open()
    expect(doc.exec('object.move', { path: 'aspects', id: 'asp002' }).patches).toEqual([])
    expect(doc.exec('object.move', { path: 'aspects', id: 'asp001', before: 'asp002' }).patches).toEqual([])
    const r = doc.exec('object.move', { path: 'aspects', id: 'asp001' })
    expect(r.patches).toEqual([{ op: 'move', from: '/aspects/@asp001', path: '/aspects/-' }])
    expect((doc.object as any).aspects.map((a: any) => a._id)).toEqual(['asp002', 'asp001'])
    expect(doc.history[0]!.inverse).toEqual([{ op: 'move', from: '/aspects/@asp001', path: '/aspects/@asp002' }])
  })

  it('история сериализуется: JSON → применить к исходному = текущее', () => {
    const doc = open()
    doc.exec('object.insert', { path: 'stunts', item: { name: 'Тень', description: '' } })
    doc.exec('object.set', { path: 'stunts[stn001].name', value: 'Отвар' })
    doc.exec('object.move', { path: 'stunts', id: 'stn001' })
    doc.exec('object.set', { path: 'stress.physical', value: [true, true, false, false] })
    const wire: PatchOp[] = JSON.parse(JSON.stringify(doc.history.flatMap((h) => h.patches)))
    expect(applyPatches(yaroslava(), wire)).toEqual(doc.object)
    const inverse: PatchOp[] = JSON.parse(JSON.stringify(doc.history.slice().reverse().flatMap((h) => h.inverse)))
    expect(applyPatches(doc.object, inverse)).toEqual(yaroslava())
  })

  it('toRfc6902 / fromRfc6902 — индексы туда и обратно', () => {
    const doc = open()
    doc.exec('object.insert', { path: 'aspects', item: { text: 'Третий' }, before: 'asp001' })
    const id = (doc.object as any).aspects[0]._id
    doc.exec('object.set', { path: `aspects[${id}].text`, value: 'Первый' })
    doc.exec('object.move', { path: 'aspects', id: 'asp002', before: id })
    doc.exec('object.remove', { path: 'aspects', id: 'asp001' })
    const patches = doc.history.flatMap((h) => h.patches)
    const rfc = toRfc6902(patches, yaroslava())
    expect(rfc).toEqual([
      { op: 'add', path: '/aspects/0', value: { _id: id, text: 'Третий' } },
      { op: 'replace', path: '/aspects/0/text', value: 'Первый' },
      { op: 'move', from: '/aspects/2', path: '/aspects/0' },
      { op: 'remove', path: '/aspects/2' },
    ])
    // RFC применяется индексами (наш applyOp понимает и их).
    expect(applyPatches(yaroslava(), rfc as PatchOp[])).toEqual(doc.object)
    const back = fromRfc6902(rfc, yaroslava())
    expect(back).toEqual(patches)
  })

  it('apply: внешние патчи одной записью, кривой патч — ok:false', () => {
    const doc = open()
    const r = doc.apply([{ op: 'replace', path: '/aspects/@asp001/text', value: 'X' }], 'из библиотеки')
    expect(r.ok).toBe(true)
    expect(doc.history.map((h) => h.label)).toEqual(['из библиотеки'])
    expect(doc.apply([{ op: 'remove', path: '/aspects/@nope' }]).errors?.[0]).toMatch(/^E_ROW/)
  })
})

describe('строки получают _id', () => {
  it('при открытии и при set списком', () => {
    const o = yaroslava()
    o.aspects = [{ text: 'без id' }]
    const doc = open(o)
    const id = (doc.object as any).aspects[0]._id
    expect(id).toMatch(/^id\d+$/)
    expect(doc.dirty).toBe(false)
    doc.exec('object.set', { path: 'stunts', value: [{ name: 'a' }, { name: 'b' }] })
    expect((doc.object as any).stunts.every((s: any) => typeof s._id === 'string')).toBe(true)
  })

  it('вложенные повторители (ccv3 лорбук) — путь строки внутри группы', () => {
    const persona = JSON.parse(read('persona.json'))
    const doc = createDocument(persona, CCV3, { catalog, id: seq })
    const r = doc.exec('object.insert', { path: 'data.character_book.entries', item: { keys: ['лес'], content: 'Лес' } })
    expect(r.ok).toBe(true)
    expect(doc.get(`data.character_book.entries[${r.id}].content`)).toBe('Лес')
    expect(doc.errors).toEqual([])
  })
})

describe('commands — тулы', () => {
  it('у каждой команды схема и описание', () => {
    const doc = open()
    expect(Object.keys(doc.commands)).toEqual(['object.set', 'object.unset', 'object.insert', 'object.remove', 'object.move'])
    for (const c of Object.values(doc.commands)) {
      expect(c.schema.type).toBe('object')
      expect(c.describe.length).toBeGreaterThan(5)
    }
  })
})
