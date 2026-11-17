import type { Position } from '../../core/types.js'

export interface ConnectionViewProps {
  /** Connection id (rendered as data-connection-id) */
  id?: string
  from: Position
  to: Position
  selected?: boolean
  warning?: boolean
  onClick?: () => void
}

function controlOffset(from: Position, to: Position): number {
  return Math.max(Math.abs(to.x - from.x) * 0.5, 50)
}

function bezierPath(from: Position, to: Position): string {
  const cp = controlOffset(from, to)
  return `M ${from.x} ${from.y} C ${from.x + cp} ${from.y}, ${to.x - cp} ${to.y}, ${to.x} ${to.y}`
}

/** Point of the wire at t = 0.5 — where the connection label sits. */
export function connectionMidpoint(from: Position, to: Position): Position {
  const cp = controlOffset(from, to)
  // B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8
  return { x: (from.x + 3 * (from.x + cp) + 3 * (to.x - cp) + to.x) / 8, y: (from.y + to.y) / 2 }
}

export function ConnectionView({ id, from, to, selected, warning, onClick }: ConnectionViewProps) {
  const path = bezierPath(from, to)
  let className = 'nn-connection'
  if (selected) className += ' nn-connection-selected'
  if (warning) className += ' nn-connection-warning'

  return (
    <g className={className} onClick={onClick} data-connection-id={id}>
      {/* Hit area (wider, invisible) */}
      <path d={path} className="nn-connection-hit" />
      {/* Visible line */}
      <path d={path} className="nn-connection-line" />
    </g>
  )
}
