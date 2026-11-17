/**
 * `@kerneldreams/runz-run/pool` — пул машин (compute-pool-spec): центр раздаёт задачи
 * jobs воркерам, воркер на каждой машине сам их забирает в пределах своего
 * бюджета и предохранителя; код и входы — пакетами по хэшу; аренда; шарды.
 *
 * ```ts
 * const center = new Center({ dir: jobsDir() }).start()
 * await servePool(center, { keys: { mini: '…', air: '…' }, port: 7860 })
 * // на машине:
 * await new Worker({ config: loadWorkerConfig(), client: httpPoolClient(url, key) }).run()
 * ```
 */

export { Center, LEASE_MS, DEFAULT_RETRIES, type Assignment, type CenterOpts, type FinishReport, type HeartbeatReply, type LogLine, type WorkerView } from './center.js'
export { servePool, httpPoolClient, localPoolClient, poolWorkers, poolPause, type ServeOpts } from './http.js'
export {
  Worker,
  loadWorkerConfig,
  defaultWorkerConfig,
  workerConfigFile,
  measure,
  freeMemory,
  hoursOk,
  runzExecutor,
  HEARTBEAT_MS,
  CLAIM_WAIT_MS,
  type PoolClient,
  type WorkerConfig,
  type WorkerOpts,
  type Executor,
  type ExecTask,
  type ExecResult,
} from './worker.js'
export { PkgCache } from './cache.js'
export { pack, unpack, packCode, manifestSha, walk, type Pack, type CodePack } from './pack.js'
export { putPkg, readPkg, splitRef, poolDir } from './store.js'
export { guardState, matches, fitsBudget, canTake, pick, used } from './select.js'
export { parseSize, formatSize, parseNeeds, formatNeeds, parseBudget, parseGuard, needsOf, DEFAULT_NEEDS } from './types.js'
export type { Needs, Budget, Guard, Measure, WorkerState, RunningLease } from './types.js'
