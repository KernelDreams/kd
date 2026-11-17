// Значение по пути через точку — без зависимостей (его берут и `./react`, где нет nunjucks).

export function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}
