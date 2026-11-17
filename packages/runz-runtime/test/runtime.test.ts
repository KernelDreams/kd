import { describe, it, expect } from 'vitest'
import { parseArgv, coerceValue } from '../src/cli.ts'
import { isDirectPath } from '../src/registry.ts'
import { buildChain, buildScopes, flattenChain } from '../src/chain.ts'
import { parseDocument, resolve } from '@kerneldreams/nrd'

describe('cli — parseArgv', () => {
  it('splits --runz-* flags from data args', () => {
    const p = parseArgv(['hello.ts', '--name=World', '--runz-debug', '--runz-config=cfg.md'])
    expect(p.script).toBe('hello.ts')
    expect(p.args.name).toBe('World')
    expect(p.runz.debug).toBe(true)
    expect(p.runz.config).toBe('cfg.md')
  })

  it('coerces value types', () => {
    expect(coerceValue('5')).toBe(5)
    expect(coerceValue('3.14')).toBe(3.14)
    expect(coerceValue('true')).toBe(true)
    expect(coerceValue('hello')).toBe('hello')
  })

  it('bare --flag becomes true', () => {
    const p = parseArgv(['s', '--verbose'])
    expect(p.args.verbose).toBe(true)
  })

  it('supports dotted keys as nested objects', () => {
    const p = parseArgv(['s', '--user.email=x@y.z'])
    expect(p.args.user).toEqual({ email: 'x@y.z' })
  })

  it('parses --runz-dry, --runz-list, --runz-help, --runz-runtime', () => {
    const p = parseArgv(['--runz-dry', '--runz-list', '--runz-help', '--runz-runtime=electron'])
    expect(p.runz.dry).toBe(true)
    expect(p.runz.list).toBe(true)
    expect(p.runz.help).toBe(true)
    expect(p.runz.runtime).toBe('electron')
  })

  it('parses --runz-json as a reserved flag (not a data arg)', () => {
    const p = parseArgv(['s', '--runz-json', '--name=x'])
    expect(p.runz.json).toBe(true)
    expect(p.args).toEqual({ name: 'x' })
    expect(parseArgv(['s']).runz.json).toBe(false)
  })

  it('parses --untrusted as a reserved flag (not a data arg)', () => {
    const p = parseArgv(['script', '--untrusted', '--name=x'])
    expect(p.runz.untrusted).toBe(true)
    expect(p.args.untrusted).toBeUndefined()
    expect(p.args.name).toBe('x')
  })
})

describe('registry — isDirectPath', () => {
  it('detects explicit paths', () => {
    expect(isDirectPath('./x.ts')).toBe(true)
    expect(isDirectPath('script.md')).toBe(true)
    expect(isDirectPath('a/b/c')).toBe(true)
    expect(isDirectPath('chat')).toBe(false)
  })
})

describe('chain composition', () => {
  it('CLI overrides document overrides config', () => {
    const doc = parseDocument('$model: doc-model\n$system: from-doc')
    const projectConfig = parseDocument('$model: config-model\n$temp: 0.5')
    const ctx = buildChain({
      cliArgs: { model: 'cli-model' },
      doc,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig,
      globalConfig: null,
    })
    expect(ctx.get(['model'])).toBe('cli-model')
    expect(ctx.get(['system'])).toBe('from-doc')
    // nrd-core 1.0 coerces scalar attribute values, so 0.5 is a number now.
    expect(ctx.get(['temp'])).toBe(0.5)
  })

  it('config inheritance — global < project', () => {
    const globalConfig = parseDocument('$model: global-model\n$lang: en')
    const projectConfig = parseDocument('$model: project-model')
    const ctx = buildChain({
      cliArgs: {},
      doc: null,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig,
      globalConfig,
    })
    expect(ctx.get(['model'])).toBe('project-model')
    expect(ctx.get(['lang'])).toBe('en')
  })

  it('flattenChain merges layers low-to-high', () => {
    const doc = parseDocument('$a: doc-a\n$b: doc-b')
    const flat = flattenChain({
      cliArgs: { a: 'cli-a' },
      doc,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig: null,
      globalConfig: null,
    })
    expect(flat.a).toBe('cli-a')
    expect(flat.b).toBe('doc-b')
  })

  it('env layer resolves ${env.VAR} references', () => {
    const doc = parseDocument('$key: ${env.MY_SECRET}')
    const ctx = buildChain({
      cliArgs: {},
      doc,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig: null,
      globalConfig: null,
      env: { MY_SECRET: 'sk-123' },
    })
    expect(resolve('${key}', ctx)).toBe('sk-123')
  })

  // env — слабейшее звено, служебные ключи есть в нём всегда.
  it('env is NOT a source for bare keys', () => {
    const ctx = buildChain({
      cliArgs: {},
      doc: null,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig: null,
      globalConfig: null,
      env: { _: '/usr/local/bin/runz', MY_SECRET: 'sk-123', HOME: '/home/u' },
    })
    // Позиционала нет → честный undefined, а не путь бинаря из process.env._
    expect(ctx.get(['_'])).toBeUndefined()
    expect(ctx.get(['HOME'])).toBeUndefined()
    expect(resolve('${MY_SECRET}', ctx)).toBe('${MY_SECRET}')
    // Явный неймспейс работает.
    expect(ctx.get(['env', '_'])).toBe('/usr/local/bin/runz')
    expect(ctx.get(['env', 'MY_SECRET'])).toBe('sk-123')
  })

  it('positional `_` from CLI wins and is visible', () => {
    const ctx = buildChain({
      cliArgs: { _: ['file.mds'] },
      doc: null,
      explicitConfig: null,
      scriptConfig: null,
      projectConfig: null,
      globalConfig: null,
      env: { _: '/usr/local/bin/runz' },
    })
    const v = ctx.get(['_', 0])
    expect(v).toBe('file.mds')
  })
})

