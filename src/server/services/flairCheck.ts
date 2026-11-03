import { CONFIG, KEY_PREFIX } from '../config.js';
import type { RedisPort } from '../data/redisPort.js';
import { fundraiserSignals } from '../lib/fundraiserSignals.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsReader } from '../settings.js';
import { matchesFundraiserFlair } from '../settings.js';
import { buildMisflairReason } from '../text.js';
import type { PostContent, RedditPort } from './redditPort.js';

/**
 * Catches fundraisers posted under another flair.
 *
 * AutoModerator holds posts with the fundraiser flair for document checks, so
 * a fundraiser posted as "Discussion" or "Adoption" goes live unchecked - and
 * every other check this app runs is limited to the fundraiser flair as well.
 * A post that looks like a fundraiser but carries another flair is REPORTED
 * to the modqueue for a moderator to look at. It is never removed.
 */
export type FlairCheckOutcome =
  | 'off'
  | 'not-a-fundraiser'
  | 'flaired'
  | 'already-reported'
  | 'reported';

export type FlairCheckService = {
  check(post: PostContent): Promise<FlairCheckOutcome>;
};

export type FlairCheckDeps = {
  reddit: RedditPort;
  redis: RedisPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

const reportedKey = (postId: string): string => `${KEY_PREFIX}:misflair:${postId}`;

export function createFlairCheckService(deps: FlairCheckDeps): FlairCheckService {
  const { reddit, redis, settings, log, now } = deps;

  return {
    async check(post): Promise<FlairCheckOutcome> {
      const config = await settings.get();
      // With no fundraiser flair chosen, every post already counts as one.
      if (!config.enabled || !config.reportMisflairedFundraisers || config.fundraiserFlairText.length === 0) {
        return 'off';
      }

      // The text is checked first, so an ordinary post costs no Reddit call.
      const signals = fundraiserSignals(post);
      if (!signals.likely) return 'not-a-fundraiser';

      // The flair is read now rather than taken from the trigger, because a
      // poster may set or change it in the seconds after submitting.
      const snapshot = await reddit.getPost(post.id);
      if (!snapshot) return 'off';
      if (matchesFundraiserFlair(snapshot.flairText, config.fundraiserFlairText)) return 'flaired';

      // Claim the report first, so a redelivered job cannot file it twice. The
      // token is unique, so two runs in the same millisecond cannot both win.
      const token = `${now()}-${Math.random()}`;
      await redis.set(reportedKey(post.id), token, {
        nx: true,
        expiration: new Date(now() + CONFIG.duplicates.reportedTtlSeconds * 1000),
      });
      if ((await redis.get(reportedKey(post.id))) !== token) return 'already-reported';

      await reddit.reportPost(post.id, buildMisflairReason(snapshot.flairText, signals.reasons));
      log.info('possible fundraiser under another flair reported', {
        postId: post.id,
        flair: snapshot.flairText ?? 'none',
        reasons: signals.reasons.length,
      });
      return 'reported';
    },
  };
}
