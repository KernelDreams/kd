import type { RunStartInput } from '@kerneldreams/ui-protocol'

/**
 * Ран impersonate (v1.19): модель пишет за игрока, сообщение не пишется — ответ уходит только
 * вызвавшему. Не «ран сессии» для активности и `attach` (как служебные команды v1.47).
 */
export function isImpersonateRun(input: Pick<RunStartInput, 'target'> | undefined): boolean {
  return (input?.target as { kind?: unknown } | undefined)?.kind === 'user'
}
