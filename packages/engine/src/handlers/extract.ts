// ExtractHandler — parse a JSON object out of the response. For auto-tests,
// structured extraction. Spec §3.4.

import type { IHandler, EngineResponse, HandlerTarget, EngineConfig, HandlerResult } from '../types.js'
import { textFromBlocks } from '../parts.js'

/** Pull the first balanced JSON object/array out of free-form text. */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/)
  if (start === -1) return undefined
  const open = text[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

export class ExtractHandler implements IHandler {
  async handle(
    response: EngineResponse,
    _target: HandlerTarget,
    _config: EngineConfig,
  ): Promise<HandlerResult> {
    const text = textFromBlocks(response.content)
    const data = extractJson(text)
    return { output: text, artifacts: { data, usage: response.usage } }
  }
}
