// Decode helpers (spec §2.1). Sugar for the consumer — NOT part of the
// transport contract. nr-web carries bytes; these turn bytes into text/JSON
// when the consumer knows what they are.

import { type Result, ok, err } from '@kerneldreams/nrd'
import type { WebResponse } from './types.js'

/** Decode the response body as utf-8 text. */
export function asText(res: WebResponse): string {
  return new TextDecoder().decode(res.body)
}

/** Decode as text, then JSON.parse. Invalid JSON → err (predictable error via Result). */
export function asJson<T = unknown>(res: WebResponse): Result<T> {
  const text = asText(res)
  try {
    return ok(JSON.parse(text) as T)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}
