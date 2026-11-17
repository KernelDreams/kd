/**
 * @kerneldreams/runz-runtime — runner registry
 *
 * The frame doesn't hardcode runners — it picks the first whose `canRun()`
 * accepts the script. New runners are added as files in this directory.
 */

import type { Runner, LoadedScript } from '../types.ts'
import { nodeRunner } from './node.ts'

const RUNNERS: Runner[] = [nodeRunner]

/** Select a runner for the given execution environment. */
export function selectRunner(runtime: string): Runner {
  const loaded: LoadedScript = {
    name: '',
    file: null,
    doc: null,
    fn: async () => ({}),
    runtime,
  }
  const runner = RUNNERS.find(r => r.canRun(loaded))
  if (!runner) {
    if (runtime === 'electron') {
      throw new Error('runz: electron runner is not implemented in v1')
    }
    throw new Error(`runz: no runner for runtime "${runtime}"`)
  }
  return runner
}

export { nodeRunner }
