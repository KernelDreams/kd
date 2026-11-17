/**
 * Доверие сервиса `links` (v1.54, link-resolver-spec §4, §9 п.7): участнику стенда гейт
 * подкладывает `$caller` (клиент его не подделает), сервис собирает слои гостя без `exec`;
 * owner — без `$caller`, доверенный.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryServices } from '@kerneldreams/backend-local/services'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { LinkRules } from '@kerneldreams/ui-protocol'
import * as nrdModule from '@kerneldreams/nrd'
import { createStoreBackend } from '../src/store-backend.js'
import { createUsersGate } from '../src/gate.js'
import { createMemoryUsers } from '../src/users.js'
import { createLinksService, defaultLinkLayers, type LinksNrd } from '../src/links.js'

const nrd = nrdModule as unknown as LinksNrd

describe('links: гость через гейт пользователей', () => {
  it('member — $caller от гейта, exec пользовательского слоя не виден и не выполняется; owner — виден', async () => {
    const root = mkdtempSync(join(tmpdir(), 'links-gate-'))
    mkdirSync(join(root, 'users', 'dana'), { recursive: true })
    writeFileSync(join(root, 'users', 'dana', 'links.mdz'), '## $action pwn\n$for: file\n$run: exec\n$cmd: echo pwned\n')
    writeFileSync(join(root, 'links.mdz'), '## $action stand\n$for: file\n$run: exec\n$cmd: echo stand\n')
    const seen: unknown[] = []
    const service = createLinksService({ nrd, layers: (input) => defaultLinkLayers(root, input, { nrd }) })
    const services = createMemoryServices(
      {
        links: (ctx, meta) => {
          service(ctx, meta as never)
          const m = meta as { on(name: string, h: (p: unknown) => unknown): void }
          m.on('echo', (p) => {
            seen.push(p)
            return p
          })
        },
      },
      { root },
    )
    const backend = createStoreBackend({ store: createMemoryStore(), name: 't', services, generate: async function* () {} })
    const users = createMemoryUsers({
      stateRoot: join(root, 'state'),
      users: [
        { id: 'alice', name: 'owner', role: 'owner' },
        { id: 'dana', name: 'Дана', role: 'member', services: ['links'] },
      ],
    })
    const gate = createUsersGate({ backend, users })
    const list = await users.list()
    const member = gate.backendFor({ user: list.find((u) => u.id === 'dana')!, via: 'link' })
    const owner = gate.backendFor({ user: list.find((u) => u.id === 'alice')!, via: 'link' })

    // Клиент участника пытается выдать себя за owner — гейт перекрывает.
    await member.services!.call('links', 'echo', { $caller: { user: 'alice', owner: true } })
    expect(seen[0]).toMatchObject({ $caller: { user: 'dana', owner: false } })

    const asMember = (await member.services!.call('links', 'rules', { user: 'dana' })) as LinkRules
    expect(asMember.trusted).toBe(false)
    expect(asMember.actions.map((a) => a.id)).toEqual(['stand'])
    await expect(member.services!.call('links', 'run', { action: 'pwn', vars: {}, user: 'dana' })).rejects.toThrow(/нет/)

    const asOwner = (await owner.services!.call('links', 'rules', { user: 'dana' })) as LinkRules
    expect(asOwner.trusted).toBe(true)
    expect(asOwner.actions.map((a) => a.id).sort()).toEqual(['pwn', 'stand'])
  })
})
