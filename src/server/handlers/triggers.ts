import type {
  OnAutomoderatorFilterPostRequest,
  OnModActionRequest,
  OnCommentCreateRequest,
  OnCommentSubmitRequest,
  OnPostDeleteRequest,
  OnPostSubmitRequest,
} from '@devvit/web/shared';
import type { T3 } from '@devvit/web/shared';
import { Hono } from 'hono';
import { CONFIG, JOBS } from '../config.js';
import { getContainer } from '../container.js';
import { asPostId } from '../data/tokenRepo.js';
import { describeError } from '../lib/logger.js';

export const triggers = new Hono();

/**
 * Queues a Status update for the wiki log row of a verified post.
 *
 * One Redis read decides whether the post was ever verified; every other post
 * stops there. The wiki write itself needs Reddit calls, so it is a job.
 */
async function queueStatus(postId: T3, status: string): Promise<void> {
  const { repo, scheduler } = getContainer();
  const record = await repo.get(postId);
  if (!record || record.status !== 'complete') return;
  await scheduler.runJob({
    name: JOBS.logStatus,
    data: { postId, status, attempt: 0 },
    runAt: new Date(Date.now() + 5_000),
  });
}

/** Moderator actions on a post that change what its Status cell should say. */
const STATUS_FOR_ACTION: Readonly<Record<string, string>> = {
  removelink: 'removed',
  spamlink: 'removed as spam',
  approvelink: 'up',
};

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
 * A post's `createdAt` is a number whose unit Devvit does not document, so
 * seconds are told apart from milliseconds by size. An ISO string also works.
 */
function parseCreatedMs(value: unknown, fallbackMs: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  return parseIsoMs(value, fallbackMs);
}

/**
 * True when the author deleted the post, rather than a moderator removing it.
 *
 * The event's `source` is a protobuf enum that may arrive as its number or its
 * name. Anything unrecognised counts as "not the author", so a fingerprint is
 * kept rather than lost - it holds no post text either way.
 */
