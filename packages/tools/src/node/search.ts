/**
 * Ускорители `find`/`grep` Node-хоста: `fd`/`rg` из PATH (tools-spec §2).
 * Нет бинаря — ядро ищет само, обходом `host.fs`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'

const whichCache = new Map<string, string | undefined>()

export function which(bin: string): string | undefined {
  if (!whichCache.has(bin)) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' })
    whichCache.set(bin, r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || undefined : undefined)
  }
  return whichCache.get(bin)
}

/** Строки вывода дочернего процесса; отмена — kill. */
export function runLines(bin: string, args: string[], signal: AbortSignal, onLine: (line: string, stop: () => void) => void): Promise<{ code: number | null; stderr: string; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stopped = false
    const stop = (): void => {
      stopped = true
      if (!child.killed) child.kill()
    }
    const onAbort = (): void => stop()
    signal.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (d) => (stderr += String(d)))
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => onLine(line, stop))
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`Failed to run ${basename(bin)}: ${err.message}`))
    })
    child.on('close', (code) => {
      rl.close()
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new Error('Operation aborted'))
      else resolve({ code, stderr, stopped })
    })
  })
}
