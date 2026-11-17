// v1.30 — пользователи стенда (users-spec §2–5): гейты фронта.
import { describe, expect, it } from 'vitest'
import { canShareSession, canUsers, canWriteFiles, canWriteSession, isStandOwner } from '../src/index.js'
import type { Capabilities } from '../src/index.js'

const engines: Capabilities['engines'] = { list: [{ id: 'nr', local: true, available: true }, { id: 'acp', available: true }], default: 'nr' }
const owner = { users: { me: { id: 'alice', name: 'владелец', role: 'owner' as const, engines: ['nr', 'acp'], via: 'access' as const }, admin: true }, engines }
const member = { users: { me: { id: 'test', name: 'test', role: 'member' as const, engines: ['nr'], via: 'link' as const } }, engines }

describe('users (v1.30)', () => {
  it('стенд без пользователей — владелец один, всё можно', () => {
    expect(canUsers({})).toBe(false)
    expect(isStandOwner({})).toBe(true)
    expect(canWriteSession({}, { owner: 'x' })).toBe(true)
    expect(canShareSession({}, { owner: 'x' })).toBe(false)
  })

  it('owner стенда — всё', () => {
    expect(isStandOwner(owner)).toBe(true)
    expect(canWriteSession(owner, { owner: 'test', engine: 'acp' })).toBe(true)
    expect(canShareSession(owner, { owner: 'test' })).toBe(true)
  })

  it('member: свои сессии; чужая — только расшаренная с write; ACP — никогда', () => {
    expect(isStandOwner(member)).toBe(false)
    expect(canWriteSession(member, { owner: 'test' })).toBe(true)
    expect(canWriteSession(member, { owner: 'oscar' })).toBe(false)
    expect(canWriteSession(member, { owner: 'oscar', shared: { write: true } })).toBe(true)
    expect(canWriteSession(member, { owner: 'test', engine: 'acp' })).toBe(false)
    expect(canShareSession(member, { owner: 'test' })).toBe(true)
    expect(canShareSession(member, { owner: 'oscar' })).toBe(false)
  })

  it('файлы: viewer — только чтение', () => {
    expect(canWriteFiles({ role: 'viewer' })).toBe(false)
    expect(canWriteFiles({ role: 'editor' })).toBe(true)
    expect(canWriteFiles({})).toBe(true)
  })
})
