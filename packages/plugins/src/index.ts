/**
 * @kerneldreams/plugins — установка плагинов nrchat по ссылке на git, замок с откатом, реестры-репы и каскад
 * источников (plugin-registry-spec §5–6). Node, без зависимостей, кроме git машины. Потребители: сервис `collection`
 * (список плагинов, «Установить / Обновить / Откатить / Удалить»), `runz plugins`, стенд appz/pi (`$plugins_user`
 * → код-плагины), сервисы `forms` и `artifacts` (плагины-файлы и артефакты слоя).
 */

export * from './semver.js'
export * from './mdz.js'
export * from './manifest.js'
export * from './layer.js'
export * from './git.js'
export * from './install.js'
export * from './registry.js'
export * from './resolve.js'
