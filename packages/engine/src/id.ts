// ID generation. Ported from chat2 session/id.ts.
//
// CVCVCV pattern — consonant/vowel alternation gives short, pronounceable,
// collision-resistant ids (`weruka`, `bokali`). Used for stable message ids
// that gain swipes and for session filenames.

const CONSONANTS = 'bcdfghjklmnpqrstvwxz'
const VOWELS = 'aeiou'

function pick(set: string): string {
  return set[Math.floor(Math.random() * set.length)]!
}

/** Generate a CVCVCV id, e.g. `weruka`. */
export function generateId(): string {
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += pick(i % 2 === 0 ? CONSONANTS : VOWELS)
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYYMMDD` for the given (or current) date. */
export function dateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** Generate a timestamped session id, e.g. `weruka-20260614`. */
export function generateTimestampedId(base?: string): string {
  return `${base ?? generateId()}-${dateStamp()}`
}
