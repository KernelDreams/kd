// Нейтральный тестовый site-плагин (example.com): ядро своих сайтов не держит, площадки регистрируются снаружи.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedUrl, SitePlugin } from '../../src/template/index.js'

export const exampleSite: SitePlugin = {
  name: 'example',
  hostname: ['example.com', 'www.example.com'],
  parseUrl(arg: string): ParsedUrl | null {
    const p = arg.replace(/^https?:\/\/(www\.)?example\.com\//i, '').replace(/^\/+|\/$/g, '')
    if (!p) return null
    if (p.startsWith('pages/')) return { resource: 'pages', path: p.slice('pages/'.length) }
    if (p.startsWith('books/')) return { resource: 'books', path: p.slice('books/'.length) }
    if (/^[\w-]+\/[\w-]+/.test(p)) return { resource: 'pages', path: p }
    return null
  },
  matchShorthand: (arg: string) => !arg.includes('.') && (/^(pages|books)\//.test(arg) || /^[\w-]+\/[\w-]+/.test(arg)),
  defaultTemplates: { pages: 'example/page', books: 'example/book' },
  accounts: { me: 'alice-example' },
  defaultAccount: 'alice-example',
  templatesDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site-templates'),
}
