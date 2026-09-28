import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { Hono } from 'hono';
import { getContainer } from '../container.js';
import { describeError } from '../lib/logger.js';
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
