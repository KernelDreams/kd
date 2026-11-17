import { describe, it, expect } from 'vitest'
import { objectContext } from '@kerneldreams/nrd'
import { DirectAssembler } from '../src/assembly/direct.js'
import { msg } from './helpers.js'

describe('DirectAssembler', () => {
  const ctx = objectContext({ user: 'Bob', char: 'Alice' })

  it('orders system → history → post (post from card)', async () => {
    const a = new DirectAssembler()
    const out = await a.render(
      [msg('system', 'You are helpful.'), msg('user', 'hi'), msg('assistant', 'hello')],
      objectContext({ user: 'Bob', char: 'Alice', post_history_instructions: 'Stay in character.' }),
    )
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'system'])
    expect(out[0]!.content).toBe('You are helpful.')
    expect(out[3]!.content).toBe('Stay in character.')
  })

  it('resolves {{user}} / {{char}} macros from context', async () => {
    const a = new DirectAssembler()
    const out = await a.render([msg('user', 'I am {{user}} talking to {{char}}')], ctx)
    expect(out[0]!.content).toBe('I am Bob talking to Alice')
  })

  it('drops $hidden messages', async () => {
    const a = new DirectAssembler()
    const out = await a.render(
      [msg('user', 'shown'), msg('user', 'hidden', { flags: { hidden: true } })],
      ctx,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('shown')
  })

  it('frozen system wins over non-frozen', async () => {
    const a = new DirectAssembler()
    const out = await a.render(
      [msg('system', 'frozen one', { flags: { frozen: true } }), msg('system', 'plain one')],
      ctx,
    )
    expect(out[0]!.content).toBe('frozen one')
  })

  it('maps tool_result role to user', async () => {
    const a = new DirectAssembler()
    const out = await a.render([msg('tool_result', 'result data')], ctx)
    expect(out[0]!.role).toBe('user')
  })

  it('renders only text-parts (thinking/tool dropped)', async () => {
    const a = new DirectAssembler()
    const out = await a.render(
      [
        msg('assistant', [
          { type: 'thinking', text: 'REASONING' },
          { type: 'text', text: 'the answer' },
        ]),
      ],
      ctx,
    )
    expect(out[0]!.content).toBe('the answer')
  })
})
