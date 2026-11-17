import { describe, expect, it } from 'vitest'
import { canSessionSkills, sessionSkillNames, sessionSkills } from '../src/index.js'

describe('sessionSkills (v1.59, ABC-550)', () => {
  it('строка — loaded (скилл старта), записи с режимом, мусор мимо, дубли — первая', () => {
    const meta = { skills: ['nrchat', { name: 'runz', mode: 'linked', source: 'skillbox' }, { name: 'x', mode: 'bogus' }, 7, { name: 'nrchat', mode: 'linked' }, ' '] }
    expect(sessionSkills(meta)).toEqual([
      { name: 'nrchat', mode: 'loaded' },
      { name: 'runz', mode: 'linked', source: 'skillbox' },
    ])
    expect(sessionSkillNames(meta, 'linked')).toEqual(['runz'])
    expect(sessionSkillNames(meta, 'loaded')).toEqual(['nrchat'])
    expect(sessionSkills(null)).toEqual([])
  })
  it('гейт', () => {
    expect(canSessionSkills({ skills: { session: true } })).toBe(true)
    expect(canSessionSkills({})).toBe(false)
  })
})
