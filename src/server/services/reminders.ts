import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { daysBetween } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import { buildReminderComment, buildStaleReportReason } from '../text.js';
import type { VerificationRecord } from '../types.js';
import type { RedditPort, SchedulerPort } from './redditPort.js';

export type ReminderDeps = {
  repo: VerificationRepo;
  reddit: RedditPort;
  scheduler: SchedulerPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

export type SweepResult = {
  examined: number;
  reminded: number;
  escalated: number;
  closed: number;
  /** True when another batch was queued because this page was full. */
  chained: boolean;
};

export type ReminderService = {
  /**
   * Processes one bounded page of stale verifications.
   *
   * `offset` pages through the open index; `batchIndex` caps how many times one
   * nightly trigger may chain into another run.
   */
  sweep(input: { offset: number; batchIndex: number }): Promise<SweepResult>;

  /**
   * Called when any comment appears. If it is the OP on a post we are chasing,
   * the chase stops. Event-driven, so no polling is needed to notice a reply.
   */
  noteOpActivity(input: { postId: T3; author: string }): Promise<void>;
};

export function createReminderService(deps: ReminderDeps): ReminderService {
  const { repo, reddit, scheduler, settings, log, now } = deps;

  return {
    async sweep({ offset, batchIndex }): Promise<SweepResult> {
      const empty: SweepResult = {
        examined: 0,
        reminded: 0,
        escalated: 0,
        closed: 0,
        chained: false,
      };

      const config = await settings.get();
      if (!config.enabled || !config.staleRemindersEnabled) return empty;

      const timestamp = now();
      const reminderCutoff = timestamp - config.reminderDays * 86_400_000;
      const graceMs = config.graceDays * 86_400_000;

      const candidates = await repo.openBefore(
        reminderCutoff,
        CONFIG.reminders.batchSize,
        offset,
      );
      if (candidates.length === 0) return empty;

      // One batched read for the whole page - never one call per post.
      const records = await repo.getMany(candidates);

      const result: SweepResult = { ...empty, examined: records.length };

      for (const record of records) {
        try {
          const outcome = await handleOne(record, timestamp, graceMs, config.lockStalePosts);
          if (outcome === 'reminded') result.reminded += 1;
          else if (outcome === 'escalated') result.escalated += 1;
          else if (outcome === 'closed') result.closed += 1;
        } catch (error) {
          // One bad post must not abandon the rest of the page. It stays in the
          // open index and is retried on the next sweep.
          log.error('stale sweep failed for one post', {
            postId: record.postId,
            reason: describeError(error),
          });
        }
      }

      // A full page means there is probably more. Chain another run rather than
      // trying to drain everything inside one 30s request.
      const full = candidates.length === CONFIG.reminders.batchSize;
      const mayChain = batchIndex + 1 < CONFIG.reminders.maxChainedBatches;

      if (full && mayChain) {
        try {
          await scheduler.runJob({
            name: JOBS.staleSweepBatch,
            data: { offset: offset + candidates.length, batchIndex: batchIndex + 1 },
            runAt: new Date(timestamp + CONFIG.reminders.chainDelaySeconds * 1000),
          });
          result.chained = true;
        } catch (error) {
          log.error('could not chain the next sweep batch', { reason: describeError(error) });
        }
      } else if (full) {
        log.warn('stale sweep hit its chain limit; remaining posts wait for the next run', {
          offset,
          batchIndex,
        });
      }

      log.info('stale sweep batch done', {
        offset,
        batchIndex,
        examined: result.examined,
        reminded: result.reminded,
        escalated: result.escalated,
        closed: result.closed,
        chained: result.chained,
      });

      return result;
    },

    async noteOpActivity({ postId, author }): Promise<void> {
      // Cheapest possible filter first: one Redis GET, and almost every comment
      // in the subreddit stops here.
      const record = await repo.get(postId);
      if (!record || record.status !== 'complete') return;
      if (!record.authorName || record.authorName.toLowerCase() !== author.toLowerCase()) return;
      if (record.opRespondedAtMs !== null) return; // Already noted.
      if (record.reminderSentAtMs === null) return; // Not being chased yet.

      await repo.update({ ...record, opRespondedAtMs: now() });
      await repo.closeOpen(postId);

      log.info('OP replied after a reminder; chase closed', { postId });
    },
  };

  /**
   * Decides and applies what should happen to one stale verification.
   *
   * Ordering mirrors the verification flow: the record is updated BEFORE the
   * Reddit write and rolled back if the write fails. Double-commenting on
   * someone's fundraiser is a far worse failure than missing one reminder,
   * which the next sweep picks up anyway.
   */
  async function handleOne(
    record: VerificationRecord,
    timestamp: number,
    graceMs: number,
    lockStalePosts: boolean,
  ): Promise<'reminded' | 'escalated' | 'closed' | 'waiting'> {
    // Deleted, removed or already-answered posts leave the chase quietly.
    if (record.deletedAtMs !== null || record.opRespondedAtMs !== null) {
      await repo.closeOpen(record.postId);
      return 'closed';
    }

    if (record.reminderSentAtMs === null) {
      const post = await reddit.getPost(record.postId);
      if (!post) {
        // Gone from Reddit: stop chasing and scrub, per the deletion rules.
        await repo.markDeleted(record.postId, timestamp);
        return 'closed';
      }

      const config = await settings.get();
      const daysSinceVerified = daysBetween(record.verifiedAtMs, timestamp);

      await repo.update({ ...record, reminderSentAtMs: timestamp });
      try {
        await reddit.submitAppComment(
          record.postId,
          renderReminder({
            custom: config.customReminderText,
            subredditName: reddit.subredditName(),
            authorName: record.authorName,
            daysSinceVerified,
            graceDays: config.graceDays,
          }),
        );
      } catch (error) {
        // Roll back so the next sweep tries again rather than silently skipping.
        await repo.update({ ...record, reminderSentAtMs: null });
        throw error;
      }
      return 'reminded';
    }

    if (timestamp - record.reminderSentAtMs < graceMs) return 'waiting';

    const daysSinceVerified = daysBetween(record.verifiedAtMs, timestamp);
    await repo.update({ ...record, escalatedAtMs: timestamp });

    // Report, never remove. A human decides what happens to the post.
    await reddit.reportPost(record.postId, buildStaleReportReason(daysSinceVerified));
    if (lockStalePosts) await reddit.lockPost(record.postId);

    await repo.closeOpen(record.postId);
    return 'escalated';
  }
}

/** Applies the subreddit's custom reminder wording, or the built-in default. */
function renderReminder(input: {
  custom: string;
  subredditName: string;
  authorName: string | null;
  daysSinceVerified: number;
  graceDays: number;
}): string {
  if (input.custom.trim().length > 0) {
    return input.custom
      .replaceAll('{subreddit}', input.subredditName)
      .replaceAll('{op}', input.authorName ? `u/${input.authorName}` : 'Hi there')
      .replaceAll('{days}', String(input.daysSinceVerified))
      .replaceAll('{grace}', String(input.graceDays));
  }

  return buildReminderComment({
    subredditName: input.subredditName,
    authorName: input.authorName,
    daysSinceVerified: input.daysSinceVerified,
    graceDays: input.graceDays,
  });
}
