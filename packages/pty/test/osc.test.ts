import { describe, expect, it } from 'vitest'
import { cook, Osc133Parser, tail } from '../src/osc.js'
import { isHumanInput } from '../src/terminal.js'

const E = '\x1b'
const BEL = '\x07'

describe('Osc133Parser', () => {
  it('метки и текст по порядку, код у D', () => {
    const p = new Osc133Parser()
    const ev = p.feed(`${E}]133;A${BEL}~ % ${E}]133;B${BEL}ls${E}]133;C${BEL}a\r\nb\r\n${E}]133;D;2${BEL}`)
    expect(ev).toEqual([
      { type: 'mark', kind: 'A' },
      { type: 'text', data: '~ % ' },
      { type: 'mark', kind: 'B' },
      { type: 'text', data: 'ls' },
      { type: 'mark', kind: 'C' },
      { type: 'text', data: 'a\r\nb\r\n' },
      { type: 'mark', kind: 'D', code: 2 },
    ])
  })

  it('метка, разрезанная между кусками, и ST вместо BEL', () => {
    const p = new Osc133Parser()
    const s = `x${E}]133;D;0${E}\\y`
    const out = []
    for (const ch of s) out.push(...p.feed(ch))
    expect(out.filter((e) => e.type === 'mark')).toEqual([{ type: 'mark', kind: 'D', code: 0 }])
    expect(out.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.data : '')).join('')).toBe('xy')
  })

  it('чужой OSC — текстом', () => {
    const ev = new Osc133Parser().feed(`${E}]0;title${BEL}z`)
    expect(ev).toEqual([{ type: 'text', data: `${E}]0;title${BEL}z` }])
  })
})

describe('cook', () => {
  it('срезает escape, \\r\\n, \\b и PROMPT_SP zsh', () => {
    const raw = `hi\r\n${E}[1m${E}[7m%${E}[27m${E}[1m${E}[0m          \r \r`
    expect(cook(raw)).toBe('hi')
    expect(cook(`e\becho x`)).toBe('echo x')
    expect(cook(`50%\r100%\r\ndone\n`)).toBe('100%\ndone')
    expect(cook(`abc${E}[2D${E}[K!`)).toBe('a!')
    expect(cook(`${E}]0;t${BEL}${E}[31mred${E}[0m`)).toBe('red')
  })

  it('tail — хвост строк и символов', () => {
    expect(tail('1\n2\n3', 2, 100)).toEqual({ text: '2\n3', cut: true })
    expect(tail('abcdef', 10, 3)).toEqual({ text: 'def', cut: true })
    expect(tail('ab', 10, 10)).toEqual({ text: 'ab', cut: false })
  })
})

describe('isHumanInput', () => {
  it('автоответы терминала — не ввод, нажатия — ввод', () => {
    for (const r of [`${E}[?1;2c`, `${E}[>0;276;0c`, `${E}[12;5R`, `${E}[0n`, `${E}[I`, `${E}[O`, `${E}]11;rgb:1111/1111/1111${BEL}`, `${E}[?1;2c${E}[>0;276;0c`, `${E}[<0;12;5M${E}[<0;12;5m`, `${E}[M #!`]) {
      expect(isHumanInput(r), JSON.stringify(r)).toBe(false)
    }
    for (const k of ['a', 'ls', '\r', `${E}[A`, '\x7f', '\x03', `${E}[?1;2cx`]) expect(isHumanInput(k), JSON.stringify(k)).toBe(true)
  })
})
