// Виджет-артефакт (spec §4): поле рисует iframe. Провод — мост v2 артефактов nrchat
// (`plugins/artifacts/bridge.ts`): гость шлёт `{__exz: 'hello'}` и `{__exz: 'req', id, method, args}`,
// хозяин отвечает `{__exz: 'res', id, result}` и пушит `{__exz: 'host-ev', event, payload}`.
// Канал `widget`: `host-ev widget {value, props, path, theme}` (init и каждое обновление);
// `widget.change(value)` — команда `object.set` пути, `widget.size(height)` — высота кадра.
//
// Вне nrchat (`srcdoc` без prelude артефактов) пакет кладёт свой `WIDGET_PRELUDE` — тот же
// `__host.widget`. Песочница — как у артефакта (`allow-same-origin`), строгая — опция.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WidgetComponent, WidgetProps } from './widgets.js'

export interface FrameSource {
  src?: string
  srcdoc?: string
  /** `strict` — без `allow-same-origin` (spec §4, `$widget-sandbox: strict`). */
  sandbox?: 'default' | 'strict'
}

/** `__host.widget` для кадра без prelude хозяина: onInit / change / size по проводу моста v2. */
export const WIDGET_PRELUDE = `<script>(function(){
var H=window.__host=window.__host||{};if(H.widget)return;
var seq=0,inits=[],last=null,wait={};
function post(m){parent.postMessage(m,'*')}
function req(method,args){var id=++seq;post({__exz:'req',id:id,method:method,args:args});return new Promise(function(r){wait[id]=r})}
addEventListener('message',function(e){var m=e.data;if(!m||typeof m!=='object')return;
if(m.__exz==='res'&&wait[m.id]){wait[m.id](m.result);delete wait[m.id];return}
if(m.__exz==='host-ev'&&m.event==='widget'){last=m.payload;inits.forEach(function(f){try{f(last)}catch(err){post({__exz:'error',error:{message:String(err&&err.message||err)}})}})}});
H.widget={onInit:function(f){inits.push(f);if(last)f(last)},change:function(v){return req('widget.change',[v])},size:function(h){return req('widget.size',[h])}};
function fit(){var h=document.documentElement.scrollHeight;if(h)H.widget.size(h)}
addEventListener('load',function(){post({__exz:'hello'});fit();if(window.ResizeObserver)new ResizeObserver(fit).observe(document.documentElement)});
})()</script>`

/** Добавить prelude в документ кадра (если `__host.widget` там ещё не заведён). */
export function withPrelude(srcdoc: string): string {
  if (srcdoc.includes('__host.widget=') || srcdoc.includes('WIDGET_PRELUDE')) return srcdoc
  const at = srcdoc.search(/<head[^>]*>/i)
  if (at >= 0) {
    const end = srcdoc.indexOf('>', at) + 1
    return srcdoc.slice(0, end) + WIDGET_PRELUDE + srcdoc.slice(end)
  }
  return WIDGET_PRELUDE + srcdoc
}

/** Снимок темы для кадра: режим и токены `--nr-*` хозяина. */
export function themeSnapshot(el: Element = document.documentElement): { mode: string; vars: Record<string, string> } {
  const cs = getComputedStyle(el)
  const vars: Record<string, string> = {}
  for (const k of ['--nr-bg', '--nr-surface', '--nr-raised', '--nr-fg', '--nr-muted', '--nr-line', '--nr-accent', '--nr-accent-fg', '--nr-ok', '--nr-error', '--nr-font-ui', '--nr-font-body', '--nr-radius']) {
    const v = cs.getPropertyValue(k).trim()
    if (v) vars[k] = v
  }
  return { mode: (document.documentElement as HTMLElement).dataset.mode ?? 'light', vars }
}

export function FrameWidget({ source, ...p }: WidgetProps & { source: FrameSource }): ReactNode {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(48)
  const latest = useRef(p)
  latest.current = p
  const payload = (): unknown => ({ value: latest.current.value, props: latest.current.props, path: latest.current.path, readOnly: latest.current.readOnly, theme: themeSnapshot() })
  const send = (): void => ref.current?.contentWindow?.postMessage({ __exz: 'host-ev', event: 'widget', payload: payload() }, '*')

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const frame = ref.current
      if (!frame || e.source !== frame.contentWindow) return
      const m = e.data as { __exz?: string; id?: number; method?: string; args?: unknown[] } | null
      if (!m || typeof m !== 'object') return
      if (m.__exz === 'hello') return send()
      if (m.__exz !== 'req') return
      const reply = (result: unknown): void => frame.contentWindow?.postMessage({ __exz: 'res', id: m.id, result }, '*')
      if (m.method === 'widget.change') {
        if (latest.current.readOnly) return reply({ ok: false, error: 'read-only' })
        latest.current.onChange(m.args?.[0])
        return reply({ ok: true, value: null })
      }
      if (m.method === 'widget.size') {
        const h = Number(m.args?.[0])
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(2000, Math.ceil(h)))
        return reply({ ok: true, value: null })
      }
      reply({ ok: false, error: `unknown bridge method: ${m.method}` })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Каждое новое значение/props — кадру (undo, правка из другого вида).
  useEffect(send, [p.value, p.props, p.readOnly])

  const sandbox = source.sandbox === 'strict' ? 'allow-scripts' : 'allow-scripts allow-same-origin allow-forms allow-popups'
  return (
    <iframe
      ref={ref}
      data-testid="oe-frame"
      data-path={p.path}
      title={p.path}
      sandbox={sandbox}
      {...(source.srcdoc !== undefined ? { srcDoc: withPrelude(source.srcdoc) } : { src: source.src })}
      style={{ height }}
      className="w-full rounded-nr border border-nr-line-soft bg-transparent"
    />
  )
}

/** Компонент виджета из кадра — для `widgets` <ObjectEditor> или `component` в каталоге. */
export function frameWidget(source: FrameSource): WidgetComponent {
  const W = (p: WidgetProps): ReactNode => <FrameWidget {...p} source={source} />
  W.displayName = 'FrameWidget'
  return W
}
