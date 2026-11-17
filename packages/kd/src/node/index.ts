/** Вход хоста (`@kerneldreams/kd/node`): слои, каталог, правила объектов, ящик вопросов, палитры — для сервисов и сборок. */
export { loadLayers, type Layers, type Layer, type LayerId } from './layers.js'
export { loadCatalog, loadDecl, staticDecl, describeEntry, type Catalog, type ToolEntry } from './catalog.js'
export { loadRules } from './objects.js'
export * from './palette.js'
export * from './inbox.js'
export { copyInfo, type CopyInfo, type CopyMode } from './home.js'
