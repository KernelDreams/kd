/**
 * Шаблоны `artifact_init` (artifacts-spec §6): `html` | `jsx` | `jsx+service`.
 * Минимальные и рабочие сразу: finalize на свежем шаблоне проходит без правок.
 *
 * `jsx` — скелет редактора данных сессии: `lib/session.js` с хуками
* `useSessionMeta()` (подписка + запись через `__host.session`),
 * право `session` с чтением меты и персон. Сессия не нужна — удалить
 * `lib/session.js`, импорт и `session` из `$uses`.
 *
 * `jsx+skins` — скелет редактора тем nrchat на `__host.skins`
 * (`$uses: $[skins]`): список скинов, переменные по группам контракта,
 * живое превью, «сохранить как», «применить». Полный эталон — demo/skin-editor.
 */

export type TemplateName = 'html' | 'jsx' | 'jsx+service' | 'jsx+skins' | 'stand'
export const TEMPLATES: readonly TemplateName[] = ['html', 'jsx', 'jsx+service', 'jsx+skins', 'stand']

/**
 * `stand` — макет вида на ките nrchat: компоненты `@kerneldreams/kit` (сборка `src/core/ui`), роли
 * (`nr-panel`, `nr-row`, `nr-node`…) и токены `--nr-*`; панель стенда меняет скин, режим, размер и плотность на месте.
 * Своих цветов, рамок, теней и шрифтов в макете нет — только кит: макет принимается сразу в скинах.
 */
const STAND_JSX = `import { useState } from 'react'
import { Button, Field, PropList, Section, Select, mountStand } from '@kerneldreams/kit'

// Макет __TITLE__: раскладка — свой CSS (layout.css.js) только про сетку и размеры; вид — роли и компоненты кита.
import './layout.css.js'

function App() {
  const [kind, setKind] = useState('a')
  return (
    <div className="mk-shell">
      <aside className="nr-panel mk-side">
        <div className="nr-panel-head">Файлы</div>
        {['assets', 'bots', 'worlds'].map((name) => (
          <div key={name} className="nr-row mk-row" data-selected={name === 'bots'}>{name}</div>
        ))}
      </aside>
      <main className="nr-canvas mk-stage">
        <div className="nr-node mk-node" data-selected="true">
          <div className="nr-node-head">Нода <span className="nr-pin" data-dir="out" data-filled="true" /></div>
          <div className="nr-node-body">роль nr-node, пин nr-pin</div>
        </div>
      </main>
      <aside className="nr-panel mk-side">
        <div className="nr-panel-head">Инспектор</div>
        <Section title="Свойства">
          <Field label="Вид">
            <Select options={[{ value: 'a', label: 'Первый' }, { value: 'b', label: 'Второй' }]} value={kind} onChange={setKind} />
          </Field>
          <PropList items={[{ key: 'id', value: 'node-1', kind: 'id' }, { key: 'версия', value: 3 }]} />
        </Section>
        <Button variant="primary">Сохранить</Button>
      </aside>
    </div>
  )
}

mountStand(App, { title: '__TITLE__' })
`

const STAND_LAYOUT = `/* Только сетка и размеры: цвет, рамка, тень и шрифт — у кита и скина. */
.mk-shell { display: grid; grid-template-columns: 220px 1fr 300px; height: 100%; gap: var(--nr-panel-gap); }
.mk-side { display: flex; flex-direction: column; gap: var(--nr-space-3); padding-bottom: var(--nr-space-4); min-height: 0; }
.mk-row { padding: var(--nr-space-2) var(--nr-space-4); margin-inline: var(--nr-space-3); }
.mk-stage { position: relative; min-width: 0; }
.mk-node { position: absolute; left: 80px; top: 80px; width: 220px; }
`

const STYLE = `:root { color-scheme: light dark; }
body { margin: 0; padding: 16px; font: var(--nr-text-body, 14px)/1.5 var(--nr-font-body, system-ui, sans-serif); color: var(--nr-fg, #1c2230); background: var(--nr-bg, #fff); }
button { font: inherit; padding: 4px 12px; border: 1px solid var(--nr-line, #d3d7de); border-radius: 6px; background: var(--nr-surface, #fff); color: inherit; cursor: pointer; }
.muted { color: var(--nr-muted, #6b7280); font-size: 0.85em; }
.error { color: #b42318; }
`

