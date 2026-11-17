// Executor — контракт исполнения блока. Домашний реэкспорт из
// @kerneldreams/nrd/contracts (ступень 1 Total Refactor).
//
// Тип-контракт (Engine/ExecInput/ExecOutput/Executor) переехал в контракт;
// файл остаётся домом контракта и держит
// публичную поверхность без изменений. Реализации (execBlock, spawnExecutor) —
// в index.ts / executors/spawn.ts.

export type { Engine, ExecInput, ExecOutput, Executor } from '../contracts/index.js'
