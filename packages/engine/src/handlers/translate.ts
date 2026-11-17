// TranslateHandler — return the text, optionally write it to a file. Spec §3.4.

import { writeFileSync } from 'node:fs'
import type { IHandler, EngineResponse, HandlerTarget, EngineConfig, HandlerResult } from '../types.js'
import { textFromBlocks } from '../parts.js'

export class TranslateHandler implements IHandler {
  async handle(
    response: EngineResponse,
    _target: HandlerTarget,
    config: EngineConfig,
  ): Promise<HandlerResult> {
    const output = textFromBlocks(response.content)
    const out = typeof config['out'] === 'string' ? (config['out'] as string) : undefined
    if (out) writeFileSync(out, output)
    return { output, artifacts: { out, usage: response.usage } }
  }
}
