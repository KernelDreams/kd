import { describe, expect, it } from 'vitest'
import {
  addressKey,
  ancestors,
  baseName,
  collectDecorations,
  compileMask,
  decodeState,
  defaultState,
  dirsToReload,
  encodeState,
  extOf,
  formatSize,
  freeName,
  goTo,
  invert,
  isUnder,
  joinPath,
  kindOf,
  normalizePath,
  operands,
  parentPath,
  planOp,
  planRename,
  quickFind,
  relativeTo,
  renameDiff,
  sameHost,
  selectByMask,
  selectRange,
  sortEntries,
  toggle,
  treeRows,
  undoSteps,
  type DirLoad,
  type Entry,
} from '../src/index.js'

const f = (name: string, extra: Partial<Entry> = {}): Entry => ({ name, path: `/d/${name}`, kind: 'file', ...extra })
const d = (name: string, path = `/d/${name}`): Entry => ({ name, path, kind: 'dir' })

describe('адрес', () => {
  it('пути', () => {
    expect(normalizePath('//a/./b/../c/')).toBe('/a/c')
    expect(normalizePath('/..')).toBe('/')
    expect(baseName('/a/b.png')).toBe('b.png')
    expect(parentPath('/a/b')).toBe('/a')
    expect(parentPath('/a')).toBe('/')
    expect(joinPath('/a', 'b/c', '../d')).toBe('/a/b/d')
    expect(isUnder('/a/b', '/a')).toBe(true)
    expect(isUnder('/ab', '/a')).toBe(false)
    expect(relativeTo('/a/b/c', '/a')).toBe('b/c')
    expect(relativeTo('/x', '/a')).toBeNull()
    expect(ancestors('/a/b')).toEqual(['/', '/a', '/a/b'])
    expect(extOf('a.Tar.GZ')).toBe('gz')
    expect(extOf('.env')).toBe('')
    expect(addressKey({ host: 'mini', path: '/a' })).toBe('mini:/a')
    expect(sameHost(undefined, 'mini', 'mini')).toBe(true)
    expect(sameHost('linux', 'mini', 'mini')).toBe(false)
  })
})

describe('записи', () => {
  it('сортировка Far: каталоги сверху, числа по-человечески, размер, дата, обратная', () => {
    const list = [f('img10.png', { size: 5 }), d('zdir'), f('img2.png', { size: 50 }), d('adir'), f('a.txt', { size: 7 })]
    expect(sortEntries(list).map((e) => e.name)).toEqual(['adir', 'zdir', 'a.txt', 'img2.png', 'img10.png'])
    expect(sortEntries(list, { key: 'size' }).map((e) => e.name)).toEqual(['adir', 'zdir', 'img10.png', 'a.txt', 'img2.png'])
    expect(sortEntries(list, { key: 'name', desc: true }).map((e) => e.name)).toEqual(['zdir', 'adir', 'img10.png', 'img2.png', 'a.txt'])
    expect(sortEntries(list, { key: 'ext' }).map((e) => e.name).slice(2)).toEqual(['img2.png', 'img10.png', 'a.txt'])
  })
  it('вид, маски, быстрый поиск, размер', () => {
    expect(kindOf(f('x.PNG'))).toBe('image')
    expect(kindOf(f('x.mov'))).toBe('video')
    expect(kindOf(d('x.png'))).toBe('dir')
    const m = compileMask('*.png;*.jpg|tmp*')
    expect(m('a.PNG')).toBe(true)
    expect(m('tmp.png')).toBe(false)
    expect(m('a.gif')).toBe(false)
    expect(compileMask('foo')('xfooy.txt')).toBe(true)
    expect(compileMask('')('any')).toBe(true)
    const names = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }, { name: 'alef' }]
    expect(quickFind(names, 'al')).toBe(0)
    expect(quickFind(names, 'al', 1)).toBe(3)
    expect(quickFind(names, 'mm')).toBe(2)
    expect(quickFind(names, 'zz')).toBe(-1)
    expect(formatSize(1536)).toBe('1.5 КБ')
    expect(formatSize(12)).toBe('12 Б')
  })
})

describe('состояние вкладки', () => {
  it('туда и обратно; по умолчанию не пишется; мусор — по умолчанию', () => {
    const s = { ...defaultState('/a', 'linux'), view: 'thumbs' as const, sort: { key: 'mtime' as const, desc: true }, cursor: 'x.png', selection: ['a', 'b'], hidden: true, tile: 200 }
    const p = encodeState(s)
    expect(p).toEqual({ path: '/a', host: 'linux', view: 'thumbs', sort: '-mtime', cursor: 'x.png', sel: 'a\nb', hidden: '1', tile: '200' })
    expect(decodeState(p)).toEqual(s)
    expect(encodeState(defaultState('/x'))).toEqual({ path: '/x' })
    expect(decodeState({ path: '/x', view: 'bogus', sort: 'nope', cols: 'size,bad', tile: '9999' })).toMatchObject({ view: 'far', sort: { key: 'name' }, columns: ['name', 'size'], tile: 320 })
    expect(decodeState({}, '/home').path).toBe('/home')
    expect(goTo({ ...s }, '/a/b', 'c')).toMatchObject({ path: '/a/b', selection: [], cursor: 'c' })
  })
})

