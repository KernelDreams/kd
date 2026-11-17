import { describe, expect, it } from 'vitest'
import { recordColor, recordHue } from '../src/index.js'

describe('recordHue (v1.56, objects-spec §19.1)', () => {
  it('стабилен по id, квантован в ступени', () => {
    expect(recordHue('coin_dragon')).toBe(recordHue('coin_dragon'))
    const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'].map((x) => recordHue(x, 12)))
    for (const h of hues) expect(((h / 30) - 0.5) % 1).toBeCloseTo(0)
    expect(hues.size).toBeGreaterThan(4)
  })
  it('ступеней 4 — четыре оттенка', () => {
    const all = new Set(Array.from({ length: 200 }, (_, i) => recordHue(`r${i}`, 4)))
    expect([...all].sort((a, b) => a - b)).toEqual([45, 135, 225, 315])
  })
  it('цвет — относительный OKLCH от токена скина', () => {
    expect(recordColor(135)).toBe('oklch(from var(--nr-record-base) l c 135)')
    expect(recordColor(135, 'accent')).toBe('oklch(from var(--nr-record-accent) l c 135)')
  })
})
