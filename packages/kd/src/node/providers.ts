/**
 * Провайдеры моделей (kd-cli-spec §7): тот же слой, что у runz (`## $provider <имя>` конфига,
 * `helpers.llm`), второго пути нет. Свои провайдеры `kd` — файл общего слоя `providers.mdz`
 * (формат конфига runz), он подаётся прогону явным конфигом; ключ — в связке / `secrets.mdz`,
 * провайдер ссылается на него `${env.ИМЯ}`. На установке ничего не спрашивается.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Layers } from './layers.js'
import { getSecret, loadSecretsIntoEnv } from './secrets.js'

export interface ProviderPreset {
  type: 'openai'
  baseUrl: string
  key: string
}

/** Из коробки (§7): Anthropic, OpenAI, OpenRouter, nano-gpt; любой OpenAI-совместимый — `--url`. */
export const PRESETS: Record<string, ProviderPreset> = {
  // Совместимый с OpenAI вход Anthropic: один протокол и для helpers.llm, и для агента backend-nr.
  anthropic: { type: 'openai', baseUrl: 'https://api.anthropic.com/v1', key: 'ANTHROPIC_API_KEY' },
  openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  'nano-gpt': { type: 'openai', baseUrl: 'https://nano-gpt.com/api/v1', key: 'NANOGPT_API_KEY' },
}

export const providersFile = (l: Layers): string => join(l.copy.dataDir, 'providers.mdz')

export interface ProviderEntry {
  name: string
  type: string
  baseUrl: string
  key: string
}

/** Провайдеры файла `kd` (без значений ключей). */
export function readProviders(file: string): { default?: string; list: ProviderEntry[] } {
  if (!existsSync(file)) return { list: [] }
  const text = readFileSync(file, 'utf8')
  const list: ProviderEntry[] = []
  const def = /^\$default_provider:\s*(\S+)/m.exec(text)?.[1]
  for (const block of text.split(/^## \$provider /m).slice(1)) {
    const name = block.split('\n')[0]!.trim()
    const get = (k: string): string => new RegExp(`^\\$${k}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim() ?? ''
    list.push({ name, type: get('type'), baseUrl: get('base_url'), key: /\$\{env\.([A-Z0-9_]+)\}/.exec(get('api_key'))?.[1] ?? '' })
  }
  return { ...(def ? { default: def } : {}), list }
}

function render(p: { default?: string; list: ProviderEntry[] }, model?: string): string {
  const lines = ['# Провайдеры kd (kd-cli-spec §7): формат конфига runz; ключи — в связке или secrets.mdz', '$format: 1']
  if (p.default) lines.push(`$default_provider: ${p.default}`)
  if (model) lines.push(`$model: ${model}`)
  for (const e of p.list) lines.push('', `## $provider ${e.name}`, `$type: ${e.type}`, `$base_url: ${e.baseUrl}`, `$api_key: \${env.${e.key}}`)
  return lines.join('\n') + '\n'
}

export function writeProvider(file: string, e: ProviderEntry, opts: { makeDefault?: boolean; model?: string } = {}): void {
  const cur = readProviders(file)
  const prevModel = existsSync(file) ? /^\$model:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim() : undefined
  const list = [...cur.list.filter((x) => x.name !== e.name), e]
  const def = opts.makeDefault || !cur.default ? e.name : cur.default
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, render({ default: def, list }, opts.model ?? prevModel))
  renameSync(tmp, file)
}

export function removeProvider(file: string, name: string): boolean {
  const cur = readProviders(file)
  if (!cur.list.some((x) => x.name === name)) return false
  const list = cur.list.filter((x) => x.name !== name)
  const prevModel = /^\$model:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim()
  writeFileSync(file, render({ ...(cur.default && cur.default !== name ? { default: cur.default } : list[0] ? { default: list[0].name } : {}), list }, prevModel))
  return true
}

/** Есть ли настроенный провайдер: файл `kd` с ключом, студийный конфиг с провайдерами, ключ в окружении. */
export function hasModelProvider(l: Layers, env: NodeJS.ProcessEnv = process.env): boolean {
  // Свои провайдеры сборки, затем общий слой (нижний слой каскада, §10).
  const files = [providersFile(l), ...(l.copy.readsShared ? [join(l.copy.sharedHome, 'providers.mdz')] : [])]
  for (const f of files) {
    const own = readProviders(f)
    if (own.list.some((p) => !p.key || getSecret(l.copy.dataDir, p.key, env) || (l.copy.readsShared && getSecret(l.copy.sharedHome, p.key, env)))) return true
  }
  for (const f of l.layers.flatMap((x) => x.configFiles)) {
    try {
      if (/^(## \$provider |\$default_provider:)/m.test(readFileSync(f, 'utf8'))) return true
    } catch {
      // нет файла
    }
  }
  return Object.values(PRESETS).some((p) => !!env[p.key])
}

/** Ключи провайдеров `kd` — в окружение прогона. */
export function prepareProviderEnv(l: Layers, env: NodeJS.ProcessEnv = process.env): void {
  const own = [...readProviders(providersFile(l)).list, ...(l.copy.readsShared ? readProviders(join(l.copy.sharedHome, 'providers.mdz')).list : [])]
  const keys = [...new Set([...own.map((p) => p.key).filter(Boolean), ...Object.values(PRESETS).map((p) => p.key)])]
  loadSecretsIntoEnv(l.copy.dataDir, keys, env)
  if (l.copy.readsShared && l.copy.sharedHome !== l.copy.dataDir) loadSecretsIntoEnv(l.copy.sharedHome, keys, env)
}
