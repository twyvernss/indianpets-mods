import { CONFIG } from '../config.js';
import { keys } from '../data/keys.js';
import type { RedisPort } from '../data/redisPort.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import type { RedditPort } from './redditPort.js';

/**
 * Server-side moderator authorisation.
 *
 * `forUserType: "moderator"` in devvit.json controls who SEES the menu item.
 * It is not an authorisation check: the endpoint is still an HTTP endpoint.
 * Every action re-verifies moderator status here, on the server, using the
 * username the platform reports for the request — never a value from the
 * request body.
 */
export type ModeratorGate = {
  /** The acting user's username, or null if the request has no user. */
  actingUsername(): Promise<string | null>;
  isModerator(username: string): Promise<boolean>;
};

export function createModeratorGate(
  reddit: RedditPort,
  redis: RedisPort,
  log: Logger,
  now: () => number = () => Date.now(),
): ModeratorGate {
  return {
    actingUsername: () => reddit.currentUsername(),

    async isModerator(username: string): Promise<boolean> {
      const cacheKey = keys.moderator(username);

      // Cache read failures must never deny a legitimate moderator, so a
      // broken cache falls through to the authoritative API call.
      try {
        const cached = await redis.get(cacheKey);
        if (cached === '1') return true;
        if (cached === '0') return false;
      } catch (error) {
        log.warn('moderator cache read failed', { username, reason: describeError(error) });
      }

      const result = await reddit.isModerator(username);

      // Positives are cached for longer than negatives: a revoked moderator
      // keeps access for at most 5 minutes, while a newly added one waits at
      // most 1 minute. Both are acceptable; neither is silent.
      const ttlSeconds = result ? CONFIG.modCacheTtlSeconds : CONFIG.modCacheNegativeTtlSeconds;
      try {
        await redis.set(cacheKey, result ? '1' : '0', {
          expiration: new Date(now() + ttlSeconds * 1000),
        });
      } catch (error) {
        log.warn('moderator cache write failed', { username, reason: describeError(error) });
      }

      return result;
    },
  };
}
