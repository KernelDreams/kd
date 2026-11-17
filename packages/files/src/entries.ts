/**
 * Записи каталога: виды файла, сортировка Far (каталоги сверху). Запись — подмножество
 * `FileEntry` протокола (поле в поле) поверх записи коллекции `Item` (`nr-collection`):
 * маски, быстрый поиск, подписи колонок — там.
 */

import { ITEM_COMPARE, compareText, sortItems, type Item, type ItemCompare, type ItemSort } from './collection/index.js'
import { extOf } from './address.js'

export interface Entry extends Item {
  /** Абсолютный путь. */
  path: string
  mime?: string
  host?: string
}

export type FileKind = 'dir' | 'image' | 'video' | 'audio' | 'text' | 'code' | 'archive' | 'pdf' | 'other'

const KINDS: Record<string, FileKind> = {}
const put = (kind: FileKind, exts: string): void => {
  for (const e of exts.split(' ')) KINDS[e] = kind
}
put('image', 'png jpg jpeg webp gif bmp tif tiff heic avif svg ico')
put('video', 'mp4 mov m4v webm mkv avi')
put('audio', 'mp3 wav ogg flac m4a aac opus')
put('text', 'md txt mdz mdd mds log csv tsv rtf')
put('code', 'ts tsx js jsx mjs cjs json json5 yaml yml toml css scss html htm py rs go java kt c h cpp hpp cs sh zsh rb php sql lua swift vue svelte')
put('archive', 'zip tar gz tgz bz2 xz 7z rar zst')
put('pdf', 'pdf')

/** Вид записи по типу и расширению (иконка, эскиз, что открыть по Enter). */
export function kindOf(e: Pick<Entry, 'name' | 'kind'>): FileKind {
  if (e.kind === 'dir') return 'dir'
  return KINDS[extOf(e.name)] ?? 'other'
}

/** У вида бывает эскиз (картинка, кадр видео). */
export const hasThumb = (k: FileKind): boolean => k === 'image' || k === 'video'

export type SortKey = 'name' | 'ext' | 'size' | 'mtime'
export const SORT_KEYS: readonly SortKey[] = ['name', 'ext', 'size', 'mtime']

export type Sort = ItemSort<SortKey>

const FILE_COMPARE: Record<SortKey, ItemCompare<Entry>> = {
  ...ITEM_COMPARE,
  ext: (a, b) => compareText(extOf(a.name), extOf(b.name)),
}

/** Сортировка Far: каталоги всегда сверху и по имени; файлы — по ключу, при равенстве — по имени. */
export function sortEntries<E extends Entry>(entries: readonly E[], sort: Sort = { key: 'name' }): E[] {
  return sortItems(entries, sort, FILE_COMPARE as Record<SortKey, ItemCompare<E>>)
}
