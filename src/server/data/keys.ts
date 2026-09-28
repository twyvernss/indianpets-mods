import type { T3 } from '@devvit/web/shared';
import { KEY_PREFIX } from '../config.js';

/**
 * ============================================================================
 * REDIS KEY SCHEMA
 * ============================================================================
 *
 * Devvit's Redis is siloed per subreddit installation and CANNOT list or scan
 * keys. Anything that must be found again has to be reachable from an index we
 * maintain ourselves. There is also no `hmGet` and no pipelining, so records
 * live in plain string keys (readable in one batched `mGet`) rather than as
 * fields of a hash (which would force one `hGet` per record - an N+1).
 *
 * VERIFICATION
 *   fv:v:{postId}        STRING  JSON VerificationRecord.
 *                                Written `pending` before any Reddit side
 *                                effect, promoted to `complete` afterwards.
 *
 *   fv:idx:verified      ZSET    member = postId, score = verifiedAtMs.
 *                                The durable, discoverable index of everything
 *                                this app has ever verified.
 *
 *   fv:idx:open          ZSET    member = postId, score = verifiedAtMs.
 *                                Subset still awaiting a staleness reminder or
 *                                an escalation. Entries are REMOVED once
 *                                resolved, so the nightly sweep reads a small,
 *                                bounded set instead of the full history.
 *
 *   fv:lock:{postId}     STRING  Unique owner token, TTL 120s.
 *   fv:tok:{token}       STRING  JSON VerificationToken, TTL 15 min.
 *   fv:mod:{username}    STRING  "1" | "0", TTL 300s / 60s.
 *   fv:held:{postId}     STRING  Epoch ms AutoModerator filtered the post.
 *   fv:areply:{postId}   STRING  "1", TTL 30d. Marks that the intake reply has
 *                                already been posted for this post.
 *
 * DUPLICATE LINK DETECTION
 *   fv:link:{linkKey}    STRING  JSON LinkRecord - the FIRST post seen with
 *                                this normalised link. TTL ~1 year. Written
 *                                with `nx` so the first writer wins a race.
 *
 *   fv:plinks:{postId}   STRING  JSON string[] of that post's link keys, so a
 *                                deletion can release the links it owned.
 *
 *   fv:dup:{postId}      STRING  "1", TTL 30d. Stops a redelivered trigger
 *                                reporting the same post twice.
 *
 * Everything is namespaced under `fv:` so a future feature can add keys
 * without colliding, and so a bulk cleanup can be reasoned about.
 * ============================================================================
 */
export const keys = {
  record: (postId: T3): string => `${KEY_PREFIX}:v:${postId}`,
  verifiedIndex: (): string => `${KEY_PREFIX}:idx:verified`,
  openIndex: (): string => `${KEY_PREFIX}:idx:open`,
  lock: (postId: T3): string => `${KEY_PREFIX}:lock:${postId}`,
  token: (token: string): string => `${KEY_PREFIX}:tok:${token}`,
  moderator: (username: string): string => `${KEY_PREFIX}:mod:${username.toLowerCase()}`,
  automodHold: (postId: T3): string => `${KEY_PREFIX}:held:${postId}`,
  automodReplied: (postId: T3): string => `${KEY_PREFIX}:areply:${postId}`,

  link: (linkKey: string): string => `${KEY_PREFIX}:link:${linkKey}`,
  postLinks: (postId: T3): string => `${KEY_PREFIX}:plinks:${postId}`,
  duplicateReported: (postId: T3): string => `${KEY_PREFIX}:dup:${postId}`,
} as const;
