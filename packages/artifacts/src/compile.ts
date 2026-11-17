/**
 * JSX-пайплайн (artifacts-spec §2): `index.jsx` и его относительные импорты
 * компилирует бэкенд нативным esbuild — у автора ни node_modules, ни сборки.
 * Голые импорты закрыты import map на вендорный React хоста; любой другой
 * голый импорт — ошибка с понятным текстом, а не 404 в рантайме.
 *
 * Кэш — в памяти, ключ — папка, свежесть — mtime каждого входного файла.
 */

import { statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'

/** Голый импорт → файл вендора хоста (`/__vendor/<файл>`). */
export const VENDORED: Readonly<Record<string, string>> = {
  react: 'react.js',
  'react-dom': 'react-dom.js',
  'react-dom/client': 'react-dom-client.js',
  'react/jsx-runtime': 'react-jsx-runtime.js',
}

/**
 * Кит UI nrchat: голый импорт `@kerneldreams/kit` — сборка `src/core/ui` встраивающего хоста (`__kit/nr-kit.js`,
 * import map), если хост её передал (`ArtifactHostOpts.kit`).
 */
export const KIT_IMPORT = '@kerneldreams/kit'
export const KIT_FILES = { js: 'nr-kit.js', css: 'nr-kit.css', version: 'version.txt' } as const

/** Голый импорт, который даёт хост: вендорный React или кит. */
export const isHostImport = (spec: string): boolean => spec in VENDORED || spec === KIT_IMPORT

export class CompileError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message)
    this.name = 'CompileError'
  }
}

interface Built {
  code: string
  inputs: Map<string, number>
}

const cache = new Map<string, Built>()

const mtime = (file: string): number => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return -1
  }
}

const isRelative = (s: string): boolean => s.startsWith('./') || s.startsWith('../') || s.startsWith('/')

/** Плагин: голые импорты — только вендорные (внешние), остальное — ошибка. */
function guard(dir: string): esbuild.Plugin {
  return {
    name: 'artifact-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point' || isRelative(args.path)) return undefined
        if (/^https?:\/\//.test(args.path)) return { path: args.path, external: true }
        if (isHostImport(args.path)) return { path: args.path, external: true }
        return {
          errors: [
            {
              text:
                `голый импорт "${args.path}" не резолвится: хост вендорит только ${[...Object.keys(VENDORED), KIT_IMPORT].join(', ')}. ` +
                `Используй относительный импорт или положи модуль в папку артефакта.`,
            },
          ],
        }
      })
      build.onResolve({ filter: /^\// }, (args) =>
        args.kind === 'entry-point'
          ? undefined
          : { errors: [{ text: `абсолютный импорт "${args.path}" — только относительные пути внутри ${dir}` }] },
      )
    },
  }
}

const LOADERS: Record<string, esbuild.Loader> = { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.json': 'json', '.css': 'text', '.txt': 'text', '.svg': 'text' }

function formatMessages(dir: string, msgs: esbuild.Message[]): string[] {
  return msgs.map((m) => {
    const loc = m.location ? `${relative(dir, resolve(dir, m.location.file))}:${m.location.line}:${m.location.column}: ` : ''
    return `${loc}${m.text}`
  })
}

/** Собрать `index.jsx` папки в один ESM-модуль. Ошибки — {@link CompileError}. */
export async function compileJsx(dir: string, entry = 'index.jsx'): Promise<string> {
  const key = resolve(dir, entry)
  const hit = cache.get(key)
  if (hit && [...hit.inputs].every(([f, t]) => mtime(f) === t)) return hit.code

  let result: esbuild.BuildResult<{ write: false; metafile: true }>
  try {
    result = await esbuild.build({
      entryPoints: [key],
      absWorkingDir: resolve(dir),
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      loader: LOADERS,
      sourcemap: 'inline',
      logLevel: 'silent',
      plugins: [guard(dir)],
    })
  } catch (e) {
    const errors = formatMessages(dir, (e as esbuild.BuildFailure).errors ?? [])
    throw new CompileError(errors.length ? errors.join('\n') : (e as Error).message, errors)
  }
  const code = result.outputFiles[0]?.text ?? ''
  const inputs = new Map<string, number>()
  for (const f of Object.keys(result.metafile.inputs)) {
    const abs = resolve(dir, f)
    inputs.set(abs, mtime(abs))
  }
  cache.set(key, { code, inputs })
  return code
}

/** Один `.jsx` без бандла — для html-входа, импортирующего `.jsx` модулем. */
export async function transformJsx(source: string, file: string): Promise<string> {
  const out = await esbuild.transform(source, { loader: 'jsx', jsx: 'automatic', format: 'esm', target: 'es2022', sourcefile: file })
  return out.code
}

export function clearCompileCache(dir?: string): void {
  if (!dir) return cache.clear()
  const prefix = resolve(dir)
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

/** Абсолютный путь вендора в dist пакета (собран `scripts/assets.mjs`). */
export function vendorFile(assetsDir: string, name: string): string {
  return join(assetsDir, 'vendor', name)
}
