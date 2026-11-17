/**
 * buildRuntimeContext — assemble IContext from a file with full infrastructure.
 *
 * 1. Discover functions (upward .nrd/functions/ + builtins)
 * 2. Read file config (mdz attrs, ## $source blocks)
 * 3. Call nrd-context buildContext with discovered functions
 * 4. Return ready IContext — all ${fn()} resolved, sources loaded
 *
 * This is what every utility calls instead of manually wiring nrd-context.
 */

import { dirname } from 'node:path'
import { readTextWithIncludes } from './includes.js'
import { buildContext, chainSources } from '../context/index.js'
import { nodeCapabilities } from './capabilities.js'
import { funcContext, emptyContext, objectContext, chainContext } from '../core/index.js'
import type { IContext, FuncFn } from '../core/index.js'
import { discoverFunctions } from './functions.js'
import type { RuntimeOptions } from './types.js'

/**
 * Build a full runtime context from a file.
 *
 * @param filePath - path to mdz/mds file (reads config from it)
 * @param opts - extra params, functions, overrides
 * @returns IContext with functions, sources, and config resolved
 */
export async function buildRuntimeContext(
  filePath: string,
  opts: RuntimeOptions = {},
): Promise<IContext> {
  const baseDir = opts.baseDir ?? dirname(filePath)

  // 1. Discover functions
  const discovered = opts.skipDiscovery
    ? {}
    : discoverFunctions(baseDir, opts.globalFunctionsDir)
  const allFunctions: Record<string, FuncFn> = {
    ...discovered,
    ...(opts.functions ?? {}),
  }

  // 2. Read file config + развернуть $[[path]] (симметрично FileSession/parseDocFile)
  const config = readTextWithIncludes(filePath, baseDir, '[nrd/node]')

  // 3. Build context through nrd-context (resolves ## $source blocks, ${fn()} calls)
  const caps = nodeCapabilities(baseDir)
  // Ошибки buildContext (неизвестный плагин, $required, strict untrusted) —
  // наверх. Раньше catch-all возвращал контекст из одних функций: потребитель
  // молча терял данные и причину.
  const sourceCtx = await buildContext(config, {
    ...opts,
    baseDir,
    privilegedFunctions: allFunctions,
    storage: caps.storage,
    executor: caps.executor,
  })
  // Chain: source data (card, lorebook) + params (persona, bot, user, char)
  // Params are NOT in sourceCtx (buildContext uses them for resolution only)
  const params = opts.params ?? {}
  if (Object.keys(params).length > 0) {
    return chainContext(sourceCtx, objectContext(params))
  }
  return sourceCtx
}

/**
 * Build a standalone function context (no file, just functions).
 * For utilities that don't have a config file but want ${fn()} support.
 */
export function buildFunctionContext(
  startDir: string,
  extraFunctions?: Record<string, FuncFn>,
): IContext {
  const discovered = discoverFunctions(startDir)
  return funcContext({ ...discovered, ...(extraFunctions ?? {}) })
}
