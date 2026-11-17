/**
 * WebSocket (RFC 6455) поверх `upgrade` node:http — без зависимостей: текстовые сообщения,
 * фрагментация, ping/pong, close. Только сервер; кадры клиента обязаны быть замаскированы.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 4 * 1024 * 1024
const PING_MS = 25_000

export interface WsConnection {
  send(text: string): void
  close(code?: number, reason?: string): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
  readonly closed: boolean
}

/** Ответить на рукопожатие; не WebSocket — 400 и `null`. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'Bad Request')
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
  return wrap(socket, head)
}

/** Отказ до рукопожатия: статус и закрыть. */
export function rejectUpgrade(socket: Duplex, status: number, text: string, body = ''): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  } finally {
    socket.destroy()
  }
}

function wrap(socket: Duplex, head: Buffer): WsConnection {
  let buf: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragOpcode = 0
  let closed = false
  const onMsg: Array<(t: string) => void> = []
  const onEnd: Array<() => void> = []

  const ping = setInterval(() => frame(0x9, Buffer.alloc(0)), PING_MS)
  ping.unref()

  function frame(opcode: number, payload: Buffer): void {
    if (closed) return
    const len = payload.length
    let header: Buffer
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len])
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }

  function finish(): void {
    if (closed) return
    closed = true
    clearInterval(ping)
    for (const fn of onEnd) fn()
  }

  function close(code = 1000, reason = ''): void {
    if (closed) return
    const r = Buffer.from(reason)
    const p = Buffer.alloc(2 + r.length)
    p.writeUInt16BE(code, 0)
    r.copy(p, 2)
    frame(0x8, p)
    finish()
    socket.end()
  }

  function parse(): void {
    while (buf.length >= 2) {
      const b0 = buf[0]!
      const b1 = buf[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE)) return close(1009, 'too big')
        len = Number(big)
        off = 10
      }
      if (!masked) return close(1002, 'unmasked')
      if (len > MAX_MESSAGE) return close(1009, 'too big')
      if (buf.length < off + 4 + len) return
      const mask = buf.subarray(off, off + 4)
      const payload = Buffer.alloc(len)
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i & 3]!
      buf = buf.subarray(off + 4 + len)

      if (opcode === 0x8) return close()
      if (opcode === 0x9) {
        frame(0xa, payload)
        continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x1 || opcode === 0x2) {
        fragOpcode = opcode
        fragments = [payload]
      } else if (opcode === 0x0) {
        fragments.push(payload)
      } else {
        return close(1003, 'opcode')
      }
      if (fin) {
        const msg = Buffer.concat(fragments)
        fragments = []
        if (msg.length > MAX_MESSAGE) return close(1009, 'too big')
        if (fragOpcode === 0x1 || fragOpcode === 0x2) for (const fn of onMsg) fn(msg.toString('utf8'))
      }
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    parse()
  })
  socket.on('close', finish)
  socket.on('end', finish)
  socket.on('error', finish)
  if (buf.length) setImmediate(parse)

  return {
    send: (text) => frame(0x1, Buffer.from(text, 'utf8')),
    close,
    onMessage: (fn) => void onMsg.push(fn),
    onClose: (fn) => void onEnd.push(fn),
    get closed() {
      return closed
    },
  }
}
