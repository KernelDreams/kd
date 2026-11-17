// Fan-out: cartesian product of named collections (§7 of engine-spec.md).
// Pure combinatorics — no document knowledge, no reachability.

import type { IContext, IArray } from '../context.js'
import type { Value } from '../value.js'
import { objectContext } from './contexts.js'

export interface CartesianOptions {
  /** Axis order from outermost (slowest) to innermost (fastest). */
  order?: string[]
}

/**
 * Cartesian product of named collections.
 *
 * Each combo → IContext where name → element (scalar or IContext, as-is).
 * Empty collection in the set → 0 combos (mathematically correct).
 * Zero collections → one empty combo (template without variables = one result).
 */
export function cartesian(
  collections: Map<string, IArray>,
  opts?: CartesianOptions,
): IContext[] {
  const keys = opts?.order
    ? [...opts.order, ...[...collections.keys()].filter(k => !opts.order!.includes(k))]
    : [...collections.keys()]

  // Filter to keys that actually exist in collections
  const axes = keys.filter(k => collections.has(k))

  if (axes.length === 0) return [objectContext({})]

  // Collect arrays
  const arrays: { name: string; items: Value[] }[] = []
  for (const name of axes) {
    const arr = collections.get(name)!
    const items: Value[] = []
    const len = arr.length()
    if (len === 0) return [] // empty collection → 0 combos
    for (let i = 0; i < len; i++) items.push(arr.at(i))
    arrays.push({ name, items })
  }

  // Cartesian product: outer loop = first axis (slowest), inner = last (fastest)
  const results: IContext[] = []
  const indices = new Array(arrays.length).fill(0)

  while (true) {
    // Build combo from current indices
    const record: Record<string, Value> = {}
    for (let a = 0; a < arrays.length; a++) {
      record[arrays[a].name] = arrays[a].items[indices[a]]
    }
    results.push(objectContext(record))

    // Increment: rightmost (innermost/fastest) first
    let carry = arrays.length - 1
    while (carry >= 0) {
      indices[carry]++
      if (indices[carry] < arrays[carry].items.length) break
      indices[carry] = 0
      carry--
    }
    if (carry < 0) break
  }

  return results
}
