// Контент-адресный стор векторов (embed-cas-spec §1). Вектор адресуется
// текстом, а не файлом: sha256(norm(text)) в пространстве space → вектор.

/** Контент-адресный стор векторов. space — алиас шлюза, hash — hex sha256 нормализованного текста. */
export interface EmbedStore {
  /** Найденные вектора; промахи в Map отсутствуют. */
  get(space: string, hashes: readonly string[]): Promise<Map<string, Float32Array>>
  /** Записать; уже лежащие хеши не перезаписываются. */
  put(space: string, entries: ReadonlyMap<string, Float32Array>): Promise<void>
  /** Число векторов и размерность пространства (`null` — пусто). */
  stat(space: string): Promise<{ count: number; dim: number | null }>
  /** Известные стору пространства. */
  spaces(): Promise<string[]>
}
