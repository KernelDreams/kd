/**
 * nunjucks без кодогенерации (перенесён из backend-nr в):
 * Cloudflare Workers и страницы с CSP без `unsafe-eval` запрещают
 * `new Function`, а `Template._compile` nunjucks строит шаблон именно так —
 * сборка промпта (`mds-template`, ntpl) на краю падала «Code generation from
 * strings disallowed». Выражения редактора (`@kerneldreams/forms`) живут
 * на чужих страницах — тот же режим.
 *
 * Два входа: `installNoEvalNunjucks(nj)` — на весь экземпляр (Worker), и
 * `noEvalTemplate(nj, env, src)` — один шаблон, экземпляр не трогается
 * (страница, где тем же nunjucks рендерят и обычные шаблоны с `include`).
 *
 * Подменяется только компиляция: AST от родного парсера (`parser.parse` с теми
 * же расширениями и опциями среды), рендер — обход AST с рантаймом nunjucks
 * (`contextOrFrameLookup`, `memberLookup`, `callWrap`, `suppressValue`,
 * фильтры, тесты, теги-расширения через `env.getExtension`). Контекст, кадры,
 * колбэки `render` — родные. Семантика — как у `compiler.js` 3.2.x.
 *
 * Не поддержано (ошибка текстом, а не тихий пустой вывод): наследование
 * (`extends`/`block`), `include`/`import`, макросы, `call`, async-фильтры —
 * их нет ни в шаблонах агентов, ни во встроенных.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Any = any

/** Что нужно от модуля nunjucks (передаётся вызывающим: nrd грузит его лениво). */
export interface Nunjucks {
  Template: { prototype: Any }
  parser: { parse(src: string, extensions: Any, opts: Any): Any }
  runtime: Any
  nodes: Any
  lib: Any
}

const COMPARE: Record<string, (a: Any, b: Any) => boolean> = {
  '==': (a, b) => a == b, // eslint-disable-line eqeqeq
  '===': (a, b) => a === b,
  '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
  '!==': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
}

/** Достать «тип» узла AST: имя класса nunjucks (`Output`, `Symbol`…). */
function typeOf(ast: Any): string {
  return ast?.typename ?? ast?.constructor?.name ?? ''
}

class Unsupported extends Error {}

