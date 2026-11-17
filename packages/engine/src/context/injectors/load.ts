// Резолв `$lorebooks` → LorebookInjector'ы.
//
// Привязка (v1 §4.7): per-session (`$lorebooks`) > per-card > global. Каскад
// уже делает эту работу: `$lorebooks` читается первым попаданием по цепочке
// (сессия перекрывает карточку), конфликты по id — ближний побеждает.
//
// Это ХОСТ-сторона: имя → путь → injector. Сам плагин про ФС ничего не знает,
// он читает через caps.storage.

import type { IStorage } from '@kerneldreams/nrd/web'
import { LorebookInjector } from './lorebook.js'
import type { IContextInjector, Logger } from '../types.js'

/** Кандидаты пути для имени лорбука (относительно корня storage). */
function candidates(name: string): string[] {
  if (/\.(mdd|md|mdz)$/i.test(name)) return [name, `lorebooks/${name}`]
  return [
    `${name}.mdd`,
    `${name}.md`,
    `lorebooks/${name}.mdd`,
    `lorebooks/${name}.md`,
    name,
  ]
}

export async function loadLorebooks(
  names: string[],
  storage: IStorage,
  log: Logger,
  scanDepth?: number,
): Promise<IContextInjector[]> {
  const out: IContextInjector[] = []
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name)) continue // конфликт по id — ближний (первый) победил
    seen.add(name)

    let found: string | undefined
    for (const path of candidates(name)) {
      const res = await storage.exists(path)
      if (res.ok && res.value) {
        found = path
        break
      }
    }
    if (!found) {
      log.warn(`lorebook "${name}" не найден`)
      continue
    }
    out.push(
      new LorebookInjector({
        id: name,
        path: found,
        ...(scanDepth === undefined ? {} : { scanDepth }),
      }),
    )
  }

  return out
}
