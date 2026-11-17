// resolveProviderConfig: chain → ProviderConfig.
// Эталон семантики — chat3.lookupProvider от 07.07.
import { describe, it, expect } from 'vitest'
import { objectContext, chainContext } from '@kerneldreams/nrd'
import { resolveProviderConfig } from '../src/providers.js'

describe('resolveProviderConfig', () => {
  it('блок провайдера: base_url / type / think / timeout / api_key', () => {
    const ctx = objectContext({
      provider: {
        'pc-2': {
          base_url: 'http://pc-2:8080/v1',
          type: 'openai',
          think: false,
          timeout: 300000,
          api_key: 'sk-block',
        },
      },
    })
    expect(resolveProviderConfig(ctx, 'pc-2')).toEqual({
      apiKey: 'sk-block',
      baseUrl: 'http://pc-2:8080/v1',
      type: 'openai',
      think: false,
      timeout: 300000,
    })
  })

  it('без блока: только плоский <name>_api_key, остальное undefined', () => {
    const ctx = objectContext({ openrouter_api_key: 'sk-flat' })
    expect(resolveProviderConfig(ctx, 'openrouter')).toEqual({
      apiKey: 'sk-flat',
      baseUrl: undefined,
      type: undefined,
      think: undefined,
      timeout: undefined,
    })
  })

  it('kebab-варианты ключей: <name>-api-key и base-url / api-key', () => {
    const ctx = objectContext({
      'anthropic-api-key': 'sk-kebab',
      provider: { anthropic: { 'base-url': 'https://api.anthropic.com' } },
    })
    const cfg = resolveProviderConfig(ctx, 'anthropic')
    expect(cfg.apiKey).toBe('sk-kebab')
    expect(cfg.baseUrl).toBe('https://api.anthropic.com')
  })

  it('api_key фолбэк на блок, когда плоского нет', () => {
    const ctx = objectContext({
      provider: { pc: { api_key: 'sk-from-block' } },
    })
    expect(resolveProviderConfig(ctx, 'pc').apiKey).toBe('sk-from-block')
  })

  it('плоский <name>_api_key приоритетнее блочного api_key', () => {
    const ctx = objectContext({
      pc_api_key: 'sk-flat',
      provider: { pc: { api_key: 'sk-block' } },
    })
    expect(resolveProviderConfig(ctx, 'pc').apiKey).toBe('sk-flat')
  })

  it('CLI-слой цепочки выигрывает над конфигом (chainContext, first-hit)', () => {
    const cli = objectContext({ pc_api_key: 'sk-cli' })
    const config = objectContext({
      pc_api_key: 'sk-config',
      provider: { pc: { base_url: 'http://config', type: 'openai' } },
    })
    const ctx = chainContext(cli, config)
    const cfg = resolveProviderConfig(ctx, 'pc')
    expect(cfg.apiKey).toBe('sk-cli')      // из CLI-слоя
    expect(cfg.baseUrl).toBe('http://config') // из конфиг-слоя
    expect(cfg.type).toBe('openai')
  })

  it('timeout/think приводятся к числу/булеву из строк', () => {
    const ctx = objectContext({
      provider: { pc: { timeout: '120000', think: 'true' } },
    })
    const cfg = resolveProviderConfig(ctx, 'pc')
    expect(cfg.timeout).toBe(120000)
    expect(cfg.think).toBe(true)
  })

  it('неизвестный провайдер: всё undefined', () => {
    const ctx = objectContext({ provider: { pc: { type: 'openai' } } })
    expect(resolveProviderConfig(ctx, 'nope')).toEqual({
      apiKey: undefined,
      baseUrl: undefined,
      type: undefined,
      think: undefined,
      timeout: undefined,
    })
  })
})
