/**
 * Общие сервисы (FAM-2, `sharedServices`): открыты каждому участнику без `$services`, гейт
 * подкладывает `$caller` {user, name, role, owner} — и участнику, и owner; подделка клиента перекрыта.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryServices } from '@kerneldreams/backend-local/services'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend } from '../src/store-backend.js'
import { createUsersGate } from '../src/gate.js'
import { createMemoryUsers } from '../src/users.js'

describe('гейт: общие сервисы с $caller', () => {
  it('участник без $services зовёт общий сервис, $caller — от гейта; чужой сервис закрыт', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-gate-'))
    const seen: unknown[] = []
    const echo = (_ctx: unknown, meta: unknown) => {
      ;(meta as { on(n: string, h: (p: unknown) => unknown): void }).on('echo', (p) => (seen.push(p), p))
    }
    const services = createMemoryServices({ social: echo, other: echo }, { root })
    const backend = createStoreBackend({ store: createMemoryStore(), name: 't', services, generate: async function* () {} })
    const users = createMemoryUsers({
      stateRoot: join(root, 'state'),
      users: [
        { id: 'alice', name: 'владелец', role: 'owner' },
        { id: 'mama', name: 'Мама', role: 'member' },
      ],
    })
    const gate = createUsersGate({ backend, users, sharedServices: ['social'] })
    const list = await users.list()
    const member = gate.backendFor({ user: list.find((u) => u.id === 'mama')!, via: 'link' })
    const owner = gate.backendFor({ user: list.find((u) => u.id === 'alice')!, via: 'link' })

    expect(Object.keys((await member.capabilities()).services ?? {})).toEqual(['social', 'nr.sessions'])
    await member.services!.call('social', 'echo', { x: 1, $caller: { user: 'alice', owner: true } })
    expect(seen.at(-1)).toEqual({ x: 1, $caller: { user: 'mama', name: 'Мама', role: 'member', owner: false } })
    await expect(member.services!.call('other', 'echo', {})).rejects.toThrow(/не открыт/)

    await owner.services!.call('social', 'echo', { $caller: { user: 'mama' } })
    expect(seen.at(-1)).toEqual({ $caller: { user: 'alice', name: 'владелец', role: 'owner', owner: true } })
    // Не общий сервис у owner — как раньше, без $caller.
    await owner.services!.call('other', 'echo', { y: 2 })
    expect(seen.at(-1)).toEqual({ y: 2 })
  })
})
