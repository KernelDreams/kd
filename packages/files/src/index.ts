/**
 * @kerneldreams/files — файловый источник панели записей (file-panel-spec;
 * objects-spec §4.1): адрес `{host, path}`, записи и сортировка Far, состояние вкладки с
 * каталогом, дерево каталогов, план копирования/переноса, пакетное переименование, git.
 * Общая часть (маски, выделение, состояние списка, строки дерева, пометки) — `nr-collection`,
 * реэкспортом отсюда. Без UI: один код у плагина nrchat, дистрибутива `far` и не-React страниц.
 */

export * from './collection/index.js'

export * from './address.js'
export * from './entries.js'
export * from './state.js'
export * from './plan.js'
export * from './rename.js'
export * from './tree.js'
export * from './git.js'
