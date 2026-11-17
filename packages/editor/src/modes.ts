export type Mode =
  | 'md'
  | 'mdz'
  | 'mdd'
  | 'mds'
  | 'js'
  | 'ts'
  | 'jsx'
  | 'tsx'
  | 'json'
  | 'yaml'
  | 'css'
  | 'html'
  | 'text'

export const MODES: readonly Mode[] = [
  'md', 'mdz', 'mdd', 'mds', 'js', 'ts', 'jsx', 'tsx', 'json', 'yaml', 'css', 'html', 'text',
]

const EXTENSION_MODES: Record<string, Mode> = {
  md: 'md',
  markdown: 'md',
  mdz: 'mdz',
  mdd: 'mdd',
  mds: 'mds',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
  htm: 'html',
}

/** Mode by the last extension of a file name or path; unknown → `text`. */
export function modeFromFilename(name: string): Mode {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'text'
  const ext = base.slice(dot + 1).toLowerCase()
  return EXTENSION_MODES[ext] ?? 'text'
}

/** Markdown-family modes: live preview, wiki links, prose font, line wrapping. */
export function isMarkdownMode(mode: Mode): boolean {
  return mode === 'md' || mode === 'mdz' || mode === 'mdd' || mode === 'mds'
}

/** Modes served by the TypeScript language service. */
export function isScriptMode(mode: Mode): boolean {
  return mode === 'js' || mode === 'ts' || mode === 'jsx' || mode === 'tsx'
}

/** nrd sigil of a markdown-family mode: `$` for mdz/mds, `@` for md/mdd. */
export function sigilOf(mode: Mode): '$' | '@' | null {
  if (mode === 'mdz' || mode === 'mds') return '$'
  if (mode === 'md' || mode === 'mdd') return '@'
  return null
}