describe('выделение', () => {
  const es = [d('..', '/'), d('dir'), f('a.png'), f('b.jpg'), f('c.txt')]
  it('toggle, диапазон, маска, инверсия, операнды', () => {
    expect(toggle([], '..')).toEqual([])
    expect(toggle(['a.png'], 'a.png')).toEqual([])
    const names = es.map((e) => e.name)
    expect(selectRange([], names, 0, 3)).toEqual(['dir', 'a.png', 'b.jpg'])
    expect(selectByMask([], es, '*.png;*.jpg', true)).toEqual(['a.png', 'b.jpg'])
    expect(selectByMask(['a.png', 'c.txt'], es, '*.png', false)).toEqual(['c.txt'])
    expect(invert(['a.png'], es)).toEqual(['b.jpg', 'c.txt'])
    expect(operands([], 'c.txt')).toEqual(['c.txt'])
    expect(operands([], '..')).toEqual([])
    expect(operands(['a'], 'c.txt')).toEqual(['a'])
  })
})

describe('план F5/F6', () => {
  it('в каталог, под новым именем, конфликты, в самого себя', () => {
    const p = planOp('copy', ['/a/x.txt', '/a/dir'], '/b', { exists: (to) => to === '/b/x.txt' })
    expect(p.items).toEqual([
      { from: '/a/x.txt', to: '/b/x.txt', conflict: true },
      { from: '/a/dir', to: '/b/dir' },
    ])
    expect(planOp('copy', ['/a/x.txt'], '/a/y.txt', { destIsDir: false }).items).toEqual([{ from: '/a/x.txt', to: '/a/y.txt' }])
    expect(planOp('copy', ['/a/dir'], '/a/dir/sub').errors).toEqual([{ from: '/a/dir', reason: 'into-self' }])
    expect(planOp('move', ['/a/x'], '/a').errors).toEqual([{ from: '/a/x', reason: 'same' }])
    expect(freeName('a.txt', (n) => ['a.txt', 'a (2).txt'].includes(n))).toBe('a (3).txt')
  })
})

describe('пакетное переименование', () => {
  it('план, обмен через временное имя, отмена, ошибки', () => {
    const plan = planRename(['a', 'b', 'c'], 'b\na\nc2\n', ['a', 'b', 'c', 'z'])
    expect(plan.errors).toEqual([])
    expect(plan.pairs).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'c', to: 'c2' },
    ])
    // Применить шаги к множеству имён — получится ровно задуманное.
    const apply = (names: Set<string>, steps: { from: string; to: string }[]) => {
      for (const s of steps) {
        expect(names.has(s.to)).toBe(false)
        names.delete(s.from)
        names.add(s.to)
      }
      return names
    }
    const after = apply(new Set(['a', 'b', 'c', 'z']), plan.steps)
    expect([...after].sort()).toEqual(['a', 'b', 'c2', 'z'])
    const back = apply(after, undoSteps(plan.steps))
    expect([...back].sort()).toEqual(['a', 'b', 'c', 'z'])
    expect(renameDiff([{ from: 'c', to: 'c2' }])).toBe('- c\n+ c2')
    expect(planRename(['a', 'b'], 'a\n').errors[0]).toMatch(/строк 1/)
    expect(planRename(['a', 'b'], 'x\nx').errors[0]).toMatch(/два раза/)
    expect(planRename(['a'], 'z', ['a', 'z']).errors[0]).toMatch(/уже есть/)
    expect(planRename(['a'], 'x/y').errors[0]).toMatch(/недопустимое/)
  })
})

describe('дерево', () => {
  it('раскрытые разворачиваются, фильтр оставляет предков, скрытые — по флагу', () => {
    const dirs = new Map<string, DirLoad>([
      ['/r', { status: 'ready', entries: [d('src', '/r/src'), f('.env', { path: '/r/.env' }), f('README.md', { path: '/r/README.md' })] }],
      ['/r/src', { status: 'ready', entries: [f('main.ts', { path: '/r/src/main.ts' })] }],
    ])
    const rows = treeRows('/r', dirs, new Set(['/r/src']))
    expect(rows.map((r) => [r.entry.name, r.depth])).toEqual([
      ['src', 0],
      ['main.ts', 1],
      ['README.md', 0],
    ])
    expect(treeRows('/r', dirs, new Set(['/r/src']), { filter: 'main' }).map((r) => r.entry.name)).toEqual(['src', 'main.ts'])
    expect(treeRows('/r', dirs, new Set(), { hidden: true }).map((r) => r.entry.name)).toContain('.env')
    expect(dirsToReload(['/r/src/main.ts'], dirs.keys())).toEqual(['/r/src'])
    expect(dirsToReload([''], dirs.keys())).toEqual(['/r', '/r/src'])
  })
})

describe('пометки', () => {
  it('склейка поставщиков, упавший — молча', async () => {
    const got = await collectDecorations(
      [
        { id: 'git', decorate: async () => new Map([['/a', [{ source: 'git', badge: 'M', tone: 'modified' as const }]]]) },
        { id: 'boom', decorate: async () => Promise.reject(new Error('x')) },
        { id: 'agent', decorate: async () => new Map([['/a', [{ source: 'agent', badge: '✎' }]]]) },
      ],
      '/',
      ['/a'],
    )
    expect(got.get('/a')?.map((x) => x.source)).toEqual(['git', 'agent'])
  })
})
