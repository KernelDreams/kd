// RawHandler — return the response text, save nothing. For commit, translate,
// one-shot tasks. Spec §3.4.

import type { IHandler, EngineResponse, HandlerTarget, EngineConfig, HandlerResult } from '../types.js'
import { textFromBlocks } from '../parts.js'

export class RawHandler implements IHandler {
  async handle(
    response: EngineResponse,
    _target: HandlerTarget,
    _config: EngineConfig,
  ): Promise<HandlerResult> {
    return {
      output: textFromBlocks(response.content),
      artifacts: { usage: response.usage, stopReason: response.stopReason },
    }
  }
}
