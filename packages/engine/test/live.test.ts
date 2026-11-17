// Live smoke test through OpenRouter. Skipped unless an API key is present in
// the environment (OPENROUTER_API_KEY or LLM_API_KEY), so normal runs stay
// hermetic. Mirrors the chat2 live commit path: memory + raw + simple.

import { describe, it, expect } from 'vitest'
import { run } from '../src/run.js'
import { memSession } from './helpers.js'

const apiKey = process.env['OPENROUTER_API_KEY'] ?? process.env['LLM_API_KEY']
const model = process.env['LLM_MODEL'] ?? 'google/gemini-2.5-flash'

describe.skipIf(!apiKey)('live OpenRouter', () => {
  it('one-shot generation via run() (memory + raw + simple)', async () => {
    const { store, sid } = await memSession()
    const result = await run(
      {
        assembly: 'direct',
        orchestrator: 'simple',
        handler: 'raw',
        provider: 'openrouter',
        model,
        apiKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        maxTokens: 16,
      },
      {
        target: { store, sessionId: sid },
        systemPrompt: 'You are a calculator. Reply with the number only, nothing else.',
        userMessage: 'What is 21 + 21?',
      },
    )
    expect(result.output).toContain('42')
  }, 30_000)
})
