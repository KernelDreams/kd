import { describe, it, expect } from 'vitest'
import { generateId } from '../../src/infra/id.js'

const CVCVCV = /^[bcdfghjklmnpqrstvwxyz][aeiou]/

describe('generateId', () => {
  it('дефолт — 6 символов', () => {
    expect(generateId()).toHaveLength(6)
  })

  it('кастомная длина', () => {
    expect(generateId(8)).toHaveLength(8)
    expect(generateId(2)).toHaveLength(2)
  })

  it('формат CVCVCV: чётные — согласные, нечётные — гласные', () => {
    const consonants = 'bcdfghjklmnpqrstvwxyz'
    const vowels = 'aeiou'
    for (let n = 0; n < 100; n++) {
      const id = generateId(6)
      for (let i = 0; i < id.length; i++) {
        const set = i % 2 === 0 ? consonants : vowels
        expect(set).toContain(id[i])
      }
    }
    expect(CVCVCV.test(generateId())).toBe(true)
  })

  it('разумная уникальность', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(generateId(8))
    // 8 символов → ~11M вариантов, на 200 коллизий быть не должно
    expect(ids.size).toBe(200)
  })
})
