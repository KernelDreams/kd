// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * Built-in script: chat
 *
 * Splits the document body into `%role` messages, calls the LLM, and appends
 * the assistant response to the source file (append-mode conversation).
 */

import { asText, resolve } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'
import type { Message, Role } from '@kerneldreams/runz-runtime/llm'
import { buildLLMClient } from './_llm.ts'

function collectMessages(meta: ScriptMeta, ctx: IContext): Message[] {
  const messages: Message[] = []
  if (meta.doc) {
    const msgs = meta.doc.cast('messages') as import('@kerneldreams/nrd').IArray | undefined
    if (msgs) {
      for (const m of msgs.iterate()) {
        const mc = m as IContext
        const role = asText(mc.get(['role']))
        // nrd-core 4.0.0: элемент `messages` — ChatMessage из nr-chat, тело в `body`
        const content = asText(mc.get(['body']))
        if ((role === 'user' || role === 'assistant') && content) {
          messages.push({ role: role as Role, content: resolve(content, ctx) })
        }
      }
    }
  }
  if (messages.length === 0) {
    const prompt = asText(ctx.get(['prompt']))
    if (prompt) messages.push({ role: 'user', content: prompt })
  }
  return messages
}

export default async function chat(
  ctx: IContext,
  meta: ScriptMeta,
): Promise<ScriptResult> {
  const model = asText(ctx.get(['model']))
  if (!model) {
    return { output: 'chat: no $model in chain', exitCode: 1 }
  }

  const messages = collectMessages(meta, ctx)
  if (messages.length === 0) {
    return { output: 'chat: no messages — provide --prompt or %role blocks', exitCode: 1 }
  }

  const client = buildLLMClient(meta)
  const response = await client.complete({
    model,
    messages,
    system: asText(ctx.get(['system'])),
    temperature: numeric(ctx.get(['temperature'])),
    maxTokens: numeric(ctx.get(['max_tokens'])),
  })

  const append = meta.file ? `\n\n%assistant\n${response.content}\n` : undefined
  return { output: response.content, append }
}

function numeric(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
