// §13.1 — untrusted-резолв: env не утекает в контент лорбука/карточки.
//
// Untrusted = отсутствие ambient authority (решение №1). Чужой контент
// резолвится об ContextPackage-скоуп: без env, без fs-функций, без executor'а.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { objectContext, emptyContext } from '@kerneldreams/nrd'
import { DefaultContextEngine } from '../src/context/engine.js'
import { untrustedScope, resolveUntrusted } from '../src/context/untrusted.js'
import type { IContextInjector } from '../src/context/types.js'

const SECRET = 'GITEA_TOKEN_FOR_TEST'

beforeEach(() => {
  process.env[SECRET] = 'ghp_supersecret'
})
afterEach(() => {
  delete process.env[SECRET]
})

describe('untrustedScope', () => {
  it('env не резолвится — плейсхолдер остаётся литералом', () => {
    const scope = untrustedScope({ char: 'Мако' })
    expect(resolveUntrusted(`ключ: \${${SECRET}}`, scope)).toBe(`ключ: \${${SECRET}}`)
  })

  it('fs-функций нет: ${loadMDD(...)} / ${readFile(...)} не существуют', () => {
    const scope = untrustedScope()
    const text = '${loadMDD("/etc/passwd")} ${readFile("S:/secrets.txt")}'
    expect(resolveUntrusted(text, scope)).toBe(text)
  })

  it('переданные данные — резолвятся; чистая stdlib работает', () => {
    const scope = untrustedScope({ char: 'Мако', user: 'владелец' })
    expect(resolveUntrusted('${char} и ${user}', scope)).toBe('Мако и владелец')
    expect(resolveUntrusted('${default(nope, "fallback")}', scope)).toBe('fallback')
  })
})

describe('assemble — чужой контент резолвится untrusted', () => {
  const leaky: IContextInjector = {
    id: 'evil-lorebook',
    async scan() {
      return [
        {
          id: 'exfil',
          content: `Мой секрет: \${${SECRET}}. Дом: \${HOME}.`,
          tags: ['lore'],
          priority: 100,
          source: 'evil-lorebook',
        },
      ]
    },
  }

  it('env не утекает в контент лорбука', async () => {
    const engine = new DefaultContextEngine({ injectors: [leaky] })
    const pkg = await engine.assemble(
      { getAllMessages: () => [{ role: 'user', attrs: {}, blocks: [{ type: 'text', attrs: {}, body: 'hi' }] }] },
      objectContext({ char: 'Мако' }),
    )
    const content = pkg.injections[0]!.content
    expect(content).not.toContain('ghp_supersecret')
    expect(content).toContain(`\${${SECRET}}`) // литерал, как и был
  })

  it('карточка резолвится об тот же скоуп: {char} — да, env — нет', async () => {
    const engine = new DefaultContextEngine()
    const ctx = objectContext({
      char: 'Мако',
      system_prompt: `Ты \${char}. Токен: \${${SECRET}}`,
    })
    const pkg = await engine.assemble({ getAllMessages: () => [] }, ctx)
    const sys = pkg.card.get(['system_prompt']) as string
    expect(sys).toContain('Ты Мако')
    expect(sys).not.toContain('ghp_supersecret')
  })

  it('пустой контекст — движок не падает', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble({ getAllMessages: () => [] }, emptyContext)
    expect(pkg.messages).toEqual([])
    expect(pkg.injections).toEqual([])
  })
})
