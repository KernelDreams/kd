/**
 * Стили Shadow DOM. Тема — CSS-переменные на хосте: страница перекрывает их
 * снаружи (`nr-chat { --nr-accent: … }`); светлая/тёмная — по
 * `prefers-color-scheme` или атрибуту `theme="light|dark"`.
 */

export const CSS = `
:host {
  --nr-bg: #ffffff;
  --nr-fg: #1d1d1f;
  --nr-muted: #6e6e73;
  --nr-border: #e3e3e8;
  --nr-surface: #f5f5f7;
  --nr-user-bg: #e8f0fe;
  --nr-accent: #2f6fed;
  --nr-accent-fg: #ffffff;
  --nr-danger: #c62828;
  --nr-ok: #2e7d32;
  --nr-code-bg: #f0f0f3;
  --nr-radius: 10px;
  --nr-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --nr-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex;
  flex-direction: column;
  min-height: 240px;
  height: 100%;
  box-sizing: border-box;
  background: var(--nr-bg);
  color: var(--nr-fg);
  font: 14px/1.45 var(--nr-font);
  border: 1px solid var(--nr-border);
  border-radius: var(--nr-radius);
  overflow: hidden;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --nr-bg: #1c1c1e; --nr-fg: #f2f2f7; --nr-muted: #a1a1a6; --nr-border: #38383a;
    --nr-surface: #2c2c2e; --nr-user-bg: #23324d; --nr-accent: #5b8cff; --nr-code-bg: #2a2a2d;
    --nr-danger: #ff6b6b; --nr-ok: #6bd17a; color-scheme: dark;
  }
}
:host([theme="dark"]) {
  --nr-bg: #1c1c1e; --nr-fg: #f2f2f7; --nr-muted: #a1a1a6; --nr-border: #38383a;
  --nr-surface: #2c2c2e; --nr-user-bg: #23324d; --nr-accent: #5b8cff; --nr-code-bg: #2a2a2d;
  --nr-danger: #ff6b6b; --nr-ok: #6bd17a; color-scheme: dark;
}
* { box-sizing: border-box; }
.feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.empty { color: var(--nr-muted); text-align: center; margin: auto; }
.msg { max-width: 100%; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--nr-user-bg); border-radius: var(--nr-radius); padding: 8px 12px; max-width: 85%; }
.msg.assistant { align-self: stretch; }
.msg.error { color: var(--nr-danger); border-left: 3px solid var(--nr-danger); padding: 4px 10px; }
.msg.live .text:last-child::after { content: "▍"; color: var(--nr-muted); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.text p { margin: 0 0 6px; }
.text p:last-child { margin-bottom: 0; }
.text ul, .text ol { margin: 4px 0 6px; padding-left: 22px; }
.text h3, .text h4, .text h5, .text h6 { margin: 8px 0 4px; font-size: 1em; }
.text a { color: var(--nr-accent); }
code { font-family: var(--nr-mono); font-size: 0.92em; background: var(--nr-code-bg); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--nr-code-bg); padding: 8px 10px; border-radius: 8px; overflow-x: auto; margin: 6px 0; }
pre code { background: none; padding: 0; white-space: pre; }
details.thinking { color: var(--nr-muted); margin: 2px 0 6px; }
details.thinking summary { cursor: pointer; font-size: 12px; }
details.thinking .body { white-space: pre-wrap; font-size: 13px; padding: 4px 0 0 12px; border-left: 2px solid var(--nr-border); }
.card { border: 1px solid var(--nr-border); background: var(--nr-surface); border-radius: 8px; margin: 6px 0; font-size: 13px; }
.card > summary, .card > .head { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; list-style: none; }
.card > summary::-webkit-details-marker { display: none; }
.card .name { font-family: var(--nr-mono); font-weight: 600; }
.card .arg { color: var(--nr-muted); font-family: var(--nr-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.card .status { font-size: 11px; color: var(--nr-muted); white-space: nowrap; }
.card .status.done { color: var(--nr-ok); }
.card .status.error { color: var(--nr-danger); }
.card .status.running::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; border: 2px solid var(--nr-muted); border-top-color: transparent; animation: spin 0.8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
.card .body { padding: 0 10px 8px; }
.card pre { margin: 4px 0 0; max-height: 240px; font-size: 12px; }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--nr-accent); }
.ask { border-color: var(--nr-accent); }
.ask .q { padding: 8px 10px 4px; font-weight: 600; }
.ask .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px 10px; }
.ask .answered { padding: 4px 10px 8px; color: var(--nr-muted); }
.ask textarea { flex: 1; min-width: 160px; }
button { font: inherit; border: 1px solid var(--nr-border); background: var(--nr-bg); color: var(--nr-fg); border-radius: 7px; padding: 5px 12px; cursor: pointer; }
button:hover { border-color: var(--nr-accent); }
button.primary, button.allow { background: var(--nr-accent); color: var(--nr-accent-fg); border-color: var(--nr-accent); }
button.deny { color: var(--nr-danger); }
button:disabled { opacity: 0.5; cursor: default; }
.composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--nr-border); align-items: flex-end; }
textarea { flex: 1; resize: none; font: inherit; color: var(--nr-fg); background: var(--nr-bg); border: 1px solid var(--nr-border); border-radius: 8px; padding: 7px 10px; min-height: 36px; max-height: 160px; outline: none; }
textarea:focus { border-color: var(--nr-accent); }
.status-line { padding: 4px 12px; font-size: 12px; color: var(--nr-muted); border-top: 1px solid var(--nr-border); }
.status-line:empty { display: none; }
`
