/**
 * `kd acp` (kd-cli-spec §9) — тот же агент, что `kd agent`, по ACP на stdio: редакторы (Zed и др.)
 * запускают его процессом. stdout занят протоколом, ход — в stderr. Живёт, пока открыт stdin.
 */

export const tool = {
  description: 'агент kd по ACP (stdio) для редакторов',
  fields: {
    provider: 'string? // Провайдер',
    model: 'string? $kind=model // Модель',
    agent: 'string? // Профиль агента',
    cwd: 'string? $kind=file // Рабочая папка',
  },
  needs: ['model'],
  examples: ['kd acp  # в настройках редактора: команда агента'],
}

export { default } from './_acp-run.mjs'
