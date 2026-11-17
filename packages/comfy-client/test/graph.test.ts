import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comfyGraph } from '../src/index.js'

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))

describe('comfyGraph (ABC-808, часть Б)', () => {
  it('UI-граф: ноды, пины с типами, провода, группы — числа как в JSON', () => {
    const wf = fx('ui-small.json')
    const g = comfyGraph(wf)
    expect(g.format).toBe('ui')
    expect(g.nodes.length).toBe(wf.nodes.length)
    expect(g.links.length).toBe(wf.links.length)
    expect(g.groups.length).toBe(wf.groups.length)
    const ks = g.nodes.find((n) => n.type === 'KSampler')
    expect(ks?.outputs[0]?.type).toBe('LATENT')
    expect(ks?.inputs.find((i) => i.type === 'MODEL')?.linked).toBe(true)
    expect(ks?.widgets.length).toBeGreaterThan(3)
    for (const l of g.links) {
      const from = g.nodes.find((n) => n.id === l.from.node)!
      const to = g.nodes.find((n) => n.id === l.to.node)!
      expect(from.outputs[l.from.slot]).toBeDefined()
      expect(to.inputs[l.to.slot]).toBeDefined()
    }
  })

  it('большая схема (72 ноды, 112 проводов, 4 группы)', () => {
    const g = comfyGraph(fx('ui-big.json'))
    expect([g.nodes.length, g.links.length, g.groups.length]).toEqual([72, 112, 4])
  })

  it('API-формат: провода из входов-ссылок, раскладка слоями, виджеты строками', () => {
    const p = fx('qwen21-edit.json')
    const g = comfyGraph(p)
    expect(g.format).toBe('api')
    expect(g.nodes.length).toBe(Object.keys(p).length)
    const refs = Object.values(p).flatMap((n: any) => Object.values(n.inputs ?? {}).filter((v: any) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'number' && String(v[0]) in p))
    expect(g.links.length).toBe(refs.length)
    for (const l of g.links) {
      expect(g.nodes.find((n) => n.id === l.to.node)!.inputs[l.to.slot]).toBeDefined()
      expect(g.nodes.find((n) => n.id === l.from.node)!.x).toBeLessThan(g.nodes.find((n) => n.id === l.to.node)!.x)
    }
  })
})
