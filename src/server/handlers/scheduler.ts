import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { Hono } from 'hono';
import { CONFIG, JOBS } from '../config.js';
import { getContainer } from '../container.js';
import { describeError } from '../lib/logger.js';
import { formatShortDate } from '../lib/time.js';
import { asPostId } from '../data/tokenRepo.js';
import { isVerificationRecord } from '../data/verificationRepo.js';
import { isPostContent } from '../services/altMatch.js';
import { statusFromPost } from '../services/auditLog.js';
import { isDuplicateFinding } from '../services/duplicates.js';

export const jobs = new Hono();

/**
 * Scheduled work.
 *
 * Every job here is bounded: it processes a fixed-size page and, if more work
 * remains, queues its own continuation rather than trying to drain everything
 * inside one 30-second request. Devvit allows 10 live recurring actions per
 * installation and 60 `runJob` calls per minute; this app uses one cron and
 * chains at most one job a minute, well inside both.
 */

function readNumber(data: Record<string, unknown> | undefined, key: string): number {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Nightly entry point. Starts the sweep at the first page. */
jobs.post('/stale-sweep', async (c) => {
  const { log, reminders } = getContainer();

  try {
    await c.req.json<TaskRequest>().catch(() => undefined);
    await reminders.sweep({ offset: 0, batchIndex: 0 });
  } catch (error) {
    log.error('stale sweep failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/** Continuation of a sweep whose previous page was full. */
jobs.post('/stale-sweep-batch', async (c) => {
  const { log, reminders } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    await reminders.sweep({
      offset: readNumber(request.data, 'offset'),
      batchIndex: readNumber(request.data, 'batchIndex'),
    });
  } catch (error) {
    log.error('stale sweep batch failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Files a duplicate-link report.
 *
 * Runs here rather than on the post-submit trigger because reporting costs two
 * or three Reddit round trips. The finding travelled through the scheduler as
 * JSON, so it is re-validated before use.
 */
jobs.post('/duplicate-report', async (c) => {
  const { log, duplicates } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const finding = request.data?.['finding'];

    if (!isDuplicateFinding(finding)) {
      log.warn('duplicate-report job carried an unusable payload');
      return c.json<TaskResponse>({}, 200);
    }

    await duplicates.report(finding);
  } catch (error) {
    log.error('duplicate report job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Posts the "here is what we need from you" reply on a fundraiser that
 * AutoModerator has just held.
 *
 * Runs here rather than on the trigger because it costs two Reddit round trips,
 * and because a short delay lets AutoModerator's own comment land first.
 */
jobs.post('/automod-reply', async (c) => {
  const { log, intake } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const postId = asPostId(String(request.data?.['postId'] ?? ''));
    const rawAuthor = request.data?.['author'];

    if (!postId) {
      log.warn('automod-reply job carried an unusable post id');
      return c.json<TaskResponse>({}, 200);
    }

    await intake.postReply({
      postId,
      author: typeof rawAuthor === 'string' && rawAuthor.length > 0 ? rawAuthor : null,
    });
  } catch (error) {
    log.error('automod reply job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Rebuilds the per-author verification history from the records we already have.
 *
 * The history index was added after the app was first installed, so anything
 * verified before that upgrade has no author entry and would show as "no
 * previous fundraiser verified here". This runs once per app upgrade, pages
 * through every stored verification in bounded batches and fills the gaps. It
 * is idempotent: the history is a sorted set, so re-adding an entry is a no-op.
 */
jobs.post('/author-backfill', async (c) => {
  const { log, repo, scheduler } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const offset = readNumber(request.data, 'offset');
    const batchIndex = readNumber(request.data, 'batchIndex');

    const postIds = await repo.allVerified(offset, CONFIG.backfillBatchSize);
    if (postIds.length === 0) {
      log.info('author backfill complete', { offset });
      return c.json<TaskResponse>({}, 200);
    }

    const records = await repo.getMany(postIds);
    let written = 0;
    for (const record of records) {
      if (record.status !== 'complete' || !record.authorName) continue;
      await repo.recordAuthorVerification(record.authorName, record.postId, record.verifiedAtMs);
      written += 1;
    }

    log.info('author backfill batch done', { offset, examined: records.length, written });

    if (postIds.length === CONFIG.backfillBatchSize && batchIndex + 1 < CONFIG.maxBackfillBatches) {
      await scheduler.runJob({
        name: JOBS.authorBackfill,
        data: { offset: offset + postIds.length, batchIndex: batchIndex + 1 },
        runAt: new Date(Date.now() + 5_000),
      });
    }
  } catch (error) {
    log.error('author backfill failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Appends one verification to the durable wiki log.
 *
 * Off the verify path because it is a read-modify-write across two Reddit
 * calls. The record travelled here as JSON, so it is re-validated before use.
 */
jobs.post('/audit-log', async (c) => {
  const { log, audit, scheduler, settings } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const raw = request.data?.['record'];

    if (!isVerificationRecord(raw)) {
      log.warn('audit-log job carried an unusable record');
      return c.json<TaskResponse>({}, 200);
    }

    await audit.record(raw);

    // The poster's history page shows who verified what, so it is refreshed
    // whenever one of their fundraisers is verified.
    const config = await settings.get();
    if (raw.authorName && config.userHistoryEnabled) {
      await scheduler.runJob({
        name: JOBS.userHistory,
        data: { username: raw.authorName },
        runAt: new Date(Date.now() + CONFIG.history.delaySeconds * 1000),
      });
    }
  } catch (error) {
    log.error('audit log job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Fingerprints a new post and reports it if it looks like another account's.
 *
 * Queued by the post-submit trigger with the post's text, which is
 * re-validated here because it travelled through the scheduler as JSON.
 */
jobs.post('/alt-check', async (c) => {
  const { log, alt } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const post = request.data?.['post'];

    if (!isPostContent(post)) {
      log.warn('alt-check job carried an unusable post');
      return c.json<TaskResponse>({}, 200);
    }

    await alt.check(post);
  } catch (error) {
    log.error('alt check job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Fingerprints the subreddit's recent posts, one page per run.
 *
 * Without this, matching only knows about posts made after the feature was
 * installed. Bounded to `maxBackfillBatches` pages; Reddit's own listing stops
 * at about a thousand posts anyway.
 */
jobs.post('/alt-backfill', async (c) => {
  const { log, alt, scheduler, settings } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const config = await settings.get();
    if (!config.enabled || !config.altDetectionEnabled) return c.json<TaskResponse>({}, 200);

    const after = asPostId(String(request.data?.['after'] ?? ''));
    const batchIndex = readNumber(request.data, 'batchIndex');

    const { indexed, last } = await alt.backfill(after);
    log.info('fingerprint backfill batch done', { batchIndex, indexed });

    if (last && batchIndex + 1 < CONFIG.alt.maxBackfillBatches) {
      await scheduler.runJob({
        name: JOBS.altBackfill,
        data: { after: last, batchIndex: batchIndex + 1 },
        runAt: new Date(Date.now() + 5_000),
      });
    }
  } catch (error) {
    log.error('fingerprint backfill failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/** Rebuilds one person's wiki history page, after a verification or a report. */
jobs.post('/user-history', async (c) => {
  const { log, history } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const username = request.data?.['username'];

    if (typeof username !== 'string' || !/^[\w-]{1,30}$/u.test(username)) {
      log.warn('user-history job carried an unusable username');
      return c.json<TaskResponse>({}, 200);
    }

    await history.rebuild(username);
  } catch (error) {
    log.error('user history job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Writes past verifications into the wiki log, oldest first, a few per run.
 *
 * Exists because the privacy check once misread every page as public and so
 * logged nothing; it is queued on every upgrade and is harmless when there is
 * nothing to do, because `record` skips posts already on the page.
 */
jobs.post('/audit-backfill', async (c) => {
  const { log, audit, repo, scheduler, settings, reddit } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const offset = readNumber(request.data, 'offset');
    const batchIndex = readNumber(request.data, 'batchIndex');

    const postIds = await repo.allVerified(offset, CONFIG.audit.backfillBatchSize);
    if (postIds.length === 0) {
      log.info('wiki log backfill complete', { offset });
      return c.json<TaskResponse>({}, 200);
    }

    const records = await repo.getMany(postIds);
    const config = await settings.get();
    const authors = new Set<string>();

    for (const record of records) {
      if (record.status !== 'complete') continue;
      await audit.record(record, { backfill: true });

      // Rows written before the Status column existed get today's state once.
      // A status an event already wrote is never overwritten.
      const post = await reddit.getPost(record.postId);
      await audit.setStatus({
        postId: record.postId,
        verifiedAtMs: record.verifiedAtMs,
        status: statusFromPost(post),
        onlyIfMissing: true,
      });

      const author = post?.authorName ?? record.authorName;
      if (author) authors.add(author);
    }

    // Every past poster gets a history page, so the index lists everyone and
    // "Look up a poster's history" has something to open for each of them.
    if (config.userHistoryEnabled) {
      for (const username of authors) {
        await scheduler.runJob({
          name: JOBS.userHistory,
          data: { username },
          runAt: new Date(Date.now() + CONFIG.history.delaySeconds * 1000),
        });
      }
    }
    log.info('wiki log backfill batch done', { offset, examined: records.length, authors: authors.size });

    if (
      postIds.length === CONFIG.audit.backfillBatchSize &&
      batchIndex + 1 < CONFIG.audit.maxBackfillBatches
    ) {
      await scheduler.runJob({
        name: JOBS.auditBackfill,
        data: { offset: offset + postIds.length, batchIndex: batchIndex + 1 },
        runAt: new Date(Date.now() + 5_000),
      });
    }
  } catch (error) {
    log.error('wiki log backfill failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});

/**
 * Writes a verified post's new status into its wiki log row, with the date it
 * changed. Retries a few times when another write holds the page.
 */
jobs.post('/log-status', async (c) => {
  const { log, audit, repo, scheduler } = getContainer();

  try {
    const request = await c.req.json<TaskRequest>();
    const postId = asPostId(String(request.data?.['postId'] ?? ''));
    const status = request.data?.['status'];
    const attempt = readNumber(request.data, 'attempt');
    if (!postId || typeof status !== 'string') {
      log.warn('log-status job carried an unusable payload');
      return c.json<TaskResponse>({}, 200);
    }

    const record = await repo.get(postId);
    if (!record || record.status !== 'complete') return c.json<TaskResponse>({}, 200);

    const label = status === 'up' ? 'up' : `${status}, ${formatShortDate(Date.now())}`;
    const done = await audit.setStatus({ postId, verifiedAtMs: record.verifiedAtMs, status: label });

    if (!done && attempt + 1 < 5) {
      await scheduler.runJob({
        name: JOBS.logStatus,
        data: { postId, status, attempt: attempt + 1 },
        runAt: new Date(Date.now() + 15_000),
      });
    }
  } catch (error) {
    log.error('log-status job failed', { reason: describeError(error) });
  }

  return c.json<TaskResponse>({}, 200);
});
