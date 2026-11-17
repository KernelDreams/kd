/**
 * @kerneldreams/skins — скины nrchat как данные (nrchat.dev/specs/skin-spec.md).
 *
 * Без IO: контракт (токены, селекторы, свойства), шапка `@skin`, валидатор,
 * сборка с `base`, правила читаемости (кегль, контраст — `readability`). Файлы на диске, источник `SkinsOps` и выжимка агенту —
 * `@kerneldreams/skins/node`.
 */

export * from './contract.js'
export * from './skin.js'
export * from './readability.js'
export * from './convert/core.js'
export * from './obsidian.js'
export * from './sillytavern.js'
export * from './vscode.js'
export * from './convert/index.js'
export { evalColor } from './convert/color.js'
