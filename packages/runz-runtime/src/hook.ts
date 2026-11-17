/**
 * @kerneldreams/runz-runtime — регистрация resolve-хука
 *
 * Одна точка, из которой хук встаёт в процесс. Потребителей два, и оба обязаны
 * получать ОДИН хук (rz-merge §0.5):
 *   - `importScriptFn` — ленивая регистрация перед импортом скрипта;
 *   - `register-hook.ts` — preload-модуль для `node --import` (`runz test`,
 *     любой сторонний прогон).
 *
 * Хук открывает скрипту канонические `@kerneldreams/*` из воркспейса runz
 * и цепочку `.runz/`-окружений — см. `resolve-hook.ts`.
 */

import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { collectEnvNodeModules } from './envs.ts'
import { modulePath, workspaceRoot } from './home.ts'
import { initialize, resolve } from './resolve-hook.ts'

export { workspaceRoot }

/** URL модуля-хука — для `register()` и для `--import`-обёртки. */
export function resolveHookURL(): string {
  return pathToFileURL(modulePath('resolve-hook')).href
}

let registered = false

/**
 * Зарегистрировать хук в текущем процессе (идемпотентно).
 *
 * @param cwd база для поиска `.runz/`-окружений (по умолчанию `process.cwd()`).
 */
export function registerResolveHook(cwd: string = process.cwd()): void {
  if (registered) return
  registered = true
  // В потоке, синхронно: `module.register()` (отдельный поток) — DEP0205 в Node 24.
  initialize({ workspaceRoot: workspaceRoot(), envs: collectEnvNodeModules(cwd) })
  registerHooks({ resolve: resolve as Parameters<typeof registerHooks>[0]['resolve'] })
}
