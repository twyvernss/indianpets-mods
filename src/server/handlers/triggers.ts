import type {
  OnAutomoderatorFilterPostRequest,
  OnCommentCreateRequest,
  OnCommentSubmitRequest,
  OnPostDeleteRequest,
  OnPostSubmitRequest,
} from '@devvit/web/shared';
import { Hono } from 'hono';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import { describeError } from '../lib/logger.js';

export const triggers = new Hono();

/**
 * Trigger handlers must return fast and must tolerate being called more than
 * once for the same event - Devvit does not guarantee exactly-once delivery.
 * Everything here is either a bounded set of Redis operations or a job handed
 * to the scheduler; no handler makes a Reddit write inline.
 *
 * They always answer 200. A non-200 buys nothing (there is no work to retry
 * that a redelivery would not repeat anyway) and would only add noise.
 */

function parseIsoMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== 'string') return fallbackMs;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/**
 * AutoModerator filtered a post.
 *
 * r/IndianPets filters fundraisers rather than removing them, so this fires for
 * exactly the posts a moderator will later verify. Recording when the post was
 * held gives the status menu action something useful to say about a post that
 * has not been verified yet.
 */
triggers.post('/automod-filter-post', async (c) => {
  const { log, repo } = getContainer();

  try {
    const body = await c.req.json<OnAutomoderatorFilterPostRequest>();
    const postId = asPostId(body.post?.id ?? '');

    if (postId) {
      const nowMs = Date.now();
      await repo.recordAutomodHold(postId, parseIsoMs(body.removedAt, nowMs), nowMs);
      log.info('automod filtered a post', { postId });
    }
  } catch (error) {
    log.error('automod-filter-post trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});

/**
 * A new post. Scans it for fundraiser links that have been seen before.
 *
 * Redis-only: any modqueue report is handed to the scheduler so the trigger's
 * worst case stays close to its best case.
 */
triggers.post('/post-submit', async (c) => {
  const { log, duplicates } = getContainer();

  try {
    const body = await c.req.json<OnPostSubmitRequest>();
    const postId = asPostId(body.post?.id ?? '');

    if (postId) {
      await duplicates.inspectPost({
        postId,
        author: body.author?.name ?? null,
        title: body.post?.title ?? '',
        body: body.post?.selftext ?? '',
        // For a link post this is the target; for a self post Reddit sets it to
        // the post's own permalink, which `collectLinks` discards as an ignored
        // host.
        url: body.post?.url ?? '',
      });
    }
  } catch (error) {
    log.error('post-submit trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});

/**
 * A new comment, used for two things:
 *
 *  1. noticing that an OP has replied to a staleness reminder, which stops the
 *     chase without any polling;
 *  2. optionally scanning comments for fundraiser links (off by default).
 *
 * The first check is a single Redis GET and almost every comment stops there,
 * which is what keeps this affordable on a large subreddit.
 */
triggers.post('/comment-create', async (c) => {
  const { log, reminders, duplicates, settings } = getContainer();

  try {
    const body = await c.req.json<OnCommentCreateRequest | OnCommentSubmitRequest>();
    const comment = body.comment;
    const author = body.author?.name ?? null;
    const postId = asPostId(comment?.postId ?? '');

    if (!postId || !author || !comment) return c.json({ status: 'ok' });

    await reminders.noteOpActivity({ postId, author });

    const config = await settings.get();
    if (config.enabled && config.duplicateDetectionEnabled && config.scanCommentsForLinks) {
      await duplicates.inspectPost({
        postId,
        author,
        title: '',
        body: comment.body ?? '',
        url: '',
      });
    }
  } catch (error) {
    log.error('comment-create trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});

/**
 * A post was deleted or removed.
 *
 * NOTE: this trigger fires for moderator removals too, not only author
 * deletions, and Devvit gives no guarantee about which. The handler therefore
 * does the safe thing for both: it scrubs the stored user content (satisfying
 * the Devvit Rules requirement to respect deletions) while KEEPING the row, so
 * that a post which is removed and later restored still reads as "already
 * verified" and cannot be given a second verification comment.
 *
 * Link ownership IS released, so a genuinely deleted fundraiser does not leave
 * its URLs permanently claimed.
 */
triggers.post('/post-delete', async (c) => {
  const { log, repo, duplicates } = getContainer();

  try {
    const body = await c.req.json<OnPostDeleteRequest>();
    const postId = asPostId(body.postId ?? '');

    if (postId) {
      await Promise.all([
        repo.markDeleted(postId, parseIsoMs(body.deletedAt, Date.now())),
        duplicates.forgetPost(postId),
      ]);
      log.info('post deleted; stored content scrubbed and links released', { postId });
    }
  } catch (error) {
    log.error('post-delete trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});
