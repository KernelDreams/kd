/**
 * `kd ui` — окно (kd-cli-spec §9): лента сессии агента этой папки в `<nr-chat>` и вопросы ящика
 * формой; чат прямо в окне. Сервер на loopback живёт, пока процесс не остановят (Ctrl+C).
 */

export const tool = {
  description: 'окно: чат с агентом этой папки и вопросы прогонов',
  fields: {
    session: 'string? // Сессия: id или путь .mds (по умолчанию — новая)',
    provider: 'string? // Провайдер',
    model: 'string? $kind=model // Модель',
  },
  needs: ['model'],
}

export { default } from './_ui-run.mjs'
