// Единственная реализация синхронного чтения файла в nrd (nrd-merge §2.5).
//
// Закрывает DEBT MAP §4.2 «четыре реализации чтения файла»: до слияния
// `readFileSync` жил отдельно в nrd-context/functions.ts, nr-runtime/context.ts
// и ntpl/node.ts (плюс асинхронный fsStorage в nr-infra). Теперь синхронное
// чтение здесь одно, а всё портируемое просит его через порт `SyncFileIO`.

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { stripBom } from '../md/index.js'
import type { SyncFileIO } from '../context/functions.js'

/**
 * Прочитать файл как UTF-8 текст. Бросает, если файла нет. Ведущий BOM
 * снимается: оставленный, он прилипает к первой строке и молча съедает первый
 * атрибут (`$type` пропадал месяцами —).
 */
export function readTextSync(path: string): string {
  return stripBom(readFileSync(path, 'utf-8'))
}

/** Node-реализация порта {@link SyncFileIO}. */
export const nodeFileIO: SyncFileIO = {
  readText: readTextSync,
  isAbsolute,
  resolve: (baseDir, path) => resolvePath(baseDir, path),
}
