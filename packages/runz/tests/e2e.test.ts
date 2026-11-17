import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { execute, parseDocFile } from '@kerneldreams/runz-runtime'
import type { ScriptResult } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')
const PROJECT = path.join(FIX, 'project')
const REPO = path.join(HERE, '..')
const BIN = path.join(REPO, 'bin', 'runz.ts')

function asScript(r: { result: unknown }): ScriptResult {
  return r.result as ScriptResult
}

describe('e2e — runtime API', () => {
  it('runz hello.ts --name=World', async () => {
    const r = await execute({
      script: path.join(FIX, 'hello.ts'),
      args: { name: 'World' },
      cwd: FIX,
    })
    expect(asScript(r).output).toBe('Hello, World!')
  })

  it('runz greet.md --name=NRD — template handler resolves body', async () => {
    const r = await execute({
      script: path.join(FIX, 'greet.md'),
      args: { name: 'NRD' },
      cwd: FIX,
    })
    expect(asScript(r).output).toBe('Hi, NRD!')
  })

  it('runz --type=template — virtual document', async () => {
    const r = await execute({
      script: null,
      args: { type: 'template', body: 'value=${greeting}', greeting: 'hi' },
      cwd: FIX,
    })
    expect(asScript(r).output).toBe('value=hi')
  })

  it('chat.md --runz-dry — resolves chain without executing', async () => {
    const r = await execute({
      script: path.join(FIX, 'chat.md'),
      args: { prompt: 'что такое рекурсия?' },
      dry: true,
      cwd: FIX,
    })
    const dump = JSON.parse(asScript(r).output!)
    expect(dump.handler).toBe('chat')
    expect(dump.chain.prompt).toBe('что такое рекурсия?')
    expect(dump.chain.model).toBe('testprovider/test-model')
  })

  it('chain priority — CLI overrides project config', async () => {
    const fromConfig = await execute({
      script: path.join(PROJECT, '.runz', 'scripts', 'hello.ts'),
      args: {},
      cwd: PROJECT,
    })
    expect(asScript(fromConfig).output).toBe('Hello, FromProjectConfig!')

    const fromCli = await execute({
      script: path.join(PROJECT, '.runz', 'scripts', 'hello.ts'),
      args: { name: 'FromCLI' },
      cwd: PROJECT,
    })
    expect(asScript(fromCli).output).toBe('Hello, FromCLI!')
  })

  it('project registry — bare name resolves .runz/scripts/', async () => {
    const r = await execute({ script: 'hello', args: {}, cwd: PROJECT })
    expect(asScript(r).output).toBe('Hello, FromProjectConfig!')
  })

  it('config inheritance — project config feeds the chain', async () => {
    const r = await execute({
      script: path.join(FIX, 'greet.md'),
      args: { name: 'X' },
      cwd: PROJECT,
    })
    // greeting from doc ($greeting: Hi) wins over project config (ProjectGreeting)
    expect(asScript(r).output).toBe('Hi, X!')
  })
})

describe('e2e — $nr-extends (загрузчик инъектируется в parseDocFile)', () => {
  const EXT = path.join(FIX, 'extends')

  it('parseDocFile: штатный лукап видит базу (own > база)', () => {
    const doc = parseDocFile(path.join(EXT, 'presets.md'))
    expect(doc.get(['preset', 'fast', 'model'])).toBe('gemma-4-12b') // из базы
    expect(doc.get(['preset', 'fast', 'temp'])).toBe(0.7) // из базы
    expect(doc.get(['preset', 'fast', 'think'])).toBe(false) // own бьёт базу
  })

  it('${preset.x.key} в теле документа резолвит базу', async () => {
    const r = await execute({ script: path.join(EXT, 'presets.md'), args: {}, cwd: EXT })
    expect(asScript(r).output).toBe('Модель: gemma-4-12b, think: false')
  })
})

describe('e2e — CLI subprocess', () => {
  it('node bin/runz.ts greet.md --name=Sub', () => {
    const res = spawnSync('node', [BIN, 'greet.md', '--name=Sub'], {
      cwd: FIX,
      encoding: 'utf8',
    })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('Hi, Sub!')
  })

  it('node bin/runz.ts --runz-list lists built-in scripts', () => {
    const res = spawnSync('node', [BIN, '--runz-list'], {
      cwd: FIX,
      encoding: 'utf8',
    })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('template')
    expect(res.stdout).toContain('serve')
  })

  it('node bin/runz.ts --runz-help prints usage', () => {
    const res = spawnSync('node', [BIN, '--runz-help'], {
      cwd: FIX,
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Reserved flags')
  })
})
