/**
 * @kerneldreams/files/collection — модель панели записей (objects-spec §4.1): запись и группа,
 * сортировка (группы сверху), маски Far и быстрый поиск, состояние списка ⇄ параметры вкладки,
 * выделение Far, строки дерева, пометки. Без зависимостей и UI: общая часть любого источника
 * панели — файлов (`nr-files`), персон, сессий.
 */

export * from './item.js'
export * from './mask.js'
export * from './sort.js'
export * from './format.js'
export * from './state.js'
export * from './selection.js'
export * from './tree.js'
export * from './decorations.js'