export function createInterpreter(nj: Nunjucks) {
  const rt = nj.runtime

  function evalArgs(list: Any, env: Any, context: Any, frame: Any): Any[] {
    return (list?.children ?? []).map((c: Any) => expr(c, env, context, frame))
  }

  function expr(ast: Any, env: Any, context: Any, frame: Any): Any {
    const t = typeOf(ast)
    switch (t) {
      case 'Literal':
        return ast.value
      case 'Symbol':
        // Кадр (set/for), иначе контекст — как `contextOrFrameLookup` скомпилированного шаблона.
        return rt.contextOrFrameLookup(context, frame, ast.value)
      case 'Group':
        return (ast.children ?? []).reduce((_: Any, c: Any) => expr(c, env, context, frame), undefined)
      case 'Array':
        return (ast.children ?? []).map((c: Any) => expr(c, env, context, frame))
      case 'Dict': {
        const o: Record<string, Any> = {}
        for (const p of ast.children ?? []) o[String(keyOf(p.key, env, context, frame))] = expr(p.value, env, context, frame)
        return o
      }
      case 'KeywordArgs': {
        const o: Record<string, Any> = {}
        for (const p of ast.children ?? []) o[String(keyOf(p.key, env, context, frame))] = expr(p.value, env, context, frame)
        return rt.makeKeywordArgs(o)
      }
      case 'LookupVal':
        return rt.memberLookup(expr(ast.target, env, context, frame), expr(ast.val, env, context, frame))
      case 'FunCall': {
        const fn = expr(ast.name, env, context, frame)
        return rt.callWrap(fn, nameOf(ast.name), context, evalArgs(ast.args, env, context, frame))
      }
      case 'Filter':
        return env.getFilter(ast.name.value).call(context, ...evalArgs(ast.args, env, context, frame))
      case 'InlineIf':
        return expr(ast.cond, env, context, frame) ? expr(ast.body, env, context, frame) : ast.else_ ? expr(ast.else_, env, context, frame) : ''
      case 'Or': {
        const l = expr(ast.left, env, context, frame)
        return l || expr(ast.right, env, context, frame)
      }
      case 'And': {
        const l = expr(ast.left, env, context, frame)
        return l && expr(ast.right, env, context, frame)
      }
      case 'Not':
        return !expr(ast.target, env, context, frame)
      case 'In':
        return rt.inOperator(expr(ast.left, env, context, frame), expr(ast.right, env, context, frame))
      case 'Is': {
        const right = ast.right.name ? ast.right.name.value : ast.right.value
        const args = ast.right.args ? evalArgs(ast.right.args, env, context, frame) : []
        return env.getTest(right).call(context, expr(ast.left, env, context, frame), ...args) === true
      }
      case 'Compare': {
        // Как компилятор: `a < b < c` → `a < b < c` в JS (слева направо).
        let acc = expr(ast.expr, env, context, frame)
        for (const op of ast.ops ?? []) {
          const f = COMPARE[op.type]
          if (!f) throw new Unsupported(`сравнение ${op.type}`)
          acc = f(acc, expr(op.expr, env, context, frame))
        }
        return acc
      }
      case 'Add':
        return expr(ast.left, env, context, frame) + expr(ast.right, env, context, frame)
      case 'Sub':
        return expr(ast.left, env, context, frame) - expr(ast.right, env, context, frame)
      case 'Mul':
        return expr(ast.left, env, context, frame) * expr(ast.right, env, context, frame)
      case 'Div':
        return expr(ast.left, env, context, frame) / expr(ast.right, env, context, frame)
      case 'FloorDiv':
        return Math.floor(expr(ast.left, env, context, frame) / expr(ast.right, env, context, frame))
      case 'Mod':
        return expr(ast.left, env, context, frame) % expr(ast.right, env, context, frame)
      case 'Pow':
        return Math.pow(expr(ast.left, env, context, frame), expr(ast.right, env, context, frame))
      case 'Neg':
        return -expr(ast.target, env, context, frame)
      case 'Pos':
        return +expr(ast.target, env, context, frame)
      case 'Concat':
        return '' + expr(ast.left, env, context, frame) + expr(ast.right, env, context, frame)
      default:
        throw new Unsupported(`выражение ${t || '?'}`)
    }
  }

  function keyOf(ast: Any, env: Any, context: Any, frame: Any): Any {
    // Ключ словаря-символ — его имя (`{a: 1}`), иначе выражение.
    return typeOf(ast) === 'Symbol' ? ast.value : expr(ast, env, context, frame)
  }

  function nameOf(ast: Any): string {
    const t = typeOf(ast)
    if (t === 'Symbol') return ast.value
    if (t === 'LookupVal') return `${nameOf(ast.target)}["${String(ast.val?.value ?? '')}"]`
    return '--expression--'
  }

  function out(env: Any, v: Any, autoescape = true): string {
    return String(rt.suppressValue(v, autoescape && env.opts.autoescape) ?? '')
  }

  function render(ast: Any, env: Any, context: Any, frame: Any): string {
    if (!ast) return ''
    const t = typeOf(ast)
    switch (t) {
      case 'Root':
      case 'NodeList': {
        let s = ''
        for (const c of ast.children ?? []) s += render(c, env, context, frame)
        return s
      }
      case 'Output': {
        let s = ''
        for (const c of ast.children ?? []) {
          if (typeOf(c) === 'TemplateData') s += c.value ?? ''
          else s += out(env, expr(c, env, context, frame))
        }
        return s
      }
      case 'TemplateData':
        return ast.value ?? ''
      case 'If':
      case 'IfAsync':
        return expr(ast.cond, env, context, frame) ? render(ast.body, env, context, frame) : render(ast.else_, env, context, frame)
      case 'Set': {
        const value = ast.value ? expr(ast.value, env, context, frame) : render(ast.body, env, context, frame)
        for (const target of ast.targets ?? []) {
          const name = target.value
          frame.set(name, value, true)
          if (frame.topLevel) {
            context.setVariable(name, value)
            if (name.charAt(0) !== '_') context.addExport(name, value)
          }
        }
        return ''
      }
      case 'Capture':
        return render(ast.body, env, context, frame)
      case 'For':
      case 'AsyncEach':
      case 'AsyncAll':
        return renderFor(ast, env, context, frame)
      case 'CallExtension':
      case 'CallExtensionAsync': {
        const args = evalArgs(ast.args, env, context, frame)
        const contents = (ast.contentArgs ?? []).map((arg: Any) =>
          arg
            ? (cb?: (err: Any, res?: string) => void) => {
                const s = render(arg, env, context, frame)
                if (cb) cb(null, s)
                return s
              }
            : null,
        )
        const ext = env.getExtension(ast.extName)
        const v = ext[ast.prop](context, ...args, ...contents)
        return out(env, v, typeof ast.autoescape === 'boolean' ? ast.autoescape : true)
      }
      default:
        throw new Unsupported(`узел ${t || '?'}`)
    }
  }

  function renderFor(ast: Any, env: Any, context: Any, parent: Any): string {
    const frame = parent.push()
    const raw = expr(ast.arr, env, context, frame)
    let s = ''
    let count = 0
    const bind = (i: number, len: number): void => {
      frame.set('loop.index', i + 1)
      frame.set('loop.index0', i)
      frame.set('loop.revindex', len - i)
      frame.set('loop.revindex0', len - i - 1)
      frame.set('loop.first', i === 0)
      frame.set('loop.last', i === len - 1)
      frame.set('loop.length', len)
    }
    if (raw) {
      const arr = rt.fromIterator(raw)
      const many = typeOf(ast.name) === 'Array'
      const names: string[] = many ? ast.name.children.map((c: Any) => c.value) : [ast.name.value]
      if (rt.isArray(arr)) {
        arr.forEach((item: Any, i: number) => {
          if (many) names.forEach((n, u) => frame.set(n, item[u]))
          else frame.set(names[0]!, item)
          bind(i, arr.length)
          s += render(ast.body, env, context, frame)
          count++
        })
      } else {
        // Объект: `for k, v in obj` — ключ и значение; `for v in obj` — значения (как runtime).
        const keys = Object.keys(arr)
        keys.forEach((k, i) => {
          if (many) {
            frame.set(names[0]!, k)
            if (names[1] !== undefined) frame.set(names[1], arr[k])
          } else frame.set(names[0]!, arr[k])
          bind(i, keys.length)
          s += render(ast.body, env, context, frame)
          count++
        })
      }
    }
    if (!count && ast.else_) s += render(ast.else_, env, context, frame)
    return s
  }

  return { render, expr }
}

