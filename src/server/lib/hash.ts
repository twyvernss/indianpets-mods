/**
 * FNV-1a, 32-bit, returned as 8 lowercase hex characters.
 *
 * Used only to bound the length of Redis keys built from arbitrary URLs. It is
 * NOT a security primitive and must never be used as one.
 *
 * Why not `node:crypto`? The Devvit server runtime is Node-like but the docs do
 * not promise the full Node standard library, and `crypto.subtle.digest` is
 * async, which would make key construction async everywhere it is used. A
 * twelve-line pure function is deterministic, synchronous, dependency-free and
 * trivially testable.
 *
 * Collision risk: 32 bits over the number of distinct fundraiser links a
 * subreddit sees is negligible, and a collision's worst case is one spurious
 * modqueue report that a human dismisses - never an automated removal.
 */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    // hash *= 16777619, kept in 32-bit range without overflowing to float.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
