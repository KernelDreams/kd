// Opaque content hashing for version tokens (§3.1.3) and edit preconditions.
//
// The spec calls for xxh64; pulling an xxhash dependency is out of scope for a
// runz file-link lib, so we use a dependency-free FNV-1a 64-bit hash. The token
// is opaque to consumers — only stability and cheap computation matter, both of
// which FNV-1a provides. Swap for xxh64 later without touching call sites.

const OFFSET = 0xcbf29ce484222325n
const PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

/** FNV-1a 64-bit hash of a string → 16-char lowercase hex. */
export function hash(input: string): string {
  let h = OFFSET
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i))
    h = (h * PRIME) & MASK
  }
  return h.toString(16).padStart(16, '0')
}