export function templateFiles(template: TemplateName, title: string): Record<string, string> {
  const manifest = (uses: string, extra = ''): string => `$title: ${title}\n$uses: $[${uses}]\n${extra}`
  if (template === 'html') {
    return {
      'meta.mdz': manifest(''),
      'index.html': `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <h1>${title}</h1>
    <p class="muted" id="ctx">…</p>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`,
      'app.js': `// ${title}: всё, что умеет хост, — через window.__host (профиль artifact-profile.md).
const ctx = await window.__host.getContext()
document.getElementById('ctx').textContent = \`\${ctx.artifactId} · v\${ctx.version}\`
`,
      'style.css': STYLE,
    }
  }
  if (template === 'stand') {
    return {
      'meta.mdz': manifest(''),
      'index.jsx': STAND_JSX.replace(/__TITLE__/g, title),
      'layout.css.js': `const style = document.createElement('style')\nstyle.textContent = ${JSON.stringify(STAND_LAYOUT)}\ndocument.head.append(style)\n`,
    }
  }
  if (template === 'jsx+skins') {
    return {
      'meta.mdz': manifest('skins'),
      'index.jsx': SKINS_JSX.replace(/__TITLE__/g, title),
      'style.css.js': `const style = document.createElement('style')\nstyle.textContent = ${JSON.stringify(STYLE + SKINS_STYLE)}\ndocument.head.append(style)\n`,
    }
  }
  const withSession = template === 'jsx'
  const jsx = `import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css.js'
${withSession ? "import { useSessionMeta } from './lib/session.js'\n" : ''}
function App() {
  const [ctx, setCtx] = useState(null)
  const [out, setOut] = useState('')
${withSession ? '  // Данные сессии чата: meta — документ, set(путь, значение) пишет — и сразу видно в чате.\n  const { meta, personas, error } = useSessionMeta()\n' : ''}  useEffect(() => {
    window.__host.getContext().then(setCtx)
  }, [])
${
  template === 'jsx+service'
    ? `  async function ping() {
    const r = await window.__host.service.call('ping', { at: Date.now() })
    setOut(r.ok ? JSON.stringify(r.value) : r.error)
  }
`
    : ''
}  return (
    <main>
      <h1>${title}</h1>
      <p className="muted">{ctx ? \`\${ctx.artifactId} · v\${ctx.version}\` : '…'}</p>
${template === 'jsx+service' ? `      <button onClick={ping}>ping service</button>\n      <pre>{out}</pre>\n` : ''}${
    withSession
      ? `      <p className="muted">{ctx?.session ? \`сессия: \${ctx.session.title || ctx.session.id}\` : 'нет сессии'} · персон: {personas?.personas.length ?? 0}</p>\n      {error && <p className="error">{error}</p>}\n      <pre>{meta ? JSON.stringify(meta.prompt ?? {}, null, 2) : '…'}</pre>\n`
      : ''
  }    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
`
  const files: Record<string, string> = {
    'meta.mdz': withSession
      ? manifest('session', '$session-read: meta, personas\n$session-write: meta, personas\n')
      : manifest(template === 'jsx+service' ? 'service' : ''),
    'index.jsx': jsx,
    'style.css.js': `const style = document.createElement('style')\nstyle.textContent = ${JSON.stringify(STYLE)}\ndocument.head.append(style)\n`,
  }
  if (withSession) files['lib/session.js'] = SESSION_LIB
  if (template === 'jsx+service') {
    files['service.ts'] = `/**
 * Node-половина артефакта: полный Node (fs, child_process, fetch), без прав моста.
 * meta.on(cmd, handler) — RPC для __host.service.call; meta.emit(event, payload) — push для __host.service.on.
 */
export default async function (ctx: unknown, meta: any) {
  meta.on('ping', (params: unknown) => ({ pong: params, dataDir: meta.dataDir }))
  await meta.closed
}
`
  }
  return files
}

/** `lib/session.js` шаблона `jsx`: хуки над `__host.session`. */
export const SESSION_LIB = `// Данные сессии чата для React: подписка + запись через window.__host.session.
// Права: $uses: $[session], $session-read: meta, personas; запись — $session-write.
import { useCallback, useEffect, useState } from 'react'

const session = window.__host.session

/**
 * Мета сессии с подпиской: { meta, hash, personas, sessionId, title, error, set, setPersona }.
 * set('prompt.pre', текст) — частичная запись по пути (null удаляет ключ); конфликт
 * (мету поменяли в чате между чтением и записью) — error, свежая мета уже в meta.
 */
export function useSessionMeta() {
  const [state, setState] = useState({ meta: null, hash: null, personas: null, sessionId: null, title: null })
  const [error, setError] = useState(null)
  useEffect(() => session.meta.on((e) => setState(e)), [])
  const set = useCallback(
    async (path, value) => {
      const r = await session.meta.set(path, value, state.hash ? { ifHash: state.hash } : undefined)
      setError(r.ok ? null : r.error)
      return r
    },
    [state.hash],
  )
  const setPersona = useCallback(async (persona) => {
    const r = await session.personas.set(persona)
    setError(r.ok ? null : r.error)
    return r
  }, [])
  return { ...state, error, set, setPersona }
}
`

const SKINS_STYLE = `.app { display: flex; gap: 16px; }
.list { width: 160px; display: flex; flex-direction: column; gap: 2px; }
.list button { text-align: left; border: 0; background: transparent; }
.list button.on { background: var(--nr-line-soft, #eee); }
.vars { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; gap: 6px; align-items: center; }
.row code { width: 140px; }
`

/** `index.jsx` шаблона `jsx+skins`: редактор тем на __host.skins. */
const SKINS_JSX = `// __TITLE__: редактор тем nrchat. Скин — данные с контрактом: только --nr-* переменные
// (skins.contract() — список с описаниями). Правки — отличиями от базы (base), проверка —
// skins.check, живое превью поверх nrchat — skins.preview, запись — skins.save, выбор — skins.apply.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css.js'

const skins = window.__host.skins

function App() {
  const [list, setList] = useState([])
  const [tokens, setTokens] = useState([])
  const [base, setBase] = useState('parchment')
  const [vars, setVars] = useState({})
  const [mode, setMode] = useState('light')
  const [edits, setEdits] = useState({})
  const [name, setName] = useState('my')
  const [note, setNote] = useState('')

  useEffect(() => {
    skins.list().then((r) => r.ok && setList(r.value))
    skins.contract().then((r) => r.ok && setTokens(r.value.tokens.filter((t) => ['bg', 'text', 'accent', 'fonts'].includes(t.group))))
    window.__host.getContext().then((c) => c?.theme?.mode && setMode(c.theme.mode))
  }, [])
  useEffect(() => {
    skins.get(base).then((r) => r.ok && setVars({ ...r.value.vars.common, ...r.value.vars[mode] }))
    setEdits({})
  }, [base, mode])

  // Цвета — в режиме, остальное — общее; только отличия от базы.
  const css = () => {
    const kind = (n) => tokens.find((t) => t.name === n)?.kind
    const pick = (f) => Object.entries(edits).filter(([n]) => f(kind(n))).map(([n, v]) => \`  \${n}: \${v};\`).join('\\n')
    return \`[data-skin="\${name}"][data-mode="\${mode}"] {\\n\${pick((k) => k === 'color')}\\n}\\n[data-skin="\${name}"] {\\n\${pick((k) => k !== 'color')}\\n}\\n\`
  }
  useEffect(() => {
    if (!Object.keys(edits).length) return void skins.preview(null)
    const t = setTimeout(async () => {
      const r = await skins.preview(name, css(), { base })
      setNote(r.ok ? 'превью в nrchat' : r.error)
    }, 250)
    return () => clearTimeout(t)
  }, [edits, name, base, mode])

  async function save() {
    const r = await skins.save(name, css(), { base })
    const v = r.ok ? r.value : { ok: false, errors: [r.error] }
    setNote(v.ok ? 'сохранён ' + name : (v.errors || []).join('; '))
    if (v.ok) skins.list().then((l) => l.ok && setList(l.value))
  }

  return (
    <main className="app">
      <div className="list">
        {list.map((s) => (
          <button key={s.name} className={s.name === base ? 'on' : ''} disabled={!!s.error} title={s.error || s.description} onClick={() => setBase(s.name)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="vars">
        <h1>__TITLE__</h1>
        <div className="row">
          база: <b>{base}</b> · режим:
          <button onClick={() => setMode(mode === 'light' ? 'dark' : 'light')}>{mode}</button>
        </div>
        {tokens.map((t) => (
          <label className="row" key={t.name} title={t.description}>
            <code>{t.name}</code>
            {t.kind === 'color' && /^#[0-9a-f]{6}$/i.test(edits[t.name] ?? vars[t.name] ?? '') ? (
              <input type="color" value={edits[t.name] ?? vars[t.name]} onChange={(e) => setEdits({ ...edits, [t.name]: e.target.value })} />
            ) : null}
            <input value={edits[t.name] ?? vars[t.name] ?? ''} onChange={(e) => setEdits({ ...edits, [t.name]: e.target.value })} />
          </label>
        ))}
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value.trim())} />
          <button onClick={save}>Сохранить как {name}</button>
          <button onClick={() => skins.apply(name).then((r) => setNote(r.ok ? 'применён ' + name : r.error))}>Применить</button>
        </div>
        <p className="muted">{note}</p>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
`
