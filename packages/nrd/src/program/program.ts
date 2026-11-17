/**
 * Program — файл, приведённый к одному внутреннему виду: корневой блок +
 * NRDocument. mdz/mdd приходят кодеком nr-md, mds — мостом из ленты nr-chat.
 * Всё, что дальше (реестр деклараций, сборка контекста, плагины), работает с
 * этим видом и про исходный формат не знает.
 *
 * Слой portable: ни `node:fs`, ни `node:path`. Чтение файла с инклюдами —
 * `loadProgram` на ступени `nrd/node`.
 */

import { NRDocument, parseDocument } from '../core/index.js'
import type { ExtendsLoader } from '../core/index.js'
import type { Block } from '../md/index.js'
import { mdsToRoot } from './bridge.js'

/** Вход хоста: mdz-грамматика с сигилом `$`/`@` либо лента nr-chat. */
export type InputKind = 'mdz' | 'mdd' | 'mds'

export const INPUT_KINDS: readonly InputKind[] = ['mdz', 'mdd', 'mds']

export function isInputKind(v: unknown): v is InputKind {
  return typeof v === 'string' && (INPUT_KINDS as readonly string[]).includes(v)
}

/** Сигил mdz-грамматики для вида входа (`mds` грамматики nr-md не имеет). */
export function sigilOf(kind: InputKind): '$' | '@' {
  return kind === 'mdd' ? '@' : '$'
}

export interface Program {
  /** Путь исходника (как его назвал хост). */
  file: string
  /** Директория исходника — база для относительных путей. */
  baseDir: string
  kind: InputKind
  root: Block
  doc: NRDocument
  source: string
}

/**
 * Директория пути — без `node:path`. Разделители обоих видов: пути в документах
 * пишутся через `/`, а хост может принести системный.
 */
export function dirOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  if (i < 0) return '.'
  if (i === 0) return file.slice(0, 1)
  return file.slice(0, i)
}

/**
 * Текст → Program. Единственная точка разбора: и `nrd/node.loadProgram`, и
 * хендлер, которому текст принесли иным способом (сеть, стор), приходят сюда.
 *
 * `load` — загрузчик `$nr-extends` (в mds не применяется: у ленты нет
 * блочного наследования).
 */
export function programFromText(
  text: string,
  kind: InputKind,
  file: string,
  load?: ExtendsLoader,
): Program {
  const baseDir = dirOf(file)
  if (kind === 'mds') {
    const root = mdsToRoot(text)
    // Псевдо-документ: тот же IContext-доступ (`doc.get(['fn', 'build'])`), что
    // у mdz — код в теле `fn` не должен знать, из какого формата он приехал.
    const doc = new NRDocument({ sigil: '$', root }, text)
    return { file, baseDir, kind, root, doc, source: text }
  }
  const doc = parseDocument(text, { sigil: sigilOf(kind) }, load)
  return { file, baseDir, kind, root: doc.doc.root, doc, source: text }
}

/** Program из уже разобранного документа (вход `runz <file.mdz>`). */
export function programFromDoc(doc: NRDocument, file: string): Program {
  return {
    file,
    baseDir: dirOf(file),
    kind: doc.doc.sigil === '@' ? 'mdd' : 'mdz',
    root: doc.doc.root,
    doc,
    source: (doc.cast('raw') as string | undefined) ?? '',
  }
}
