import type { Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import type { Mode } from './modes'

/**
 * Language support for code modes. Every grammar is a dynamic `import()`,
 * so the base bundle (core + markdown) carries none of them.
 */
export async function loadLanguage(mode: Mode): Promise<Extension> {
  switch (mode) {
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ typescript: mode === 'ts' || mode === 'tsx', jsx: mode === 'jsx' || mode === 'tsx' })
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json')
      return json()
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml')
      return yaml()
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css')
      return css()
    }
    case 'html': {
      const { html } = await import('@codemirror/lang-html')
      return html()
    }
    default:
      return []
  }
}

/** Grammars for fenced code inside markdown modes, loaded on first use. */
export const FENCE_LANGUAGES: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'javascript', 'mjs', 'cjs', 'node'],
    extensions: ['js', 'mjs', 'cjs'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts', 'typescript', 'mts', 'cts'],
    extensions: ['ts', 'mts', 'cts'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: 'JSX',
    alias: ['jsx'],
    extensions: ['jsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'TSX',
    alias: ['tsx'],
    extensions: ['tsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json', 'json5', 'jsonc'],
    extensions: ['json', 'json5'],
    load: async () => (await import('@codemirror/lang-json')).json(),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yaml', 'yml'],
    extensions: ['yaml', 'yml'],
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  }),
  LanguageDescription.of({
    name: 'CSS',
    alias: ['css'],
    extensions: ['css'],
    load: async () => (await import('@codemirror/lang-css')).css(),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['html', 'htm', 'xhtml'],
    extensions: ['html', 'htm'],
    load: async () => (await import('@codemirror/lang-html')).html(),
  }),
]