describe('scopes — buildScopes', () => {
  const layers = () => ({
    cliArgs: { model: 'cli-model' },
    doc: parseDocument('$system: from-doc'),
    explicitConfig: null,
    scriptConfig: null,
    projectConfig: parseDocument('$editor: vim\n\n## $provider\n$name: openrouter'),
    globalConfig: parseDocument('## $gitea\n$token: tok-xyz'),
    env: { HOME_SECRET: 'sk-env' },
  })

  it('builds three scopes', () => {
    const s = buildScopes(layers())
    expect(s.sys).toBeDefined()
    expect(s.settings).toBeDefined()
    expect(s.document).toBeDefined()
  })

  it('sys carries config + env; settings carries user config (no env)', () => {
    const s = buildScopes(layers())
    expect(s.sys.get(['gitea', 'token'])).toBe('tok-xyz')
    expect(s.sys.get(['env', 'HOME_SECRET'])).toBe('sk-env')
    expect(s.sys.get(['HOME_SECRET'])).toBeUndefined() // голым ключом — нет (ABC-18)
    expect(s.settings.get(['editor'])).toBe('vim')
    expect(s.settings.get(['env', 'HOME_SECRET'])).toBeUndefined() // env не в settings
  })

  it('mounts: document sees ${sys.*} / ${settings.*} by explicit path', () => {
    const s = buildScopes(layers())
    expect(resolve('${sys.gitea.token}', s.document)).toBe('tok-xyz')
    expect(resolve('${settings.editor}', s.document)).toBe('vim')
  })

  it('document: bare keys do NOT fall through mounts into sys', () => {
    // gitea живёт в sys; голый ${gitea.token} из document проваливается только
    // через переходный sys-хвост, но НЕ через маунт-неймспейс.
    const s = buildScopes(layers())
    // явный путь работает
    expect(resolve('${sys.gitea.token}', s.document)).toBe('tok-xyz')
  })

  it('transitional sys-tail keeps ctx.get([provider]) working (compat)', () => {
    const s = buildScopes(layers())
    // appz, читающие provider напрямую из ctx, ещё работают (этап 1).
    expect(s.document.get(['provider', 'name'])).toBe('openrouter')
    expect(s.document.get(['model'])).toBe('cli-model')
    expect(s.document.get(['system'])).toBe('from-doc')
  })

  it('untrusted: no sys-tail, no mounts, no env', () => {
    const s = buildScopes(layers(), { trusted: false })
    expect(s.document.get(['provider', 'name'])).toBeUndefined() // sys-хвост снят
    expect(resolve('${sys.gitea.token}', s.document)).toBe('${sys.gitea.token}') // маунтов нет
    // только doc + argv видны
    expect(s.document.get(['model'])).toBe('cli-model')
    expect(s.document.get(['system'])).toBe('from-doc')
  })

  it('untrusted: env-backed ${env.VAR} stays literal', () => {
    const s = buildScopes({
      cliArgs: {},
      doc: parseDocument('$key: ${env.MY_SECRET}'),
      explicitConfig: null,
      scriptConfig: null,
      projectConfig: null,
      globalConfig: null,
      env: { MY_SECRET: 'sk-123' },
    }, { trusted: false })
    expect(resolve('${key}', s.document)).toBe('${env.MY_SECRET}')
  })
})
