import { describe, expect, it } from 'vitest'
import { canSkins, type Capabilities } from '../src/index.js'

describe('canSkins (v1.21)', () => {
  it('гейт по capability и операции', () => {
    expect(canSkins(null)).toBe(false)
    expect(canSkins({ protocol: 1 })).toBe(false)
    const caps: Capabilities = { protocol: 1, skins: { save: true } }
    expect(canSkins(caps)).toBe(true)
    expect(canSkins(caps, 'save')).toBe(true)
    expect(canSkins(caps, 'select')).toBe(false)
  })
})
