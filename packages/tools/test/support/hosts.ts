/**
 * Хосты юнитов: тулы гоняются на файловой системе в памяти (доказательство,
 * что ядро не ходит мимо `Fs`) и на диске с процессами Node.
 */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFileSystem, fsOf, type Fs } from '@kerneldreams/chat-store/fs'
import { createNodeFileSystem } from '@kerneldreams/chat-store/node-fs'
import type { ExecHost } from '../../src/host.js'
import { createNodeExecHost } from '../../src/node/index.js'

export interface TestHost {
  name: 'memory' | 'node'
  host: { exec?: ExecHost }
  fs: Fs
  /** Рабочий каталог (абсолютный). */
  dir: string
  put(rel: string, data: string | Uint8Array): Promise<void>
  get(rel: string): Promise<string>
  exists(rel: string): Promise<boolean>
  /** Новый каталог вне `dir`. */
  outside(): Promise<string>
  /** Симлинк `dir/rel` → `target` (только Node). */
  symlink?(target: string, rel: string): void
  cleanup(): void
}

function wrap(name: TestHost['name'], fs: Fs, exec: ExecHost | undefined, dir: string, extra: Partial<TestHost> = {}): TestHost {
  const abs = (rel: string): string => `${dir}/${rel}`
  return {
    name,
    host: exec ? { exec } : {},
    fs,
    dir,
    put: async (rel, data) => (typeof data === 'string' ? fs.writeText(abs(rel), data) : fs.writeBytes(abs(rel), data)),
    get: async (rel) => {
      const t = await fs.readText(abs(rel))
      if (t === undefined) throw new Error(`нет ${rel}`)
      return t
    },
    exists: (rel) => fs.exists(abs(rel)),
    outside: async () => {
      const d = `/outside-${Math.random().toString(36).slice(2, 8)}`
      await fs.mkdir(d)
      return d
    },
    cleanup: () => {},
    ...extra,
  }
}

export function memoryTestHost(): TestHost {
  return wrap('memory', fsOf(createMemoryFileSystem({})), undefined, '/work')
}

export function nodeTestHost(): TestHost {
  const dir = mkdtempSync(join(tmpdir(), 'nr-tools-'))
  const exec = createNodeExecHost()
  const made: string[] = [dir]
  return wrap('node', fsOf(createNodeFileSystem()), exec, dir, {
    outside: async () => {
      const d = mkdtempSync(join(tmpdir(), 'nr-out-'))
      made.push(d)
      return d
    },
    symlink: (target, rel) => symlinkSync(target, join(dir, rel)),
    cleanup: () => {
      exec.processes.killAll()
      for (const d of made) rmSync(d, { recursive: true, force: true })
    },
  })
}

export const TEST_HOSTS: Array<() => TestHost> = [memoryTestHost, nodeTestHost]
