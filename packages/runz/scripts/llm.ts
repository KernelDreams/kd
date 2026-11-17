// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * Built-in script: llm
 *
 * Single-shot LLM call. Prompt from `--prompt` or the document body, system
 * from `$system`, model from `$model`.
 */

import { asText, resolve } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'
import { buildLLMClient } from './_llm.ts'

export default async function llm(
  ctx: IContext,
  meta: ScriptMeta,
): Promise<ScriptResult> {
  const model = asText(ctx.get(['model']))
  if (!model) {
    return { output: 'llm: no $model in chain', exitCode: 1 }
  }

  let prompt = asText(ctx.get(['prompt']))
  if (!prompt && meta.doc) {
    const body = (meta.doc.cast('text') as string | undefined) ?? ''
    prompt = resolve(body, ctx)
  }
  if (!prompt) {
    return { output: 'llm: no prompt — provide --prompt or document body', exitCode: 1 }
  }

  const client = buildLLMClient(meta)
  const response = await client.complete({
    model,
    system: asText(ctx.get(['system'])),
    messages: [{ role: 'user', content: prompt }],
  })

  return { output: response.content }
}
