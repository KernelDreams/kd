import { describe, expect, it } from 'vitest'
import { connectionMidpoint } from '../components/ConnectionView.js'

describe('connection label position', () => {
  it('sits on the wire midpoint (bezier t = 0.5)', () => {
    expect(connectionMidpoint({ x: 0, y: 0 }, { x: 400, y: 100 })).toEqual({ x: 200, y: 50 })
    // backward wire: control points push the midpoint between the ends all the same
    expect(connectionMidpoint({ x: 400, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 200, y: 0 })
  })
})
