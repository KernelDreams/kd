// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — provider configuration from NRD documents
 *
 * Providers are declared as `## $provider <name>` blocks in a config.md:
 *
 *   ## $provider openrouter
 *   $type: openrouter
 *   $api_key: ${OPENROUTER_API_KEY}
 */

import { parseDocument, asText, isContext } from '@kerneldreams/nrd'
import type { IArray, NRDocument } from '@kerneldreams/nrd'
import type { ProviderConfig, LLMConfig } from './types.ts'

function substituteEnv(value: string | undefined, env: Record<string, string>): string | undefined {
  if (!value) return value
  return value.replace(/\$\{(\w+)\}/g, (_m, name: string) => env[name] ?? '')
}

/** Extract `## $provider` blocks from a parsed document. */
export function providersFromDoc(
  doc: NRDocument,
  env: Record<string, string> = {},
): ProviderConfig[] {
  const out: ProviderConfig[] = []
  const records = doc.cast('records') as IArray | undefined
  if (!records) return out
  for (const rec of records.iterate()) {
    if (!isContext(rec)) continue
    // TODO(providers task /): nrd-core 1.0 пока не отдаёт структурный
    // `tag`/`name` блока через cast (см. blockCast в nrd-core document.ts),
    // поэтому эти касты возвращают undefined и провайдеры не находятся.
    // Миграция конфига провайдеров — в отдельной задаче (провайдеры).
    if (rec.cast<string>('tag') !== 'provider') continue
    const name = rec.cast<string>('name')
    if (!name) continue
    out.push({
      name,
      type: asText(rec.get(['type'])) ?? 'openai',
      apiKey: substituteEnv(asText(rec.get(['api_key'])), env),
      baseUrl: substituteEnv(asText(rec.get(['base_url'])), env),
    })
  }
  return out
}

/** Parse provider configs from raw config.md text. */
export function providersFromText(
  text: string,
  env: Record<string, string> = {},
): ProviderConfig[] {
  return providersFromDoc(parseDocument(text), env)
}

/**
 * Build an LLMConfig from one or more config.md texts. Providers from later
 * texts override earlier ones by name. `$default_provider` (top-level attr)
 * selects the default; otherwise the first provider wins.
 */
export function loadLLMConfig(
  texts: string[],
  env: Record<string, string> = {},
): LLMConfig {
  const providers: Record<string, ProviderConfig> = {}
  let defaultProvider: string | undefined
  for (const text of texts) {
    const doc = parseDocument(text)
    const dp = asText(doc.get(['default_provider']))
    if (dp) defaultProvider = dp
    for (const p of providersFromDoc(doc, env)) {
      providers[p.name] = p
    }
  }
  if (!defaultProvider) {
    defaultProvider = Object.keys(providers)[0]
  }
  return { providers, defaultProvider }
}
