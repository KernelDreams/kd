/**
 * Пометки на записи (file-panel-spec §1): git-статус файла, «правил агент», ссылки `.md`.
 * Поставщиков несколько; каждый отдаёт пометки для набора путей, панель склеивает.
 */

export type DecorationTone = 'added' | 'modified' | 'deleted' | 'ignored' | 'conflict' | 'untracked' | 'info'

export interface Decoration {
  /** Поставщик: `git`, `agent`. */
  source: string
  /** Буква/значок в колонке (`M`, `A`, `?`). */
  badge?: string
  tone?: DecorationTone
  title?: string
}

export interface DecorationProvider {
  id: string
  /** Пометки для путей каталога `dir`; путь → пометки. Ошибка — без пометок этого поставщика. */
  decorate(dir: string, paths: readonly string[], host?: string): Promise<ReadonlyMap<string, Decoration[]>>
}

/** Опросить всех поставщиков и склеить по пути; упавший поставщик — молча без пометок. */
export async function collectDecorations(
  providers: readonly DecorationProvider[],
  dir: string,
  paths: readonly string[],
  host?: string,
): Promise<Map<string, Decoration[]>> {
  const out = new Map<string, Decoration[]>()
  const results = await Promise.allSettled(providers.map((p) => p.decorate(dir, paths, host)))
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const [path, list] of r.value) out.set(path, [...(out.get(path) ?? []), ...list])
  }
  return out
}
