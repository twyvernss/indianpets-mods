import type { T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import { signatureBands } from '../lib/fingerprint.js';
import { keys } from './keys.js';
import type { RedisPort } from './redisPort.js';
import { newestByScore, parseJson } from './redisPort.js';

/** One post's fingerprint as stored. Holds no post text. */
export type StoredFingerprint = {
  postId: T3;
  /** Null when the author was unknown or their account is gone. */
  author: string | null;
  postedAtMs: number;
  /** Hashed identifiers, each `kind:hash`. */
  ids: string[];
  /** Wording signature, or null for a post with too little text. */
  sig: number[] | null;
};

/**
 * Indexes for alt-account matching.
 *
 * Each identifier and each wording bucket is a sorted set of the posts that
 * carry it, so "who else has used this UPI ID?" is one bounded read rather
 * than a scan. Devvit Redis cannot scan keys, so these indexes are the only
 * way to find anything again.
 */
export type FingerprintRepo = {
  /** Writes the fingerprint and every index entry. Safe to repeat. */
  save(fingerprint: StoredFingerprint, nowMs: number): Promise<void>;
  get(postId: T3): Promise<StoredFingerprint | null>;
  /** One batched read. Missing or unreadable rows are left out. */
  getMany(postIds: readonly T3[]): Promise<StoredFingerprint[]>;
  /**
   * Posts sharing at least one identifier or wording bucket with this one,
   * newest first per key and bounded overall. Excludes the post itself.
   */
  candidates(fingerprint: StoredFingerprint): Promise<T3[]>;
  /** This person's fingerprinted posts, newest first. */
  byAuthor(username: string, limit: number): Promise<T3[]>;
  /** Erases a post's fingerprint and index entries. Safe for an unknown post. */
  forget(postId: T3): Promise<void>;

  wasReported(postId: T3): Promise<boolean>;
  markReported(postId: T3, nowMs: number): Promise<void>;
};

function isStoredFingerprint(value: unknown): value is StoredFingerprint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate['postId'] === 'string' &&
    candidate['postId'].startsWith('t3_') &&
    (candidate['author'] === null || typeof candidate['author'] === 'string') &&
    typeof candidate['postedAtMs'] === 'number' &&
    Array.isArray(candidate['ids']) &&
    candidate['ids'].every((id) => typeof id === 'string') &&
    (candidate['sig'] === null ||
      (Array.isArray(candidate['sig']) && candidate['sig'].every((n) => typeof n === 'number')))
  );
}

/** Every index key a fingerprint is listed under. */
function indexKeys(fingerprint: StoredFingerprint): string[] {
  return [
    ...fingerprint.ids.map((id) => keys.fingerprintId(id)),
    ...(fingerprint.sig ? signatureBands(fingerprint.sig).map((band) => keys.fingerprintBand(band)) : []),
  ];
}

export function createFingerprintRepo(redis: RedisPort): FingerprintRepo {
  const newest = async (key: string, limit: number): Promise<string[]> =>
    (await newestByScore(redis, key, limit)).map((entry) => entry.member);

  return {
    async save(fingerprint, nowMs) {
      const member = { member: fingerprint.postId, score: fingerprint.postedAtMs };
      const writes: Promise<unknown>[] = [
        redis.set(keys.fingerprint(fingerprint.postId), JSON.stringify(fingerprint), {
          expiration: new Date(nowMs + CONFIG.alt.fingerprintTtlSeconds * 1000),
        }),
        ...indexKeys(fingerprint).map((key) => redis.zAdd(key, member)),
      ];
      if (fingerprint.author) writes.push(redis.zAdd(keys.fingerprintAuthor(fingerprint.author), member));
      await Promise.all(writes);
    },

    async get(postId) {
      return parseJson(await redis.get(keys.fingerprint(postId)), isStoredFingerprint);
    },

    async getMany(postIds) {
      if (postIds.length === 0) return [];
      const raws = await redis.mGet(postIds.map((postId) => keys.fingerprint(postId)));
      const found: StoredFingerprint[] = [];
      for (const raw of raws) {
        const parsed = parseJson(raw, isStoredFingerprint);
        if (parsed) found.push(parsed);
      }
      return found;
    },

    async candidates(fingerprint) {
      const lists = await Promise.all(
        indexKeys(fingerprint).map((key) => newest(key, CONFIG.alt.postsPerKey)),
      );

      const seen = new Set<string>();
      for (const list of lists) {
        for (const postId of list) {
          if (postId !== fingerprint.postId) seen.add(postId);
          if (seen.size >= CONFIG.alt.maxCandidates) return [...seen] as T3[];
        }
      }
      return [...seen] as T3[];
    },

    async byAuthor(username, limit) {
      return (await newest(keys.fingerprintAuthor(username), limit)) as T3[];
    },

    async forget(postId) {
      const existing = await this.get(postId);
      if (!existing) return;

      const removals: Promise<unknown>[] = indexKeys(existing).map((key) => redis.zRem(key, [postId]));
      if (existing.author) removals.push(redis.zRem(keys.fingerprintAuthor(existing.author), [postId]));
      await Promise.all(removals);
      await redis.del(keys.fingerprint(postId));
    },

    async wasReported(postId) {
      return (await redis.get(keys.altReported(postId))) === '1';
    },

    async markReported(postId, nowMs) {
      await redis.set(keys.altReported(postId), '1', {
        expiration: new Date(nowMs + CONFIG.alt.reportedTtlSeconds * 1000),
      });
    },
  };
}
