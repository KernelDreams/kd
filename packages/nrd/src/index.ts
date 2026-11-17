// @kerneldreams/nrd — корень: ES-ядро (nrd-merge §2.1).
//
// Ноль environment API: ни `node:`, ни fetch. Работает в GAS. Всё, что просит
// платформу, живёт на следующих ступенях лестницы:
//   `nrd/web`      — fetch/streams/crypto (Node + браузер + CF Workers)
//   `nrd/node`     — fs/spawn/process/discovery
//   `nrd/template` — ntpl, движки optional peers
//   `nrd/format`   — фасад кодека mdd/mdz
//
// Слои корня (бывшие пакеты nrd-core / nrd-context / nrd-exec / nr-infra):
//   ./core      — parser-фасад, IContext/IArray, resolver, walk, NRDocument
//   ./context   — buildContext: mdz-конфиг → chain, source/transform-плагины
//   ./exec      — execBlock: семантика исполняемого блока + контракт Executor
//   ./infra     — Result, generateId, fileIncludeResolver
//   ./program   — документ как программа: реестр деклараций, мост mds, fn/template

export * from './core/index.js'
export * from './context/index.js'
export * from './exec/index.js'
export * from './infra/index.js'
export * from './program/index.js'
