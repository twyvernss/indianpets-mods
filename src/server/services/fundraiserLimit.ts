import { CONFIG } from '../config.js';
import { keys } from '../data/keys.js';
import type { LinkRepo } from '../data/linkRepo.js';
import type { RedisPort } from '../data/redisPort.js';
import { newestByScore } from '../data/redisPort.js';
import { fundraiserSignals } from '../lib/fundraiserSignals.js';
import type { Logger } from '../lib/logger.js';
import type { AppSettings, SettingsReader } from '../settings.js';
import { matchesFundraiserFlair } from '../settings.js';
import { buildFundraiserLimitReason } from '../text.js';
import type { PostContent, RedditPort } from './redditPort.js';

/**
 * One fundraiser per person per window (24 hours by default).
 *
 * A second fundraiser inside the window is REPORTED to the modqueue with a
 * reason that says both what it is and what rule it broke, e.g. "2nd
 * fundraiser in 24h from u/name: last one t3_abc 5h ago". It is never removed:
 * AutoModerator already holds fundraisers, and a moderator decides.
 *
 * A post counts as a fundraiser when it carries the fundraiser flair OR looks
 * like one by its content, so switching to another flair does not reset the
 * clock.
 */
export type FundraiserLimitOutcome =
  | 'off'
  | 'not-a-fundraiser'
  | 'first'
  | 'already-reported'
  | 'left-to-duplicate-report'
  | 'reported';

export type FundraiserLimitService = {
  /** For a new post: records it, and reports it when it breaks the window. */
  check(post: PostContent): Promise<FundraiserLimitOutcome>;
  /** For the install backfill: records past fundraisers, never reports. */
  record(post: PostContent): Promise<void>;
};

export type FundraiserLimitDeps = {
  reddit: RedditPort;
  redis: RedisPort;
  /** Read-only here: whether the duplicate detector already reported the post. */
  links: LinkRepo;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

const HOUR_MS = 3_600_000;

export function createFundraiserLimitService(deps: FundraiserLimitDeps): FundraiserLimitService {
  const { reddit, redis, links, settings, log, now } = deps;

  /**
   * Whether a post is a fundraiser. The content is checked first, so most
   * posts are decided without a Reddit call; the flair is read from the post
   * only when the source did not supply it.
   */
  async function isFundraiser(post: PostContent, config: AppSettings): Promise<boolean> {
    if (fundraiserSignals(post).likely) return true;
    if (config.fundraiserFlairText.length === 0) return false;

    const flair = post.flairText !== undefined ? post.flairText : ((await reddit.getPost(post.id))?.flairText ?? null);
    return matchesFundraiserFlair(flair, config.fundraiserFlairText) && flair !== null;
  }

  async function remember(post: PostContent, author: string): Promise<void> {
    await redis.zAdd(keys.fundraiserPosts(author), { member: post.id, score: post.createdAtMs });
  }

  return {
    async check(post): Promise<FundraiserLimitOutcome> {
      const config = await settings.get();
      if (!config.enabled || config.fundraiserLimitHours <= 0 || !post.authorName) return 'off';
      if (!(await isFundraiser(post, config))) return 'not-a-fundraiser';

      const author = post.authorName;
      const windowMs = config.fundraiserLimitHours * HOUR_MS;

      const earlier = (await newestByScore(redis, keys.fundraiserPosts(author), 10)).filter(
        (entry) =>
          entry.member !== post.id &&
          entry.score <= post.createdAtMs &&
          post.createdAtMs - entry.score < windowMs,
      );
      await remember(post, author);

      const last = earlier[0];
      if (!last) return 'first';

      // A same-link repost inside the window is already reported by the
      // duplicate detector, with the same facts. One report is enough.
      if (await links.wasReported(post.id)) return 'left-to-duplicate-report';

      const token = `${now()}-${Math.random()}`;
      await redis.set(keys.fundraiserLimitReported(post.id), token, {
        nx: true,
        expiration: new Date(now() + CONFIG.duplicates.reportedTtlSeconds * 1000),
      });
      if ((await redis.get(keys.fundraiserLimitReported(post.id))) !== token) return 'already-reported';

      await reddit.reportPost(
        post.id,
        buildFundraiserLimitReason({
          count: earlier.length + 1,
          windowHours: config.fundraiserLimitHours,
          author,
          lastPostId: last.member,
          hoursAgo: Math.floor((post.createdAtMs - last.score) / HOUR_MS),
        }),
      );
      log.info('fundraiser inside the per-person window reported', {
        postId: post.id,
        earlierInWindow: earlier.length,
      });
      return 'reported';
    },

    async record(post): Promise<void> {
      const config = await settings.get();
      if (!config.enabled || config.fundraiserLimitHours <= 0 || !post.authorName) return;
      if (await isFundraiser(post, config)) await remember(post, post.authorName);
    },
  };
}
