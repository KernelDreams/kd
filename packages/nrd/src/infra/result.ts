/**
 * Result — реэкспорт из канона @kerneldreams/nrd/contracts (ступень 1 Total Refactor).
 * Тип и конструкторы переехали в контракт; nr-infra отдаёт их отсюда без изменений
 * поверхности. Внутренние модули nr-infra продолжают импортить из './result.js'.
 */
export {
  type Result,
  type AsyncResult,
  ok,
  err,
  isOk,
  isErr,
} from '../contracts/index.js'
