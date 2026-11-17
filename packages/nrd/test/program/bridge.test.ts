// Мост mds → псевдо-Block — перенос rz/test/bridge.test.ts (rz-merge §3.3).
import { describe, it, expect } from 'vitest'
import { objectContext } from '../../src/core/index.js'
import type { InterpolatedValue } from '../../src/md/index.js'
import { attrsFromMeta, lexValue, mdsToRoot, valueFromMeta } from '../../src/program/bridge.js'
import { readBlockAttrs } from '../../src/program/blocks.js'
import { readDecls, findDecl } from '../../src/program/registry.js'

const mds = [
  "%meta {nr: {type: 'rz'}, cmd: 'action', slug: 'fight-club'}",
  'шапка ленты',
  '',
  "%source row {nr: {type: 'file', parse: 'mdd'}, path: './mdd/${slug}.md'}",
  '',
  "%fn build {nr: {lang: 'ts'}}",
  'код',
  '',
  '%system',
  'обычная нода чата',
  '',
].join('\n')

describe('мост mds → псевдо-Block', () => {
  const root = mdsToRoot(mds)

  it('%meta — конверт файла: мета в корневые атрибуты, тело в тело корня', () => {
    expect(root.attrs.map((a) => a.key.join('.'))).toEqual(['nr', 'cmd', 'slug'])
    expect(String(root.body).trim()).toBe('шапка ленты')
    expect(root.level).toBe(0)
  })

  it('роль → имя блока, name → id, мета → attrs, тело → body', () => {
    const source = root.children[0]
    expect(source.name).toBe('source')
    expect(source.id).toBe('row')
    expect(source.level).toBe(1)
    const fn = root.children[1]
    expect(fn.name).toBe('fn')
    expect(fn.id).toBe('build')
    expect(String(fn.body).trim()).toBe('код')
  })

  it('ноды без меты и имени проходят как есть', () => {
    const sys = root.children[2]
    expect(sys.name).toBe('system')
    expect(sys.id).toBeUndefined()
    expect(sys.attrs).toEqual([])
  })

  it('${} в мете лексится в InterpolatedValue со спанами', () => {
    const path = root.children[0].attrs.find((a) => a.key[0] === 'path')!
    const v = path.value as InterpolatedValue
    expect(v.raw).toBe('./mdd/${slug}.md')
    expect(v.placeholders).toHaveLength(1)
    expect(v.placeholders[0].raw).toBe('slug')
    expect(v.raw.slice(v.placeholders[0].start, v.placeholders[0].end)).toBe('${slug}')
  })

  it('и резолвится об контекст ровно как атрибут mdz', () => {
    const attrs = readBlockAttrs(root.children[0], objectContext({ slug: 'fight-club' }))
    expect(attrs['path']).toBe('./mdd/fight-club.md')
    // декларация сведена к плоской форме до диспатча
    expect(attrs['nr-type']).toBe('file')
    expect(attrs['nr-parse']).toBe('mdd')
  })

  it('строка без ${} остаётся строкой', () => {
    expect(lexValue('./x.md')).toBe('./x.md')
    expect(typeof lexValue('a ${b} c')).toBe('object')
  })

  it('вложенный json5-объект атомарен (NTS-261)', () => {
    expect(valueFromMeta({ type: 'file', deep: { a: 1 } })).toEqual({
      type: 'file',
      deep: { a: 1 },
    })
  })

  it('массивы: строки лексятся поэлементно', () => {
    const v = valueFromMeta(['a', 'x${y}z', 3]) as unknown[]
    expect(v[0]).toBe('a')
    expect((v[1] as InterpolatedValue).raw).toBe('x${y}z')
    expect(v[2]).toBe(3)
  })

  it('attrsFromMeta без меты — пустой список', () => {
    expect(attrsFromMeta(undefined)).toEqual([])
  })

  it('декларации ленты читаются тем же реестром, что блоки mdz', () => {
    const d = readDecls(root, objectContext({ slug: 'fight-club' }))
    expect(findDecl(d, 'source', 'row')?.type).toBe('file')
    expect(findDecl(d, 'fn', 'build')?.lang).toBe('ts')
    expect(findDecl(d, 'data')?.blockName).toBe('system')
  })
})
