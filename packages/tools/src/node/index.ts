/**
 * Node-половина `@kerneldreams/tools`: реестр процессов `sh -c` для
 * `exec`/`process`, ускоритель `find`/`grep` (`rg`/`fd` из PATH) и тулы
 * `runz`/`runz_list` (нужен spawn).
 */

import type { ExecHost } from '../host.js'
import { createProcessRegistry } from './processes.js'
import { runLines, which } from './search.js'

export { createProcessRegistry } from './processes.js'
export { runLines, which } from './search.js'
export * from './runz/index.js'

export interface NodeExecHostOptions {
  /** Свой реестр (его `killAll` — у владельца). Default — новый. */
  processes?: ExecHost['processes']
  /** `fd`/`rg` из PATH для find/grep. Default true. */
  external?: boolean
}

/** {@link ExecHost} на Node: процессы + `rg`/`fd` из PATH. */
export function createNodeExecHost(opts: NodeExecHostOptions = {}): ExecHost & { processes: ExecHost['processes'] } {
  return {
    processes: opts.processes ?? createProcessRegistry(),
    ...(opts.external !== false ? { which, lines: runLines } : {}),
  }
}
