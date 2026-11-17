import type { IStorage } from '../contracts/index.js'
import { isOk } from './result.js'
import type { IncludeResolver } from '../contracts/index.js'

// IncludeResolver — тип переехал в @kerneldreams/nrd/contracts (ступень 1);
// реализация (fileIncludeResolver) остаётся здесь.
export type { IncludeResolver } from '../contracts/index.js'

/** Все пути в storage-пространстве — с прямым слешем. */
function isAbsolute(ref: string): boolean {
  return ref.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(ref)
}

function dirname(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? '' : norm.slice(0, idx)
}

/** Нормализовать путь: разрешить `.` и `..`, схлопнуть слеши. */
function normalize(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'))
}

/** Есть ли расширение у последнего сегмента. */
function hasExtension(ref: string): boolean {
  const base = ref.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.includes('.') && !base.startsWith('.')
}

export function fileIncludeResolver(opts: {
  storage: IStorage
  /** корневые директории для поиска */
  roots?: string[]
  /** ['.obsidian', '.runz'] — поиск рута вверх по дереву от fromPath */
  rootMarkers?: string[]
  /** ['.md', '.mdd', '.mdz'] — автодобавление расширения */
  extensions?: string[]
}): IncludeResolver {
  const { storage } = opts
  const roots = opts.roots ?? []
  const rootMarkers = opts.rootMarkers ?? []
  const extensions = opts.extensions ?? []

  /** Кандидаты имён файла для base: сам base + (если без расширения) с каждым ext. */
  function candidates(base: string): string[] {
    const out = [base]
    if (!hasExtension(base)) {
      for (const ext of extensions) {
        out.push(base + (ext.startsWith('.') ? ext : '.' + ext))
      }
    }
    return out
  }

  /** Прочитать первый существующий кандидат. */
  async function tryRead(base: string): Promise<string | undefined> {
    for (const cand of candidates(base)) {
      const r = await storage.read(cand)
      if (isOk(r) && r.value !== undefined) return r.value
    }
    return undefined
  }

  /** Найти маркер рута вверх по дереву от dir. */
  async function findMarkerRoot(dir: string): Promise<string | undefined> {
    let current = dir
    while (true) {
      for (const marker of rootMarkers) {
        const markerPath = join(current, marker)
        // Маркер может быть файлом (exists) или директорией (непустой list).
        const ex = await storage.exists(markerPath)
        if (isOk(ex) && ex.value) return current
        const ls = await storage.list(markerPath)
        if (isOk(ls) && ls.value.length > 0) return current
      }
      if (current === '') break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  return {
    async resolve(ref, fromPath) {
      // 1. Абсолютный путь — читать напрямую.
      if (isAbsolute(ref)) {
        return tryRead(normalize(ref))
      }

      // 2. Относительно директории файла-источника.
      if (fromPath) {
        const found = await tryRead(join(dirname(fromPath), ref))
        if (found !== undefined) return found
      }

      // 3. Искать в roots[].
      for (const root of roots) {
        const found = await tryRead(join(root, ref))
        if (found !== undefined) return found
      }

      // 4. Найти маркер рута вверх по дереву от fromPath.
      if (fromPath && rootMarkers.length) {
        const markerRoot = await findMarkerRoot(dirname(fromPath))
        if (markerRoot !== undefined) {
          const found = await tryRead(join(markerRoot, ref))
          if (found !== undefined) return found
        }
      }

      // 5. Как есть, относительно корня storage.
      const direct = await tryRead(normalize(ref))
      if (direct !== undefined) return direct

      // 6. Не нашли.
      return undefined
    },
  }
}
