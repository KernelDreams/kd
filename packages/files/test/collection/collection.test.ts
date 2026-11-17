import { describe, expect, it } from 'vitest'
import {
  buildTreeRows,
  collectDecorations,
  compileMask,
  decodeList,
  defaultList,
  encodeList,
  nextOf,
  operands,
  quickFind,
  selectByMask,
  sortItems,
  toggle,
  type DirLoad,
  type Item,
  type ListShape,
} from '../../src/collection/index.js'

/** Не файлы: персоны с тегом — источник без каталогов и расширений. */
interface Persona extends Item {
  tag: string
}
const p = (name: string, tag: string, kind: Item['kind'] = 'file'): Persona => ({ name, path: `/p/${name}`, kind, tag })
const SHAPE: ListShape<'cards' | 'table', 'name' | 'tag', 'name' | 'tag'> = {
  views: ['cards', 'table'],
  defaultView: 'cards',
  sortKeys: ['name', 'tag'],
  defaultSort: 'name',
  columns: ['name', 'tag'],
  defaultColumns: ['name'],
  firstColumn: 'name',
}

describe('сортировка', () => {
  it('группы сверху, ключ источника, равенство — по имени, числа по-человечески', () => {
    const list = [p('sol 10', 'b'), p('sol 2', 'a'), p('Ада', 'b'), p('heroes', '', 'dir')]
    expect(sortItems(list, { key: 'name' }, {}).map((x) => x.name)).toEqual(['heroes', 'sol 2', 'sol 10', 'Ада'])
    const byTag = { tag: (a: Persona, b: Persona) => a.tag.localeCompare(b.tag) }
    expect(sortItems(list, { key: 'tag', desc: true }, byTag).map((x) => x.name)).toEqual(['heroes', 'Ада', 'sol 10', 'sol 2'])
  })
})

describe('состояние списка', () => {
  it('умолчания не пишутся; туда и обратно; мусор отбрасывается; первая колонка на месте', () => {
    const s = defaultList(SHAPE)
    expect(encodeList(s, SHAPE)).toEqual({})
    const t = { ...s, view: 'table' as const, sort: { key: 'tag' as const, desc: true }, selection: ['a', 'b'], columns: ['name', 'tag'] as ('name' | 'tag')[], tile: 200 }
    const enc = encodeList(t, SHAPE)
    expect(enc).toEqual({ view: 'table', sort: '-tag', sel: 'a\nb', cols: 'name,tag', tile: '200' })
    expect(decodeList(enc, SHAPE, defaultList(SHAPE))).toEqual(t)
    expect(decodeList({ view: 'far', sort: 'size', cols: 'tag,x', tile: '9999' }, SHAPE, defaultList(SHAPE))).toEqual({ ...s, columns: ['name', 'tag'], tile: 320 })
    expect(nextOf(SHAPE.views, 'table')).toBe('cards')
  })
})

describe('маски, поиск, выделение', () => {
  it('маска Far, быстрый поиск, Gray+, операнды', () => {
    expect(compileMask('sol*|*10')('sol 2')).toBe(true)
    expect(compileMask('sol*|*10')('sol 10')).toBe(false)
    const list = [p('..', '', 'dir'), p('sol 2', 'a'), p('ada', 'b')]
    expect(quickFind(list, 'ad')).toBe(2)
    expect(selectByMask([], list, 's*', true)).toEqual(['sol 2'])
    expect(toggle(['ada'], '..')).toEqual(['ada'])
    expect(operands([], 'ada')).toEqual(['ada'])
  })
})

describe('дерево и пометки', () => {
  it('порядок группы — у источника; фильтр оставляет группы с совпадениями', () => {
    const dirs = new Map<string, DirLoad<Persona>>([
      ['/p', { status: 'ready', entries: [p('z', ''), { ...p('heroes', '', 'dir'), path: '/p/heroes' }] }],
      ['/p/heroes', { status: 'ready', entries: [{ ...p('sol', 'a'), path: '/p/heroes/sol' }] }],
    ])
    const order = (es: readonly Persona[]) => [...es].sort((a, b) => a.name.localeCompare(b.name))
    expect(buildTreeRows('/p', dirs, new Set(['/p/heroes']), { order }).map((r) => `${r.depth}:${r.entry.name}`)).toEqual(['0:heroes', '1:sol', '0:z'])
    expect(buildTreeRows('/p', dirs, new Set(['/p/heroes']), { order, filter: 'sol' }).map((r) => r.entry.name)).toEqual(['heroes', 'sol'])
  })
  it('пометки склеиваются, упавший поставщик молчит', async () => {
    const ok = { id: 'a', decorate: async () => new Map([['/p/sol', [{ source: 'a', badge: '★' }]]]) }
    const bad = { id: 'b', decorate: async () => { throw new Error('x') } }
    expect([...(await collectDecorations([ok, bad], '/p', ['/p/sol']))]).toEqual([['/p/sol', [{ source: 'a', badge: '★' }]]])
  })
})
