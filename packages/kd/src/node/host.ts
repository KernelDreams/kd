/**
 * Тулы комплекта идут в процессе `kd` (через рантайм runz): им нужен вызов (`io`: терминал,
 * вопросы) и слои копии. `kd` кладёт их сюда перед исполнением тула.
 */

import type { Layers } from './layers.js'

export interface KdHost {
  io: {
    interactive: boolean
    ask?: (q: string) => Promise<string>
    stderr: (s: string) => void
    cwd: string
    env: NodeJS.ProcessEnv
  }
  layers: Layers
}

const KEY = Symbol.for('kerneldreams.kd.host')

export function setHost(h: KdHost | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[KEY] = h
}

export function hostOf(): KdHost | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as KdHost | undefined
}
