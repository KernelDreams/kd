import type { IContext, FuncFn, Value } from '../core/index.js'
import type { BuildContextOptions } from '../context/index.js'

export interface RuntimeOptions extends BuildContextOptions {
  /** Extra functions to register (merge with discovered + builtins). */
  functions?: Record<string, FuncFn>
  /** Skip upward .nrd/functions/ discovery (use only builtins + explicit). */
  skipDiscovery?: boolean
  /** Global functions dir override (default: ~/.nrd/functions/). */
  globalFunctionsDir?: string
}
