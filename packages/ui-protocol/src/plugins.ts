/**
 * Внешние плагины фронта (v1.24, core-boundary-spec §3): ESM-бандлы из своих
 * реп, которые стенд раздаёт, а фронт грузит `import()` до первого рендера.
 * Папки — `$plugins` стенда; что внутри бандла, протокол не знает.
 *
 * Провод (`serveBackend({plugins})`):
 *   GET /plugins/<id>/<путь>  → файл из `dist/` плагина (index.js, index.css, ассеты), no-cache
 *   GET /plugins/events       → SSE `plugin_changed {id, version}` — бандл пересобран
 *
 * Capability `plugins` — список того, что грузить. `url`/`css` на проводе —
 * относительные к базе бэкенда (`plugins/hello/index.js?v=…`); клиент
 * (`createHttpBackend`) делает их абсолютными и добавляет ключ доступа.
 */

import type { Capabilities } from './types.js'

/** Один внешний плагин в capability `plugins`. */
export interface ExternalPluginInfo {
  /** Id плагина = имя папки в URL = id его сервиса. */
  id: string
  /** ESM-модуль с `export default NRChatPlugin`. */
  url: string
  /** Стиль плагина (утилиты Tailwind на токенах скина), если бандл его несёт. */
  css?: string
  /** Версия бандла (mtime/хэш): сменилась — фронт перезагружает плагин. */
  version?: string
  /** Рядом есть `service.mjs` — бэкенд держит его сервис под тем же `id`. */
  service?: boolean
  /**
   * Плагин проекта (v1.26, `$plugins` проекта): фронт грузит его, только пока
   * открыт проект с этим id, и выгружает при уходе. Нет — плагин стенда, всегда.
   */
  workspace?: string
  /**
   * Диапазон версий Plugin API (`package.json` → `nrchat.api`, v1.71, plugin-registry-spec §5): не подходит версии
   * хоста — фронт плагин не грузит, причина видна в списке плагинов. Нет — плагин круга 1, грузится.
   */
  api?: string
  /** Откуда папка (v1.71): `stand` — `$plugins` стенда, `user` — слой пользователя (`$plugins_user`, установка по ссылке). */
  origin?: 'stand' | 'user' | 'contour'
}

/** Кадр `/plugins/events`: бандл плагина изменился на диске. */
export interface PluginChangedEvent {
  type: 'plugin_changed'
  id: string
  version?: string
}

export type PluginChangedListener = (event: PluginChangedEvent) => void

/** Файл бандла для раздачи. */
export interface PluginFile {
  data: Uint8Array
  mime: string
}

/**
 * Источник внешних плагинов для транспорта (как `SkinsOps` у скинов): общий
 * для бэкендов стенда, поэтому опция `serveBackend`, а не метод бэкенда.
 */
export interface PluginsSource {
  list(): ExternalPluginInfo[] | Promise<ExternalPluginInfo[]>
  /** Файл `<путь>` плагина `id`; нет — `null` (404). Выход за папку — `null`. */
  file(id: string, path: string): Promise<PluginFile | null>
  /** Подписка на пересборку; нет — фронт узнаёт о новой версии только перезагрузкой. */
  watch?(listener: PluginChangedListener): () => void
}

/** Клиентская сторона: подписка на `plugin_changed` (капабилити — `plugins`). */
export interface PluginsOps {
  watch(listener: PluginChangedListener): () => void
}

/** Внешние плагины бэкенда; нет capability — пусто. */
export function externalPlugins(caps: Capabilities | null | undefined): ExternalPluginInfo[] {
  return Array.isArray(caps?.plugins) ? caps.plugins : []
}

/** Разбор кадра `/plugins/events`; чужой — `null`. */
export function parsePluginChanged(raw: unknown): PluginChangedEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const ev = raw as Record<string, unknown>
  if (ev.type !== 'plugin_changed' || typeof ev.id !== 'string' || ev.id === '') return null
  return { type: 'plugin_changed', id: ev.id, ...(typeof ev.version === 'string' ? { version: ev.version } : {}) }
}

/** Событие → SSE-кадр `/plugins/events` (как `serializeWorkspaceEvent`). */
export function serializePluginChanged(event: PluginChangedEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
