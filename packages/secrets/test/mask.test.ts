import { describe, expect, it } from 'vitest'
import { createMask, maskDeep, maskSecrets, secretValues } from '../src/index'

// Ключи собираются из кусков: в файле нет готовой строки ключа (autocommit, сканеры).
const hex = (n: number) => '0123456789abcdef'.repeat(8).slice(0, n)
const alnum = (n: number) => 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(4).slice(0, n)
const keys = {
  anthropic: 'sk-' + 'ant-api03-' + alnum(40),
  openrouter: 'sk-' + 'or-v1-' + hex(64),
  openai: 'sk-' + 'proj-' + alnum(40),
  zai: hex(32) + '.' + alnum(16),
  google: 'AI' + 'za' + alnum(35),
  github: 'gh' + 'p_' + alnum(36),
  npm: 'np' + 'm_' + alnum(36),
  projektor: 'p' + 'k_' + hex(40),
  feedback: 'fb' + 'k_' + hex(64),
  telegram: '7123456789:' + 'AA' + alnum(33),
  jwt: 'ey' + 'J' + alnum(20) + '.ey' + 'J' + alnum(30) + '.' + alnum(30),
  node: hex(64),
}

describe('maskSecrets — формы ключей', () => {
  for (const [name, key] of Object.entries(keys)) {
    it(name, () => {
      const out = maskSecrets(`error: failed with ${key} at call`)
      expect(out).not.toContain(key)
      expect(out).toContain('[secret]')
      expect(out).toContain('error: failed with')
      expect(out).toContain('at call')
    })
  }
})

describe('maskSecrets — контекст', () => {
  const gate = 'gate' + alnum(20)
  it('Authorization: Bearer', () => {
    const out = maskSecrets(`-H "Authorization: Bearer ${gate}"`)
    expect(out).not.toContain(gate)
  })
  it('Bearer в тексте', () => expect(maskSecrets(`token Bearer ${gate} ok`)).not.toContain(gate))
  it('?key= и &token= в адресе', () => {
    const out = maskSecrets(`GET https://x.test/v1?key=${gate}&model=a&token=${gate}2`)
    expect(out).not.toContain(gate)
    expect(out).toContain('model=a')
  })
  it('JSON-поле', () => expect(maskSecrets(`{"apiKey": "${gate}", "model": "glm"}`)).not.toContain(gate))
  it('$key: в mdz', () => expect(maskSecrets(`$api_key: ${gate}\n$url: http://a`)).toBe(`$api_key: gate…[secret]\n$url: http://a`))
  it('X-Api-Key заголовком', () => expect(maskSecrets(`x-api-key: ${gate}`)).not.toContain(gate))
  it('обычный текст не трогается', () => {
    const s = 'Сессия 3f2a1c4e-1111-2222-3333-444455556666, коммит 39aff70, модель glm-5.3-flash, 1313/1313'
    expect(maskSecrets(s)).toBe(s)
  })
})

describe('createMask — известные значения', () => {
  it('точное совпадение любой формы', () => {
    const odd = 'weird:Secret/Value+1'
    const mask = createMask({ values: [odd, 'short'] })
    expect(mask(`got ${odd} here, short stays`)).toBe('got weir…[secret] here, short stays')
  })
  it('secretValues из конфига', () => {
    const cfg = `## $speak\n$url: https://speak\n$key: ${'g' + alnum(20)}\n$token: $other\nTOKEN=${'t' + alnum(15)}\n$enabled: true`
    expect(secretValues(cfg)).toEqual(['g' + alnum(20), 't' + alnum(15)])
  })
})

describe('maskDeep', () => {
  it('строки внутри и поля-секреты', () => {
    const v = maskDeep({ msg: `boom ${keys.zai}`, headers: { authorization: 'abcdefgh' }, n: 3, list: [keys.anthropic] })
    expect(JSON.stringify(v)).not.toContain(keys.zai)
    expect(JSON.stringify(v)).not.toContain(keys.anthropic)
    expect(v.headers.authorization).toBe('[secret]')
    expect(v.n).toBe(3)
  })
})
