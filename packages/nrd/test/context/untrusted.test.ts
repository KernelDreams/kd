import { describe, it, expect } from 'vitest'
import { buildContext } from '../../src/context/index.js'
import type { Logger } from '../../src/context/index.js'

// Конфиги собираем join('\n'), чтобы `${...}` не интерполировался тест-файлом.
function cfg(...lines: string[]): string {
  return lines.join('\n')
}

function capturingLog(): { log: Logger; warns: string[] } {
  const warns: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => warns.push(m),
    error: () => {},
  }
  return { log, warns }
}

describe('buildContext — trusted:false (§NTS-206.3)', () => {
  it('env НЕ утекает: ${VAR} остаётся литералом', async () => {
    process.env.NRD_UNTRUSTED_SECRET = 'sk-should-not-leak'
    const config = cfg('## $source s', '$nr-type: inline', '$nr-parse: mdz', '$v: ${NRD_UNTRUSTED_SECRET}')

    const trustedChain = await buildContext(config) // контроль: доверенный видит env
    expect(trustedChain.get(['s', 'v'])).toBe('sk-should-not-leak')

    const chain = await buildContext(config, { trusted: false })
    expect(chain.get(['s', 'v'])).toBe('${NRD_UNTRUSTED_SECRET}')

    delete process.env.NRD_UNTRUSTED_SECRET
  })

  it('builtinFunctions не подключены: ${readFile(...)} остаётся литералом', async () => {
    const config = cfg('## $source s', '$nr-type: inline', '$nr-parse: mdz', '$f: ${readFile("C:/secret")}')
    const chain = await buildContext(config, { trusted: false })
    expect(chain.get(['s', 'f'])).toBe('${readFile("C:/secret")}')
  })

  it('source exec/env пропускается с warn', async () => {
    const { log, warns } = capturingLog()
    const config = cfg(
      '## $source safe',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '$ok: 1',
      '',
      '## $source danger',
      '$nr-type: env',
      '$keys: PATH',
    )
    const chain = await buildContext(config, { trusted: false, log })
    expect(chain.get(['safe', 'ok'])).toBe(1)
    expect(chain.get(['danger'])).toBeUndefined() // блок пропущен
    expect(warns.some((w) => /danger/.test(w) && /trusted:false/.test(w))).toBe(true)
  })

  it('strictUntrusted: заблокированный source роняет сборку', async () => {
    const config = cfg('## $source danger', '$nr-type: exec', '$cmd: echo nope')
    await expect(
      buildContext(config, { trusted: false, strictUntrusted: true }),
    ).rejects.toThrow(/trusted:false/)
  })

  it('$required не подглядывает env при untrusted', async () => {
    process.env.NRD_REQ = 'present-in-env'
    const config = cfg('$required: NRD_REQ', '## $source s', '$nr-type: inline', '$nr-parse: mdz', '$a: 1')
    // доверенный — env удовлетворяет $required
    await expect(buildContext(config)).resolves.toBeDefined()
    // untrusted — env невидим → ошибка
    await expect(buildContext(config, { trusted: false })).rejects.toThrow(/NRD_REQ/)
    delete process.env.NRD_REQ
  })

  it('trusted:true (default) — поведение без изменений', async () => {
    const { log, warns } = capturingLog()
    const config = cfg('## $source e', '$nr-type: env', '$keys: NRD_TRUSTED_OK')
    process.env.NRD_TRUSTED_OK = 'yes'
    const chain = await buildContext(config, { log })
    expect(chain.get(['e', 'NRD_TRUSTED_OK'])).toBe('yes')
    expect(warns.length).toBe(0)
    delete process.env.NRD_TRUSTED_OK
  })
})
