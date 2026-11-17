/**
 * Пример с вызовом тула в шаблоне агента: `%%tool_use` под `%assistant` и `%%tool_result` под `%tool` уходят модели
 * частями, как в истории, — модель видит настоящий вызов, а не текст про него (локальные модели повторяли текст).
 */

import { describe, expect, it } from 'vitest'
import { buildMdsTemplate, type BuildInput } from '../src/builder/index.js'

const TPL = `%system
Ты мастер плагинов.
%user
Сделай Ч/Б.
%assistant
Делаю.
%%tool_use {callId: 'ex1', name: 'pix_plugin_write'}
{name: 'grayscale', text: '$title: Ч/Б'}
%tool
%%tool_result {callId: 'ex1', name: 'pix_plugin_write'}
записан grayscale.mdz
%assistant
%%tool_use {callId: 'ex2', name: 'pix_plugins_reload'}
{}
%tool
%%tool_result {callId: 'ex2', name: 'pix_plugins_reload'}
ok
%assistant
Готово: «Ч/Б».
%user
<{ history }><{ endhistory }>
`

const input = (): BuildInput => ({
  session: { id: 's' },
  document: { path: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], meta: {}, personas: [] },
  agent: { id: 'a', name: 'A', template: TPL, includes: {} },
  model: { id: 'm' },
  base: [],
  tools: [],
})

describe('пример с вызовом тула в шаблоне', () => {
  it('assistant — текст и tool_use; tool — tool_result; вызов без текста — узлом из одного вызова', async () => {
    const out = await buildMdsTemplate(input())
    const nodes = out.nodes.filter((n) => !n.history)
    const kinds = nodes.map((n) => `${n.role}:${n.parts.map((p) => p.type).join('+')}`)
    expect(kinds).toEqual(['system:text', 'user:text', 'assistant:text+tool_use', 'tool:tool_result', 'assistant:tool_use', 'tool:tool_result', 'assistant:text'])
    const use = nodes[2]!.parts[1] as { type: string; data: unknown; meta: { callId: string; name: string } }
    expect(use.meta).toMatchObject({ callId: 'ex1', name: 'pix_plugin_write' })
    expect(use.data).toEqual({ name: 'grayscale', text: '$title: Ч/Б' })
    expect((nodes[3]!.parts[0] as { text?: string }).text).toBe('записан grayscale.mdz')
    // История — после примеров, как была.
    expect(out.nodes.at(-1)?.history).toBe(true)
  })
})
