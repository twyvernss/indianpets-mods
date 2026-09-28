import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import { keys } from '../data/keys.js';
import type { RedisPort } from '../data/redisPort.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import type { SettingsReader } from '../settings.js';
import { renderIntakeComment } from '../text.js';
import type { RedditPort, SchedulerPort } from './redditPort.js';

/**
 * Intake: what happens the moment AutoModerator holds a fundraiser.
 *
 * r/IndianPets filters fundraisers rather than removing them, so
 * `onAutomoderatorFilterPost` fires for exactly the posts a moderator will
 * later verify. Two things are worth doing at that point:
 *
 *  - remember WHEN it was held, which the status action and the verify form
 *    both surface;
 *  - optionally reply to the OP telling them what to send, so the documents
 *    arrive without a moderator having to ask.
 *
 * The reply is OFF by default. Most subreddits already have AutoModerator post
 * something similar, and two bot comments on one post is worse than one.
 */
export type IntakeService = {
  /** Runs on the trigger. Redis only; any reply is queued, not posted here. */
  onAutomodHold(input: { postId: T3; author: string | null; heldAtMs: number }): Promise<void>;
  /** Posts the intake reply. Runs from a scheduled job, off the hot path. */
  postReply(input: { postId: T3; author: string | null }): Promise<void>;
};

export type IntakeDeps = {
  redis: RedisPort;
  reddit: RedditPort;
  scheduler: SchedulerPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
  /**
   * Unique id source for the reply claim. Injected so tests are deterministic.
   * It MUST be unique per attempt: deriving the marker from the clock lets two
   * deliveries in the same millisecond both believe they won the claim.
   */
  newId: () => string;
};

export function createIntakeService(deps: IntakeDeps): IntakeService {
  const { redis, reddit, scheduler, settings, log, now, newId } = deps;

  /**
   * Claims the right to reply to this post exactly once.
   *
   * Written with `nx` and read back, because Devvit does not specify what
   * `set` returns when `nx` suppresses the write. A redelivered trigger loses
   * the race and stays silent.
   */
  async function claimReply(postId: T3, marker: string, timestamp: number): Promise<boolean> {
    const key = keys.automodReplied(postId);
    await redis.set(key, marker, {
      nx: true,
      expiration: new Date(timestamp + CONFIG.intake.repliedTtlSeconds * 1000),
    });
    return (await redis.get(key)) === marker;
  }

  return {
    async onAutomodHold({ postId, author, heldAtMs }): Promise<void> {
      const timestamp = now();

      // Always record the hold, even when the reply is switched off - the
      // timestamp is useful on its own and costs one write.
      await redis.set(keys.automodHold(postId), String(heldAtMs), {
        expiration: new Date(timestamp + CONFIG.automodHoldTtlSeconds * 1000),
      });

      const config = await settings.get();
      if (!config.enabled || !config.automodReplyEnabled) return;

      if (!(await claimReply(postId, newId(), timestamp))) {
        log.info('intake reply already claimed; skipping', { postId });
        return;
      }

      try {
        await scheduler.runJob({
          name: JOBS.automodReply,
          data: { postId, author },
          runAt: new Date(timestamp + CONFIG.intake.replyDelaySeconds * 1000),
        });
        log.info('intake reply queued', { postId });
      } catch (error) {
        // Release the claim so a redelivery can try again, rather than leaving
        // the post silently un-replied for 30 days.
        await redis.del(keys.automodReplied(postId));
        log.error('could not queue the intake reply', { postId, reason: describeError(error) });
      }
    },

    async postReply({ postId, author }): Promise<void> {
      const config = await settings.get();
      // Re-checked here as well as at queue time: a moderator may have switched
      // the feature off in the seconds between.
      if (!config.enabled || !config.automodReplyEnabled) return;

      const post = await reddit.getPost(postId);
      if (!post) {
        log.info('intake reply skipped: post is gone', { postId });
        return;
      }

      // If the post has already been approved, a moderator has dealt with it
      // and an "we need documents" comment would just be noise.
      if (post.isApproved && !post.isRemoved) {
        log.info('intake reply skipped: post already approved', { postId });
        return;
      }

      const comment = await reddit.submitAppComment(
        postId,
        renderIntakeComment({
          custom: config.automodReplyText,
          subredditName: reddit.subredditName(),
          authorName: author ?? post.authorName,
        }),
      );

      // Distinguishing is best-effort: the comment is the point, the badge is
      // a nicety. A failure here must not look like the reply failed.
      try {
        await comment.distinguishAndSticky();
      } catch (error) {
        log.warn('intake reply posted but could not be distinguished', {
          postId,
          reason: describeError(error),
        });
      }

      log.info('intake reply posted', { postId, commentId: comment.id });
    },
  };
}
