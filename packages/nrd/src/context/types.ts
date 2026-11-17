// nrd-context — публичные контракты. Ступень 1 Total Refactor: точки расширения
// (Logger/noopLogger/HttpClient/SourceContext/SourcePlugin/TransformPlugin)
// переехали в @kerneldreams/nrd/contracts. Файл остаётся домом для внутренних
// импортов (`./types.js`) и держит зарезервированные ключи ATTR_*.

export { noopLogger } from '../contracts/index.js'
export type {
  Logger,
  HttpClient,
  SourceContext,
  SourcePlugin,
  TransformPlugin,
} from '../contracts/index.js'

/** Зарезервированные ключи в attrs, прокидываемые ядром помимо атрибутов блока. */
export const ATTR_BODY = '$body'
export const ATTR_NAME = '$name'