/** `_compile` без кодогенерации для шаблона `tmpl` (AST — родным парсером среды). */
function compileNoEval(nj: Nunjucks, interp: ReturnType<typeof createInterpreter>, tmpl: Any): void {
  if (tmpl.env.asyncFilters?.length) throw new Error('nunjucks без кодогенерации: async-фильтры не поддержаны')
  const ast = nj.parser.parse(tmpl.tmplStr, tmpl.env.extensionsList, tmpl.env.opts)
  const root = (env: Any, context: Any, frame: Any, _runtime: Any, cb: (err: Any, res?: string) => void): void => {
    let res: string
    try {
      res = interp.render(ast, env, context, frame)
    } catch (e) {
      cb(e instanceof Unsupported ? new Error(`nunjucks без кодогенерации: ${e.message} не поддержан`) : e)
      return
    }
    cb(null, res)
  }
  tmpl.blocks = {}
  tmpl.rootRenderFunc = root
  tmpl.compiled = true
}

const interpreters = new WeakMap<object, ReturnType<typeof createInterpreter>>()
function interpreterOf(nj: Nunjucks): ReturnType<typeof createInterpreter> {
  let i = interpreters.get(nj as object)
  if (!i) interpreters.set(nj as object, (i = createInterpreter(nj)))
  return i
}

/**
 * Поставить рендер без `new Function` в `Template` этого экземпляра nunjucks.
 * Идемпотентно; предкомпилированные шаблоны (`tmplProps`) — как были.
 */
export function installNoEvalNunjucks(nj: Nunjucks): void {
  const proto = nj.Template.prototype
  if (proto.__nrNoEval) return
  const original = proto._compile
  const interp = interpreterOf(nj)
  proto._compile = function (this: Any) {
    if (this.tmplProps) return original.call(this)
    compileNoEval(nj, interp, this)
  }
  proto.__nrNoEval = true
}

/**
 * Один шаблон без кодогенерации: `Template` среды `env` с подменённым `_compile`
 * только у этого экземпляра. `render(ctx)` — синхронный, как у родного.
 */
export function noEvalTemplate(nj: Nunjucks, env: Any, src: string, path?: string): { render(ctx?: object): string } {
  const Template = (nj as Any).Template
  const tmpl = new Template(src, env, path)
  const interp = interpreterOf(nj)
  tmpl._compile = () => compileNoEval(nj, interp, tmpl)
  return tmpl
}
