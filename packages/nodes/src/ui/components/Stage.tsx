/**
 * Полотно карточек (node-canvas-spec §6, перенесено из вида схемы): слой карточек произвольного
 * вида в координатах полотна (ступень «зарегистрированный компонент» — карточку рисует вид схемы), провода SVG
 * между якорями (`data-anchor` внутри карточек), пан / зум и анимированный переход (зум в карточку). Второй режим
 * пакета рядом с `Canvas` (ноды с портами по реестру): одно полотно, два способа рисовать ноду.
 *
 * Жесты: два пальца по трекпаду и колесо — пан; щипок (ctrl+колесо, в Safari — gesture*) — зум у курсора;
 * перетаскивание пустого места — пан; перетаскивание за `data-drag="<id>"` — двигает карточку;
 * двойной клик по пустому месту — `onBackgroundDoubleClick`.
 * Размеры и якоря меряются по раскладке (offset*), а не по экранному прямоугольнику: анимация зума их не сбивает.
 *
 * Вид — классами `nn-stage*` (структура — `nodes.css`), цвет провода — токены `--nr-wire-*`; скин вида схемы
 * перекрывает их своим CSS.
 */

import { forwardRef, useCallback, useId, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface View {
  x: number
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Wire {
  id: string
  from: string
  to: string
  /** v — сверху вниз (роль премиса → портрет), h — бок в бок, arc — дугой под карточками, s — вбок от пина и сверху в цель. */
  shape: 'v' | 'h' | 'arc' | 's' | 'flow' | 'side'
  kind: string
  now?: boolean
  /** Стрелка на конце `to` (связь двух равных карточек). */
  arrow?: boolean
}

export interface StageHandle {
  fit(ms?: number): void
  zoomToRect(r: Rect, opts?: { ms?: number; pad?: number; maxZoom?: number }): void
  setView(v: View, ms?: number): void
  getView(): View
  /** Вид, при котором прямоугольник вписан (не применяет). */
  viewFor(r: Rect, opts?: { pad?: number; maxZoom?: number }): View
  size(): { w: number; h: number }
  /** Прямоугольник элемента полотна (по `data-fit`-id или якорю) в координатах полотна. */
  rectOf(id: string): Rect | undefined
  /** Точка экрана → координаты полотна и точка внутри окна полотна (для всплывашек). */
  toWorld(clientX: number, clientY: number): { x: number; y: number; local: { x: number; y: number } }
}

/** Где бросили провод или кликнули правой: полотно и окно. */
export interface StagePoint {
  x: number
  y: number
  local: { x: number; y: number }
}

export interface StageProps {
  children: ReactNode
  wires?: Wire[]
  renderWireLabel?: (w: Wire, mid: { x: number; y: number }) => ReactNode
  /** Концы провода: ручки на краях карточек — конец связи перетаскивается на другую карточку. */
  renderWireEnds?: (w: Wire) => { a?: ReactNode; b?: ReactNode } | null
  onBackgroundClick?: () => void
  onBackgroundDoubleClick?: () => void
  onMove?: (id: string, x: number, y: number) => void
  /**
   * Пины: элемент с `data-pin="<id>"`, `data-pin-kind="out" | "in"`, `data-pin-tag="<тип>"`. Потянул от пина —
   * совместимые (тот же тег, другой род) подсвечены (`data-pin-ok`), остальные гаснут; бросил на совместимый — `onConnect`.
   */
  onConnect?: (from: string, to: string) => void
  /** Провод брошен мимо пинов: меню «что сюда поставить» — нода встанет в точку и провод подключится к ней. */
  onDropEmpty?: (from: string, at: StagePoint) => void
  /** Правый клик по пустому месту полотна: меню «что сюда поставить». */
  onBackgroundMenu?: (at: StagePoint) => void
  /** Провод выделяется кликом; Delete / Backspace — `onWireDelete`. */
  onWireDelete?: (id: string) => void
  /** Пересчитать якоря: меняется — значит раскладка поменялась. */
  layoutKey?: string
  className?: string
  minZoom?: number
  maxZoom?: number
  testId?: string
  /**
   * Скин полотна (node-canvas-spec §6): `data-skin` / `data-mode` на корне полотна — токены скина
   * (`:where([data-skin])`) пересчитываются только внутри, скин оболочки не меняется. Нет — полотно наследует скин предка.
   */
  look?: StageLook
}

/** Скин и режим полотна; выбор каскадом настроек — у хоста (nrchat `useCanvasSkin`). */
export interface StageLook {
  skin: string
  mode: 'light' | 'dark'
}

const MIN = 0.2
const MAX = 2.2

function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { x, y }
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { children, wires = [], renderWireLabel, renderWireEnds, onBackgroundClick, onBackgroundDoubleClick, onMove, onConnect, onDropEmpty, onBackgroundMenu, onWireDelete, layoutKey, className, minZoom = MIN, maxZoom = MAX, testId, look },
  ref,
) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const box = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const [view, setViewState] = useState<View>({ x: 0, y: 0, zoom: 0.8 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [anim, setAnim] = useState(0)
  const animTimer = useRef<number | undefined>(undefined)
  const [anchors, setAnchors] = useState<Record<string, { x: number; y: number }>>({})
  const [pull, setPull] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const [pickedWire, setPickedWire] = useState<string | null>(null)

  const apply = useCallback((v: View, ms = 0) => {
    window.clearTimeout(animTimer.current)
    setAnim(ms)
    setViewState(v)
    if (ms) animTimer.current = window.setTimeout(() => setAnim(0), ms + 30)
  }, [])

  const clampZoom = (z: number) => Math.max(minZoom, Math.min(maxZoom, z))

  const rectOf = useCallback((id: string): Rect | undefined => {
    const w = world.current
    if (!w) return undefined
    const el = w.querySelector<HTMLElement>(`[data-fit="${CSS.escape(id)}"], [data-anchor="${CSS.escape(id)}"]`)
    if (!el) return undefined
    const o = offsetIn(el, w)
    return { x: o.x, y: o.y, w: el.offsetWidth, h: el.offsetHeight }
  }, [])

  const bounds = useCallback((): Rect | undefined => {
    const w = world.current
    if (!w) return undefined
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    w.querySelectorAll<HTMLElement>('[data-fit]').forEach((el) => {
      const o = offsetIn(el, w)
      // подпись провода стоит серединой в точке (translate −50 %): offset — её центр, а не край
      if (el.hasAttribute('data-wire-label')) {
        o.x -= el.offsetWidth / 2
        o.y -= el.offsetHeight / 2
      }
      x0 = Math.min(x0, o.x)
      y0 = Math.min(y0, o.y)
      x1 = Math.max(x1, o.x + el.offsetWidth)
      y1 = Math.max(y1, o.y + el.offsetHeight)
    })
    return x0 === Infinity ? undefined : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }, [])

  const viewFor = useCallback(
    (r: Rect, opts: { pad?: number; maxZoom?: number } = {}): View => {
      const el = box.current
      const pad = opts.pad ?? 40
      const W = el?.clientWidth ?? 1200
      const H = el?.clientHeight ?? 800
      const zoom = clampZoom(Math.min((W - pad * 2) / Math.max(r.w, 1), (H - pad * 2) / Math.max(r.h, 1), opts.maxZoom ?? maxZoom))
      return { zoom, x: (W - r.w * zoom) / 2 - r.x * zoom, y: (H - r.h * zoom) / 2 - r.y * zoom }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maxZoom, minZoom],
  )
  const zoomToRect = useCallback(
    (r: Rect, opts: { ms?: number; pad?: number; maxZoom?: number } = {}) => apply(viewFor(r, opts), opts.ms ?? 0),
    [apply, viewFor],
  )

  useImperativeHandle(
    ref,
    () => ({
      fit: (ms = 0) => {
        const b = bounds()
        if (b) zoomToRect(b, { ms, pad: 22, maxZoom: 1.15 })
      },
      zoomToRect,
      setView: (v, ms = 0) => apply(v, ms),
      getView: () => viewRef.current,
      viewFor,
      size: () => ({ w: box.current?.clientWidth ?? 0, h: box.current?.clientHeight ?? 0 }),
      rectOf,
      toWorld: pointAt,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bounds, zoomToRect, apply, rectOf, viewFor],
  )

  function pointAt(cx: number, cy: number): StagePoint {
    const r = box.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const v = viewRef.current
    const local = { x: cx - r.left, y: cy - r.top }
    return { x: (local.x - v.x) / v.zoom, y: (local.y - v.y) / v.zoom, local }
  }

  // якоря проводов — после каждой раскладки и при смене размеров карточек
  const measure = useCallback(() => {
    const w = world.current
    if (!w) return
    const next: Record<string, { x: number; y: number }> = {}
    w.querySelectorAll<HTMLElement>('[data-anchor]').forEach((el) => {
      const o = offsetIn(el, w)
      next[el.dataset.anchor!] = { x: o.x + el.offsetWidth / 2, y: o.y + el.offsetHeight / 2 }
    })
    setAnchors((prev) => {
      const keys = Object.keys(next)
      if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] && Math.abs(prev[k]!.x - next[k]!.x) < 0.5 && Math.abs(prev[k]!.y - next[k]!.y) < 0.5)) return prev
      return next
    })
  }, [])
  useLayoutEffect(measure, [measure, layoutKey, children])
  useEffect(() => {
    const w = world.current
    if (!w || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    w.querySelectorAll('[data-fit]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [measure, layoutKey])

  // колесо / трекпад / щипок
  useEffect(() => {
    const el = box.current
    if (!el) return
    const zoomAt = (factor: number, cx: number, cy: number) => {
      const r = el.getBoundingClientRect()
      const mx = cx - r.left
      const my = cy - r.top
      setAnim(0)
      setViewState((v) => {
        const zoom = clampZoom(v.zoom * factor)
        const k = zoom / v.zoom
        return { zoom, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
      })
    }
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.('[data-scroll]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      else {
        setAnim(0)
        const k = e.deltaMode === 1 ? 16 : 1
        setViewState((v) => ({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k }))
      }
    }
    let gScale = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gScale = 1
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const ge = e as Event & { scale: number; clientX: number; clientY: number }
      zoomAt(ge.scale / gScale, ge.clientX, ge.clientY)
      gScale = ge.scale
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart as EventListener)
    el.addEventListener('gesturechange', onGestureChange as EventListener)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart as EventListener)
      el.removeEventListener('gesturechange', onGestureChange as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minZoom, maxZoom])

  // пан пустым местом и перетаскивание карточек
  // провод от пина: тянем, совместимые пины подсвечены
  const startPull = (e: React.PointerEvent, pin: HTMLElement): void => {
    const el = box.current
    const w = world.current
    if (!el || !w) return
    const from = pin.dataset.pin!
    const kind = pin.dataset.pinKind
    const tag = pin.dataset.pinTag
    const o = offsetIn(pin, w)
    const a = { x: o.x + pin.offsetWidth / 2, y: o.y + pin.offsetHeight / 2 }
    const toWorld = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom }
    }
    const start = { x: e.clientX, y: e.clientY }
    let moved = false
    const mark = (on: boolean) => {
      if (on) el.setAttribute('data-connecting', tag ?? '')
      else el.removeAttribute('data-connecting')
      w.querySelectorAll<HTMLElement>('[data-pin]').forEach((p) => {
        // `data-pin-peer` — пины одного рода соединяются между собой (карточка ↔ карточка: новая связь)
        if (on && p !== pin && p.dataset.pinTag === tag && (p.dataset.pinKind !== kind || (pin.dataset.pinPeer !== undefined && p.dataset.pinPeer !== undefined))) p.setAttribute('data-pin-ok', '')
        else p.removeAttribute('data-pin-ok')
      })
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return
      if (!moved) mark(true)
      moved = true
      setPull({ a, b: toWorld(ev.clientX, ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (!moved) return
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-pin-ok]')
      mark(false)
      setPull(null)
      if (target?.dataset.pin) onConnect?.(from, target.dataset.pin)
      else {
        const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
        // мимо пинов и мимо карточек — в пустое место: «что сюда поставить»
        if (under && box.current?.contains(under) && !under.closest('[data-fit], [data-ui]')) onDropEmpty?.(from, pointAt(ev.clientX, ev.clientY))
      }
      const stop = (ce: MouseEvent) => {
        ce.stopPropagation()
        ce.preventDefault()
        window.removeEventListener('click', stop, true)
      }
      window.addEventListener('click', stop, true)
      window.setTimeout(() => window.removeEventListener('click', stop, true), 0)
    }
    // отменённый жест (родной drag-and-drop, потеря указателя) — провод снимается, подсветка гаснет
    const cancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      mark(false)
      setPull(null)
    }
    // без этого первый провод выделяет текст, а второй, начатый на выделении, браузер уводит в родной drag-and-drop
    e.preventDefault()
    window.getSelection?.()?.removeAllRanges()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  // выделенный провод: Delete / Backspace — удалить, Escape — снять
  useEffect(() => {
    if (!pickedWire) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable]')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        onWireDelete?.(pickedWire)
        setPickedWire(null)
      } else if (e.key === 'Escape') setPickedWire(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickedWire, onWireDelete])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const pin = onConnect ? t.closest<HTMLElement>('[data-pin]') : null
    if (pin) return startPull(e, pin)
    const hit = t.closest<SVGElement>('[data-wire-hit]')
    if (hit) return setPickedWire(hit.getAttribute('data-wire-hit'))
    if (pickedWire) setPickedWire(null)
    if (t.closest('input, textarea, button, select, [data-nodrag]')) return
    const drag = t.closest<HTMLElement>('[data-drag]')
    const onBg = !t.closest('[data-fit], [data-wire-label], [data-ui]')
    if (!drag && !onBg) return
    const start = { x: e.clientX, y: e.clientY }
    const v0 = viewRef.current
    let moved = false
    const id = drag?.dataset.drag
    const host = drag?.closest<HTMLElement>('[data-pos]')
    const p0 = host ? { x: Number(host.dataset.posX), y: Number(host.dataset.posY) } : null
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      if (id && p0 && onMove) onMove(id, Math.round(p0.x + dx / v0.zoom), Math.round(p0.y + dy / v0.zoom))
      else if (onBg) {
        setAnim(0)
        setViewState({ ...v0, x: v0.x + dx, y: v0.y + dy })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moved && onBg) onBackgroundClick?.()
      if (moved) {
        // клик после перетаскивания карточки не должен её «открывать»
        const stop = (ce: MouseEvent) => {
          ce.stopPropagation()
          window.removeEventListener('click', stop, true)
        }
        window.addEventListener('click', stop, true)
        window.setTimeout(() => window.removeEventListener('click', stop, true), 0)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const paths = wires.flatMap((w) => {
    const a = anchors[w.from]
    const b = anchors[w.to]
    if (!a || !b) return []
    let d: string
    let mid: { x: number; y: number }
    if (w.shape === 'v') {
      const dy = Math.max(60, (b.y - a.y) * 0.55)
      d = `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    } else if (w.shape === 'arc') {
      const low = Math.max(a.y, b.y) + 56
      d = `M ${a.x} ${a.y} C ${a.x} ${low}, ${b.x} ${low}, ${b.x} ${b.y}`
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 8 + (low * 3) / 4 }
    } else if (w.shape === 'flow') {
      // поток слева направо: из правого края выхода вправо, во вход — слева
      const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5)
      d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    } else if (w.shape === 'side') {
      // дуга слева от колонки (связь через одну карточку)
      const left = Math.min(a.x, b.x) - 110
      d = `M ${a.x} ${a.y} C ${left} ${a.y}, ${left} ${b.y}, ${b.x} ${b.y}`
      mid = { x: left + 28, y: (a.y + b.y) / 2 }
    } else if (w.shape === 's') {
      const dir = b.x >= a.x ? 1 : -1
      const out = Math.max(70, Math.abs(b.x - a.x) * 0.4)
      d = `M ${a.x} ${a.y} C ${a.x - dir * out} ${a.y}, ${b.x} ${b.y - 120}, ${b.x} ${b.y}`
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    } else {
      const sx = b.x >= a.x ? 1 : -1
      const dx = Math.max(50, Math.abs(b.x - a.x) * 0.45) * sx
      d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    return [{ w, d, mid, a, b }]
  })

  return (
    <div
      ref={box}
      className={`nn-stage ${className ?? ''}`}
      data-testid={testId}
      {...(look ? { 'data-skin': look.skin, 'data-mode': look.mode } : {})}
      data-zoom={view.zoom.toFixed(3)}
      style={{ ['--nn-stage-glow' as string]: 'url(#' + uid + '-glow)' }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('[data-fit], [data-wire-label], [data-ui]')) onBackgroundDoubleClick?.()
      }}
      onContextMenu={(e) => {
        if (!onBackgroundMenu || (e.target as HTMLElement).closest('[data-fit], [data-wire-label], [data-ui]')) return
        e.preventDefault()
        onBackgroundMenu(pointAt(e.clientX, e.clientY))
      }}
    >
      <div
        ref={world}
        className="nn-stage-layer"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transition: anim ? `transform ${anim}ms cubic-bezier(.3,.7,.2,1)` : 'none' }}
      >
        <svg className="nn-stage-wires" width="1" height="1" aria-hidden>
          <defs>
            <marker id={uid + "-arrow"} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M 0 0 L 10 5 L 0 10 z" className="nn-stage-arrow-head" />
            </marker>
            <filter id={uid + "-glow"} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {paths.map(({ w, d }) => (
            <g key={w.id} className="nn-stage-wire" data-kind={w.kind} data-wire={w.id} {...(w.now ? { 'data-now': '' } : {})} {...(pickedWire === w.id ? { 'data-picked': '' } : {})}>
              <path className="nn-stage-wire-glow" d={d} />
              <path className="nn-stage-wire-line" d={d} {...(w.arrow ? { markerEnd: "url(#" + uid + "-arrow)" } : {})} />
              {onWireDelete ? <path className="nn-stage-wire-hit" data-wire-hit={w.id} d={d} /> : null}
            </g>
          ))}
          {pull ? (
            <g className="nn-stage-wire nn-stage-wire-pull" data-testid="stage-pull">
              <path className="nn-stage-wire-glow" d={`M ${pull.a.x} ${pull.a.y} L ${pull.b.x} ${pull.b.y}`} />
              <path className="nn-stage-wire-line" d={`M ${pull.a.x} ${pull.a.y} L ${pull.b.x} ${pull.b.y}`} />
            </g>
          ) : null}
        </svg>
        {children}
        {renderWireEnds
          ? paths.map(({ w, a, b }) => {
              const e = renderWireEnds(w)
              if (!e) return null
              return (
                <span key={`ends:${w.id}`}>
                  {e.a ? <div className="nn-stage-wire-end" data-wire-end={`${w.id}:a`} style={{ left: a.x, top: a.y }}>{e.a}</div> : null}
                  {e.b ? <div className="nn-stage-wire-end" data-wire-end={`${w.id}:b`} style={{ left: b.x, top: b.y }}>{e.b}</div> : null}
                </span>
              )
            })
          : null}
        {renderWireLabel
          ? paths.map(({ w, mid }) => (
              <div key={w.id} className="nn-stage-wire-label" data-wire-label={w.id} data-fit={`wire:${w.id}`} data-shape={w.shape} style={{ left: mid.x, top: mid.y }}>
                {renderWireLabel(w, mid)}
              </div>
            ))
          : null}
      </div>
    </div>
  )
})
