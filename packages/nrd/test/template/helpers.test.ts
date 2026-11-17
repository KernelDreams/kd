import { describe, it, expect } from 'vitest'
import { objectContext } from '../../src/core/index.js'
import { createEnv, render } from '../../src/template/index.js'
import { section, json, unique, sortBy, groupBy, pluck, flatten, trimEmpty, indent } from '../../src/template/index.js'

const env = await createEnv()

describe('helpers — прямой вызов', () => {
  it('section извлекает markdown-секцию', () => {
    const md = '# Top\n## Bio\nline a\nline b\n## Next\nx'
    expect(section(md, 'Bio')).toBe('line a\nline b')
    expect(section(md, 'Missing')).toBe('')
  })

  it('json', () => {
    expect(json({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('unique — по значению и по ключу', () => {
    expect(unique([1, 1, 2, 3, 3])).toEqual([1, 2, 3])
    expect(unique([{ id: 1 }, { id: 1 }, { id: 2 }], 'id')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('sortBy — по полю', () => {
    const arr = [{ n: 3 }, { n: 1 }, { n: 2 }]
    expect(sortBy(arr, 'n')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('groupBy / pluck', () => {
    const arr = [
      { type: 'a', v: 1 },
      { type: 'b', v: 2 },
      { type: 'a', v: 3 },
    ]
    expect(groupBy(arr, 'type')).toEqual({ a: [arr[0], arr[2]], b: [arr[1]] })
    expect(pluck(arr, 'v')).toEqual([1, 2, 3])
    expect(flatten([[1, [2]], [3], 4])).toEqual([1, [2], 3, 4])
    expect(flatten([[1, [2]]], 2)).toEqual([1, 2])
    expect(flatten('x')).toEqual([])
    expect(render(env, '<< xs | pluck("c") | flatten | length >>', objectContext({ xs: [{ c: [1, 2] }, { c: [3] }] }))).toBe('3')
  })

  it('trimEmpty / indent', () => {
    expect(trimEmpty('a\n\n\n\nb')).toBe('a\n\nb')
    expect(indent('a\nb', 2)).toBe('  a\n  b')
  })
})

describe('helpers — через фильтры в шаблоне', () => {
  it('| join', () => {
    const ctx = objectContext({ tags: ['x', 'y', 'z'] })
    expect(render(env, '<< tags | join(", ") >>', ctx)).toBe('x, y, z')
  })

  it('| json по массиву скаляров', () => {
    // json/yaml сериализуют массивы и скаляры; структурные объекты IContext не
    // перечисляют ключи (ограничение nrd-core), поэтому объект-значения через
    // фильтр не разворачиваются — для них есть json()-хелпер на готовых JS-данных.
    const ctx = objectContext({ tags: ['a', 'b'] })
    expect(render(env, '<< tags | json >>', ctx)).toBe('[\n  "a",\n  "b"\n]')
  })

  it('| sortBy + | pluck + | join', () => {
    const ctx = objectContext({
      items: [
        { name: 'c', ord: 3 },
        { name: 'a', ord: 1 },
        { name: 'b', ord: 2 },
      ],
    })
    expect(render(env, '<< items | sortBy("ord") | pluck("name") | join("-") >>', ctx)).toBe('a-b-c')
  })

  it('| section', () => {
    const ctx = objectContext({ doc: '## Bio\nhello\n## End' })
    expect(render(env, '<< doc | section("Bio") >>', ctx)).toBe('hello')
  })
})
