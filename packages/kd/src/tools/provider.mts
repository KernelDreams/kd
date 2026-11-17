/**
 * `kd provider` — провайдеры моделей (kd-cli-spec §7): список, добавить, снять. Из коробки —
 * anthropic, openai, openrouter, nano-gpt; любой OpenAI-совместимый — `--url`. Ключ — в связку
 * системы или `secrets.mdz` (600), провайдер ссылается на него `${env.ИМЯ}`. Гейт студии — только
 * в студийном профиле (`$layers`), здесь его нет.
 */

import { loadLayers } from '../node/layers.js'
import { PRESETS, providersFile, readProviders, removeProvider, writeProvider } from '../node/providers.js'
import { getSecret, setSecret } from '../node/secrets.js'

export const tool = {
  description: 'провайдеры моделей: список, добавить, снять',
  fields: {
    name: `string? $pos=1 $for=add,remove // Провайдер: ${Object.keys(PRESETS).join(', ')} или своё имя`,
    key: 'string? $for=add // Ключ (уходит в связку ключей или secrets.mdz)',
    url: 'string? $kind=url $for=add // Адрес OpenAI-совместимого провайдера',
    type: 'select openai, anthropic $for=add // Протокол своего провайдера',
    model: 'string? $kind=model $for=add // Модель по умолчанию',
    default: 'checkbox $for=add // Сделать провайдером по умолчанию',
  },
  defaults: { type: 'openai' },
  actions: { list: { title: 'провайдеры и есть ли ключ', default: true }, add: { title: 'добавить или обновить' }, remove: { title: 'снять' } },
  examples: ['kd provider add anthropic --key=sk-…', 'kd provider add local --url=http://127.0.0.1:8080/v1 --type=openai', 'kd provider'],
}

type Ctx = { get(p: string[]): unknown }
const str = (ctx: Ctx, k: string): string => {
  const v = ctx.get([k])
  return v === undefined || v === null ? '' : String(v)
}

export default function provider(ctx: Ctx): { output: string; exitCode?: number } {
  const l = loadLayers(process.cwd())
  const file = providersFile(l)
  const action = str(ctx, 'action') || 'list'
  if (action === 'list') {
    const cur = readProviders(file)
    if (!cur.list.length) return { output: `провайдеров kd нет (${file}); добавить: kd provider add ${Object.keys(PRESETS).join('|')} --key=…` }
    return {
      output: cur.list
        .map((p) => `${p.name === cur.default ? '*' : ' '} ${p.name.padEnd(12)} ${p.type.padEnd(9)} ${p.baseUrl}  ключ ${p.key ? (getSecret(l.copy.dataDir, p.key) ? `${p.key} есть` : `${p.key} НЕТ`) : '—'}`)
        .join('\n'),
    }
  }
  const name = str(ctx, 'name')
  if (!name) return { output: 'kd provider: нужно имя провайдера\nkd provider add anthropic --key=<ключ>', exitCode: 2 }
  if (action === 'remove') {
    const ok = removeProvider(file, name)
    return ok ? { output: `снят: ${name}` } : { output: `kd provider: «${name}» нет`, exitCode: 2 }
  }
  const preset = PRESETS[name]
  const url = str(ctx, 'url')
  if (!preset && !url) return { output: `kd provider: «${name}» не из коробки — нужен --url (OpenAI-совместимый адрес)\nkd provider add ${name} --url=<адрес> --key=<ключ>`, exitCode: 2 }
  const keyName = preset?.key ?? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const key = str(ctx, 'key')
  let where = ''
  if (key) where = setSecret(l.copy.dataDir, keyName, key) === 'keychain' ? 'связка ключей' : 'secrets.mdz'
  const model = str(ctx, 'model')
  writeProvider(file, { name, type: preset?.type ?? (str(ctx, 'type') || 'openai'), baseUrl: url || preset!.baseUrl, key: keyName }, { makeDefault: ctx.get(['default']) === true, ...(model ? { model } : {}) })
  return { output: `провайдер ${name} → ${file}${key ? `; ключ ${keyName} → ${where}` : ''}` }
}
