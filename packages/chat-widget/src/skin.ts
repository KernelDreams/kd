/**
 * Скин nrchat в виджете (skin-spec §8): `<nr-chat skin="scene">` берёт
 * тот же проверенный CSS, что фронт, — `GET <backend>/skins/<имя>.css` — и
 * переводит его в Shadow DOM:
 *
 *   [data-skin="x"][data-mode="m"]  → :host([data-nr-mode="m"])
 *   [data-skin="x"]                 → :host
 *
 * Элементные правила контракта (`.nr-message[data-role=…]`, `.nr-text em`, …)
 * работают как есть: у ленты виджета те же классы-хуки. Свои переменные виджета
 * (`--nr-border`, `--nr-font`…) выводятся из токенов скина.
 */

/** Переменные виджета из токенов nrchat — после правил скина. */
export const SKIN_BRIDGE_CSS = `
:host([skin]) {
  --nr-border: var(--nr-line);
  --nr-font: var(--nr-font-body, var(--nr-font-ui, system-ui, sans-serif));
  --nr-mono: var(--nr-font-mono, ui-monospace, monospace);
  --nr-danger: var(--nr-error);
  --nr-user-bg: var(--nr-surface);
  --nr-code-bg: var(--nr-surface);
  --nr-radius: var(--nr-radius-lg, 10px);
  background: var(--nr-bg-chat, var(--nr-bg));
  font-size: var(--nr-text-body, 14px);
  line-height: var(--nr-leading-body, 1.45);
}
:host([skin][data-nr-mode="dark"]) { color-scheme: dark; }
:host([skin]) .nr-author { color: var(--nr-author-assistant, var(--nr-accent)); font: 600 0.8em/1.2 var(--nr-font-ui, system-ui, sans-serif); margin-bottom: 2px; }
:host([skin]) .nr-message[data-role="user"] .nr-author { color: var(--nr-author-user, var(--nr-muted)); }
:host([skin]) .nr-text em { color: var(--nr-em, inherit); }
:host([skin]) .text { max-width: var(--nr-measure, none); }
`

/** CSS скина nrchat → правила для Shadow DOM виджета. */
export function shadowSkinCss(css: string, name: string): string {
  const q = `(?:"${name}"|'${name}'|${name})`
  return css
    .replace(new RegExp(`\\[data-skin=${q}\\]\\[data-mode=(?:"(light|dark)"|'(light|dark)'|(light|dark))\\]`, 'g'), (_m, a, b, c) => `:host([data-nr-mode="${a ?? b ?? c}"])`)
    .replace(new RegExp(`\\[data-skin=${q}\\]`, 'g'), ':host')
}

/** Загрузить скин с бэкенда nr (`basePath` уже в `backend`). */
export async function fetchSkin(backend: string, name: string, auth?: string): Promise<string> {
  const res = await fetch(`${backend.replace(/\/+$/, '')}/skins/${encodeURIComponent(name)}.css`, {
    headers: { accept: 'text/css', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg
    } catch {
      /* не Envelope */
    }
    throw new Error(`скин ${name}: ${msg}`)
  }
  return text
}
