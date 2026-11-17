import { describe, it, expect } from 'vitest'
import { memoryStorage } from '../../src/web/index.js'
import { spawnExecutor } from '../../src/node/index.js'
import { buildContext } from '../../src/context/index.js'

function cfg(...lines: string[]): string {
  return lines.join('\n')
}

describe('exec source — делегирует execBlock', () => {
  it('$cmd → stdout (text)', async () => {
    const chain = await buildContext(cfg('## $source r', '$nr-type: exec', '$cmd: echo hello-exec'), {
      executor: spawnExecutor,
    })
    expect(String(chain.get(['r', 'content'])).trim()).toBe('hello-exec')
  })

  it('$cmd → json результат', async () => {
    const chain = await buildContext(
      cfg(
        '## $source r',
        '$nr-type: exec',
        '$nr-parse: json',
        '$cmd: node -e "console.log(JSON.stringify({n:5,ok:true}))"',
      ),
      { executor: spawnExecutor },
    )
    expect(chain.get(['r', 'n'])).toBe(5)
    expect(chain.get(['r', 'ok'])).toBe(true)
  })

  it('без executor → понятная ошибка', async () => {
    const c = cfg('## $source r', '$nr-type: exec', '$cmd: echo hi')
    await expect(buildContext(c)).rejects.toThrow(/executor/)
  })
})

describe('script source — $path .ts → execBlock → IContext', () => {
  it('node-скрипт печатает JSON → IContext', async () => {
    const storage = memoryStorage()
    await storage.write('fetch.ts', 'const data = { greeting: "hi", count: 42 }\nconsole.log(JSON.stringify(data))\n')
    const chain = await buildContext(
      cfg('## $source dyn', '$nr-type: script', '$engine: node', '$path: fetch.ts', '$nr-parse: json'),
      { storage, executor: spawnExecutor },
    )
    expect(chain.get(['dyn', 'greeting'])).toBe('hi')
    expect(chain.get(['dyn', 'count'])).toBe(42)
  })
})