function deletedByAuthor(source: unknown): boolean {
  return source === 1 || source === 'USER';
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
  const { log, intake } = getContainer();

  try {
    const body = await c.req.json<OnAutomoderatorFilterPostRequest>();
    const postId = asPostId(body.post?.id ?? '');

    if (postId) {
      await intake.onAutomodHold({
        postId,
        // This payload's `author` is the author's USER ID (t2_...) rather than
        // a username, and a user id is useless in a comment. The reply job
        // reads the username from the post itself instead.
        author: null,
        heldAtMs: parseIsoMs(body.removedAt, Date.now()),
      });
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
  const { log, duplicates, settings, scheduler } = getContainer();

  try {
    const body = await c.req.json<OnPostSubmitRequest>();
    const postId = asPostId(body.post?.id ?? '');

    if (postId) {
      const author = body.author?.name ?? null;
      const title = body.post?.title ?? '';
      const text = body.post?.selftext ?? '';
      // For a link post this is the target; for a self post Reddit sets it to
      // the post's own permalink, which `collectLinks` discards as an ignored
      // host.
      const url = body.post?.url ?? '';

      await duplicates.inspectPost({ postId, author, title, body: text, url });

      // Alt matching reads a dozen or more Redis keys and may call Reddit for
      // ban status, so it runs as a job. The text travels with the job, which
      // saves the job fetching the post again.
      const config = await settings.get();
      // One job does both checks that need the post's text: alt matching, and
      // spotting a fundraiser posted under another flair.
      const wanted =
        config.altDetectionEnabled ||
        config.fundraiserLimitHours > 0 ||
        (config.reportMisflairedFundraisers && config.fundraiserFlairText.length > 0);
      if (config.enabled && wanted && author) {
        const nowMs = Date.now();
        await scheduler.runJob({
          name: JOBS.altCheck,
          data: {
            post: {
              id: postId,
              authorName: author,
              title,
              body: text.slice(0, CONFIG.alt.maxBodyChars),
              url,
              createdAtMs: parseCreatedMs(body.post?.createdAt, nowMs),
              flairText: body.post?.linkFlair?.text ?? null,
            },
          },
          runAt: new Date(nowMs + CONFIG.alt.checkDelaySeconds * 1000),
        });
      }
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
 * Link ownership is released only on an AUTHOR deletion, so a fundraiser its
 * owner took down does not leave its URLs claimed forever, while one a
 * moderator removed keeps them - a repost of a removed scam is still reported.
 */
triggers.post('/post-delete', async (c) => {
  const { log, repo, duplicates, alt } = getContainer();

  try {
    const body = await c.req.json<OnPostDeleteRequest>();
    const postId = asPostId(body.postId ?? '');

    if (postId) {
      // A moderator removal keeps the fingerprint: a banned user's removed
      // posts are exactly what their next account needs to be matched against.
      const byAuthor = deletedByAuthor((body as { source?: unknown }).source);
      await Promise.all([
        repo.markDeleted(postId, parseIsoMs(body.deletedAt, Date.now())),
        // Links and fingerprints are released only when the AUTHOR deletes.
        // A post a moderator removed - often a scam - must keep its links
        // claimed, or the next account to post them would not be reported.
        byAuthor ? duplicates.forgetPost(postId) : Promise.resolve(),
        byAuthor ? alt.forgetPost(postId) : Promise.resolve(),
        queueStatus(postId, byAuthor ? 'deleted by author' : 'removed'),
      ]);
      log.info('post deleted; stored content scrubbed and links released', { postId });
    }
  } catch (error) {
    log.error('post-delete trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});

/**
 * Queues the catch-up jobs that fill in what the app has not seen yet.
 *
 *  - per-author verification history, for records older than that index;
 *  - fingerprints of the subreddit's ~1,000 newest posts, so alt matching has
 *    something to compare a new post with from the first day;
 *  - wiki log rows, statuses and history pages for past verifications. Until
 *    0.0.11 the privacy check misread every page as public, so nothing was
 *    logged.
 *
 * Every job skips work already done, so running them on each install and
 * upgrade is safe. They run on the scheduler, a few items per run.
 */
async function queueBackfills(reason: string): Promise<void> {
  const { log, scheduler } = getContainer();

  await scheduler.runJob({
    name: JOBS.authorBackfill,
    data: { offset: 0, batchIndex: 0 },
    runAt: new Date(Date.now() + 10_000),
  });
  await scheduler.runJob({
    name: JOBS.altBackfill,
    data: { after: '', batchIndex: 0 },
    runAt: new Date(Date.now() + 30_000),
  });
  await scheduler.runJob({
    name: JOBS.auditBackfill,
    data: { offset: 0, batchIndex: 0 },
    runAt: new Date(Date.now() + 60_000),
  });
  log.info('queued author history, fingerprint and wiki log backfills', { reason });
}

/** The app was installed in a community for the first time. */
triggers.post('/app-install', async (c) => {
  try {
    await queueBackfills('install');
  } catch (error) {
    getContainer().log.error('app-install trigger failed', { reason: describeError(error) });
  }
  return c.json({ status: 'ok' });
});

/** A new version of the app was installed. */
triggers.post('/app-upgrade', async (c) => {
  try {
    await queueBackfills('upgrade');
  } catch (error) {
    getContainer().log.error('app-upgrade trigger failed', { reason: describeError(error) });
  }
  return c.json({ status: 'ok' });
});

/**
 * A moderator acted on something. Only post removals, spam and approvals
 * matter here, and only for posts this app verified: they update the Status
 * column of the wiki log so it says whether the fundraiser is still up.
 */
triggers.post('/mod-action', async (c) => {
  const { log } = getContainer();

  try {
    const body = await c.req.json<OnModActionRequest>();
    const status = STATUS_FOR_ACTION[body.action ?? ''];
    const postId = asPostId(body.targetPost?.id ?? '');
    if (status && postId) await queueStatus(postId, status);
  } catch (error) {
    log.error('mod-action trigger failed', { reason: describeError(error) });
  }

  return c.json({ status: 'ok' });
});
