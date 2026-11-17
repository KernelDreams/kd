/**
 * Резолвер include-ссылок: стратегия поиска файла. Стыкует механику подстановки
 * (nrd-core.resolveIncludes) с тупым чтением байтов (IStorage). НЕ знает формат
 * mdd/mdz. Реализация (fileIncludeResolver) — в потребителе (nr-infra).
 */
export interface IncludeResolver {
  /** Найти и прочитать файл по ссылке. undefined — не найден. */
  resolve(ref: string, fromPath?: string): Promise<string | undefined>
}
