// Встроенные фильтры ntpl — агрегатор (spec §5). Portable.

import type nunjucks from 'nunjucks'
import type { HelperRegistrar } from '../engine.js'
import { registerCore } from './core.js'
import { registerCollection } from './collection.js'
import { registerMorph } from './morph.js'

export * from './core.js'
export * from './collection.js'
export * from './morph.js'

/** Все встроенные регистраторы (core + collection). */
export const builtinHelpers: HelperRegistrar[] = [registerCore, registerCollection, registerMorph]

/** Зарегистрировать все встроенные фильтры на env. */
export function loadBuiltinHelpers(env: nunjucks.Environment): void {
  for (const reg of builtinHelpers) reg(env)
}
