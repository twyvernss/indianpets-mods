import type { T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import type { LinkRecord } from '../types.js';
import { keys } from './keys.js';
import type { RedisPort } from './redisPort.js';
import { parseJson } from './redisPort.js';

/**
 * Ownership index for normalised fundraiser links.
 *
 * The first post seen carrying a link owns it. Later posts carrying the same
 * link are duplicates. Ownership expires after about a year, so a genuinely new
 * fundraiser reusing an old campaign URL eventually stops being flagged.
 */
export type LinkRepo = {
  /**
   * Batched lookup of current owners. One `mGet` regardless of how many links
   * the post contains.
   */
  findOwners(linkKeys: readonly string[]): Promise<Map<string, LinkRecord>>;
  /**
   * Claims ownership of `linkKey` for this post if nobody holds it yet.
   * Returns the record that ended up owning it - which may be someone else's if
   * two posts raced.
   */
  claim(linkKey: string, record: LinkRecord, nowMs: number): Promise<LinkRecord>;
  /**
   * Moves ownership of an existing link to a newer post, unconditionally.
   * Used when a repost is legitimate: the newest post owns the link, so the
   * "how long since last time" clock restarts from it.
   */
  transfer(linkKey: string, record: LinkRecord, nowMs: number): Promise<void>;
  /** Remembers which links a post claimed, so a deletion can release them. */
  rememberPostLinks(postId: T3, linkKeys: readonly string[], nowMs: number): Promise<void>;
  /** Releases every link a post owned. Safe to call for an unknown post. */
  releasePostLinks(postId: T3): Promise<void>;

  /** True if this post has already been reported as a duplicate. */
  wasReported(postId: T3): Promise<boolean>;
  markReported(postId: T3, nowMs: number): Promise<void>;
};

function isLinkRecord(value: unknown): value is LinkRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate['postId'] !== 'string' || !candidate['postId'].startsWith('t3_')) return false;
  if (candidate['author'] !== null && typeof candidate['author'] !== 'string') return false;
  if (typeof candidate['firstSeenMs'] !== 'number' || !Number.isFinite(candidate['firstSeenMs'])) {
    return false;
  }
  if (typeof candidate['display'] !== 'string') return false;
  if (typeof candidate['shortened'] !== 'boolean') return false;

  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function createLinkRepo(redis: RedisPort): LinkRepo {
  return {
    async findOwners(linkKeys) {
      if (linkKeys.length === 0) return new Map();

      const raws = await redis.mGet(linkKeys.map((key) => keys.link(key)));
      const owners = new Map<string, LinkRecord>();

      linkKeys.forEach((linkKey, index) => {
        const record = parseJson(raws[index] ?? null, isLinkRecord);
        if (record) owners.set(linkKey, record);
      });

      return owners;
    },

    async claim(linkKey, record, nowMs) {
      const key = keys.link(linkKey);

      // `nx` makes the first writer the owner. Reading the value back is what
      // actually determines the winner, because Devvit does not specify what
      // `set` returns when `nx` suppresses the write.
      await redis.set(key, JSON.stringify(record), {
        nx: true,
        expiration: new Date(nowMs + CONFIG.duplicates.linkTtlSeconds * 1000),
      });

      const stored = parseJson(await redis.get(key), isLinkRecord);
      return stored ?? record;
    },

    async transfer(linkKey, record, nowMs) {
      // No `nx`: this deliberately overwrites the previous owner.
      await redis.set(keys.link(linkKey), JSON.stringify(record), {
        expiration: new Date(nowMs + CONFIG.duplicates.linkTtlSeconds * 1000),
      });
    },

    async rememberPostLinks(postId, linkKeys, nowMs) {
      if (linkKeys.length === 0) return;
      await redis.set(keys.postLinks(postId), JSON.stringify(linkKeys), {
        expiration: new Date(nowMs + CONFIG.duplicates.linkTtlSeconds * 1000),
      });
    },

    async releasePostLinks(postId) {
      const owned = parseJson(await redis.get(keys.postLinks(postId)), isStringArray);
      if (!owned || owned.length === 0) {
        await redis.del(keys.postLinks(postId));
        return;
      }

      // Only release links this post actually owns. Another post may have
      // claimed the same key after this one's entry expired, and deleting that
      // would hand ownership to whoever posts next.
      const owners = await this.findOwners(owned);
      const toDelete: string[] = [];
      for (const [linkKey, record] of owners) {
        if (record.postId === postId) toDelete.push(keys.link(linkKey));
      }

      toDelete.push(keys.postLinks(postId));
      await redis.del(...toDelete);
    },

    async wasReported(postId) {
      return (await redis.get(keys.duplicateReported(postId))) === '1';
    },

    async markReported(postId, nowMs) {
      await redis.set(keys.duplicateReported(postId), '1', {
        expiration: new Date(nowMs + CONFIG.duplicates.reportedTtlSeconds * 1000),
      });
    },
  };
}
