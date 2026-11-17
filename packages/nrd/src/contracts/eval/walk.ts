// Path traversal (§4 of docs/specs/engine-spec.md).
// The heart of the resolver: walks a Value by segments, with cross-casts.

import type { IArray, IContext, ResolveOptions, Segment } from '../context.js'
import { isArray, isContext, isScalar } from '../context.js'
import type { Value } from '../value.js'

/**
 * Walk a Value along `segments`, one hop per segment.
 *
 * - IContext + segment → `get([seg])`
 * - IArray  + number   → `at(seg)`
 * - IArray  + name     → cross-cast to IContext, then `get([seg])`
 * - unknown + name     → cross-cast to IContext; unknown + number → IArray
 *
 * Soft (JS-like) in lenient mode; visible errors in strict mode.
 */
export function walk(val: Value, segments: Segment[], opts: ResolveOptions): Value | undefined {
  for (const seg of segments) {
    if (val === undefined || val === null) return undefined
    if (isScalar(val)) {
      if (opts.mode === 'strict') throw new Error(`cannot walk path: scalar at segment "${seg}"`)
      return undefined
    }
    if (isContext(val)) {
      val = val.get([seg])
      continue
    }
    if (isArray(val)) {
      if (typeof seg === 'number') {
        val = val.at(seg)
        continue
      }
      const asCtx = val.cast<IContext>('IContext') // name on an array → cross-cast
      if (asCtx) {
        val = asCtx.get([seg])
        continue
      }
      if (opts.mode === 'strict') throw new Error(`array does not support name segment "${seg}"`)
      return undefined
    }
    // Unknown type → cross-cast into IContext / IArray by segment kind.
    const c = (val as { cast?: (n: string) => unknown }).cast
    if (typeof c === 'function') {
      if (typeof seg === 'string') {
        const x = c.call(val, 'IContext') as IContext | undefined
        if (x) {
          val = x.get([seg])
          continue
        }
      }
      if (typeof seg === 'number') {
        const x = c.call(val, 'IArray') as IArray | undefined
        if (x) {
          val = x.at(seg)
          continue
        }
      }
    }
    if (opts.mode === 'strict') throw new Error(`unknown value type at segment "${seg}"`)
    return undefined
  }
  return val
}
