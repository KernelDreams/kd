// NDJSON stream formatting: StreamEvent ⇄ one JSON object per line. Spec §8.2.

import type { StreamEvent } from './types.js'

/** Serialize one StreamEvent to an NDJSON line (no trailing newline). */
export function serializeEvent(event: StreamEvent): string {
  return JSON.stringify(event)
}

/** Parse one NDJSON line back into a StreamEvent. */
export function parseEvent(line: string): StreamEvent {
  return JSON.parse(line) as StreamEvent
}

/** Parse a full NDJSON document (ignores blank lines). */
export function parseNDJSON(text: string): StreamEvent[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseEvent)
}

/** A sink that writes NDJSON lines (defaults to stdout). */
export function ndjsonWriter(
  write: (chunk: string) => void = (c) => process.stdout.write(c),
): (event: StreamEvent) => void {
  return (event: StreamEvent) => write(serializeEvent(event) + '\n')
}
