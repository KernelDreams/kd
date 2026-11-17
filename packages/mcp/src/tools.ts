/**
 * Набор тулов машины: весь `nr-tools` (read, ls, find, grep, write, edit, apply_patch, exec, process) поверх
 * корней `$roots`; `runz`/`runz_list` — если `runz` есть на машине. `find`/`grep` берут `fd`/`rg` хоста,
 * нет — свой обход. Апрувов нет: `policy` тулов не читается, `$deny` — маски команд `exec`.
 */

import { fsOf } from '@kerneldreams/chat-store/fs'
import { createNodeFileSystem } from '@kerneldreams/chat-store/node-fs'
import { createExecTools, createFsTools, type ExecDenyRule, type ProcessRegistry, type ToolDef } from '@kerneldreams/tools'
import { createNodeExecHost, createRunzTools, which } from '@kerneldreams/tools/node'
import { homedir } from 'node:os'
import type { McpConfig } from './config.js'
import { createRootsGuard, guardFs, type RootsGuard } from './roots.js'

/** Маска команды (`*` — любая подстрока) → правило запрет-листа `exec`. */
export function denyRule(mask: string): ExecDenyRule {
  const re = mask
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return { pattern: new RegExp(`^\\s*${re}\\s*$`, 'i'), reason: `$deny of this machine: ${mask}` }
}

export interface MachineTools {
  tools: ToolDef[]
  guard: RootsGuard
  processes: ProcessRegistry
  /** Где нашёлся runz (нет — тулов runz нет). */
  runz?: string
}

export interface MachineToolsOptions {
  /** Искать runz (тесты: false). Default — PATH. */
  runz?: string | false
  /** fd/rg хоста; default true. */
  external?: boolean
}

export function createMachineTools(cfg: McpConfig, opts: MachineToolsOptions = {}): MachineTools {
  const guard = createRootsGuard(cfg.roots)
  const host = createNodeExecHost({ external: opts.external !== false })
  const fs = guardFs(fsOf(createNodeFileSystem()), guard)
  const root = { cwd: guard.roots[0]!, scope: 'any' as const, fs, home: homedir() }
  const runz = opts.runz === false ? undefined : (opts.runz ?? which('runz'))
  const tools: ToolDef[] = [
    ...createFsTools({ ...root, search: host }),
    ...createExecTools({ ...root, processes: host.processes, deny: cfg.deny.map(denyRule) }),
    ...(runz ? createRunzTools({ cwd: root.cwd, command: () => [runz] }) : []),
  ]
  return { tools, guard, processes: host.processes, ...(runz ? { runz } : {}) }
}
