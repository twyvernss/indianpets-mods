import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { daysBetween } from '../lib/time.js';
import type { AppSettings, SettingsReader } from '../settings.js';
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

/** The two things that can happen to a fundraiser that has gone quiet. */
export type FollowUpStep = 'remind' | 'escalate';

/** What the app knows about one post's follow-up state, for the form. */
export type FollowUpInspection =
  | {
      kind: 'ready';
      record: VerificationRecord;
      /** What the nightly sweep would do next, once the waiting time is up. */
      nextStep: FollowUpStep;
      daysSinceVerified: number;
      /** Null until a reminder has been sent. */
      daysSinceReminder: number | null;
      settings: AppSettings;
    }
  | { kind: 'no-record' }
  | { kind: 'not-verified' }
  | { kind: 'deleted' };

export type FollowUpResult =
  | { kind: 'reminded' }
  | { kind: 'escalated'; locked: boolean }
  | { kind: 'already-reminded'; atMs: number }
  | { kind: 'already-escalated'; atMs: number }
  | { kind: 'no-record' }
  | { kind: 'not-verified' }
  | { kind: 'deleted' }
  | { kind: 'post-missing' }
  | { kind: 'busy' }
  | { kind: 'disabled' }
  | { kind: 'failed'; detail: string };

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

  /** Read-only: what the app knows about this post's follow-up state. */
  inspectFollowUp(postId: T3): Promise<FollowUpInspection>;

  /**
   * Runs the stale-fundraiser follow-up on ONE post, now, because a moderator
   * asked for it.
   *
   * This calls exactly the same `sendReminder` and `escalate` the nightly sweep
   * calls - same comment, same report wording, same record bookkeeping, same
   * rollback. The ONLY difference is that the configured waiting periods are
   * treated as satisfied, since an explicit moderator request is a better
   * signal than a day count. That makes this both a useful mod tool and the way
   * to prove the chase works without waiting a month for it.
   */
  runFollowUp(input: { postId: T3; step: FollowUpStep | 'next' }): Promise<FollowUpResult>;
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

    async inspectFollowUp(postId): Promise<FollowUpInspection> {
      const [record, config] = await Promise.all([repo.get(postId), settings.get()]);

      if (!record) return { kind: 'no-record' };
      if (record.status !== 'complete') return { kind: 'not-verified' };
      if (record.deletedAtMs !== null) return { kind: 'deleted' };

      const timestamp = now();
      return {
        kind: 'ready',
        record,
        nextStep: record.reminderSentAtMs === null ? 'remind' : 'escalate',
        daysSinceVerified: daysBetween(record.verifiedAtMs, timestamp),
        daysSinceReminder:
          record.reminderSentAtMs === null
            ? null
            : daysBetween(record.reminderSentAtMs, timestamp),
        settings: config,
      };
    },

    async runFollowUp({ postId, step }): Promise<FollowUpResult> {
      const config = await settings.get();
      // The master switch still applies. `staleRemindersEnabled` deliberately
      // does NOT: a moderator asking for this directly is a decision in itself,
      // and it is how the feature gets tried out before being switched on.
      if (!config.enabled) return { kind: 'disabled' };

      const timestamp = now();
      const owner = `followup-${timestamp}-${Math.random()}`;

      // The same lock the verify flow uses. Two taps on a phone would otherwise
      // both read `reminderSentAtMs === null` and post two reminders.
      if (!(await repo.acquireLock(postId, owner, timestamp))) return { kind: 'busy' };

      try {
        const record = await repo.get(postId);
        if (!record) return { kind: 'no-record' };
        if (record.status !== 'complete') return { kind: 'not-verified' };
        if (record.deletedAtMs !== null) return { kind: 'deleted' };

        const chosen: FollowUpStep =
          step === 'next' ? (record.reminderSentAtMs === null ? 'remind' : 'escalate') : step;

        if (chosen === 'remind') {
          // Idempotent: never a second reminder on the same post.
          if (record.reminderSentAtMs !== null) {
            return { kind: 'already-reminded', atMs: record.reminderSentAtMs };
          }

          if ((await sendReminder(record, timestamp)) === 'post-missing') {
            return { kind: 'post-missing' };
          }

          log.info('reminder sent at a moderator request', {
            postId,
            daysSinceVerified: daysBetween(record.verifiedAtMs, timestamp),
          });
          return { kind: 'reminded' };
        }

        if (record.escalatedAtMs !== null) {
          return { kind: 'already-escalated', atMs: record.escalatedAtMs };
        }

        const { locked } = await escalate(record, timestamp, config.lockStalePosts);
        log.info('stale fundraiser escalated at a moderator request', { postId, locked });
        return { kind: 'escalated', locked };
      } catch (error) {
        const detail = describeError(error);
        log.error('moderator-requested follow-up failed', { postId, step, reason: detail });
        return { kind: 'failed', detail };
      } finally {
        await repo.releaseLock(postId, owner);
      }
    },
  };

  /**
   * Asks the OP for an update, and records that we did.
   *
   * Ordering mirrors the verification flow: the record is updated BEFORE the
   * Reddit write and rolled back if the write fails. Double-commenting on
   * someone's fundraiser is a far worse failure than missing one reminder,
   * which the next sweep picks up anyway.
   */
  async function sendReminder(
    record: VerificationRecord,
    timestamp: number,
  ): Promise<'reminded' | 'post-missing'> {
    const post = await reddit.getPost(record.postId);
    if (!post) {
      // Gone from Reddit: stop chasing and scrub, per the deletion rules.
      await repo.markDeleted(record.postId, timestamp);
      return 'post-missing';
    }

    const config = await settings.get();
    const daysSinceVerified = daysBetween(record.verifiedAtMs, timestamp);

    await repo.update({ ...record, reminderSentAtMs: timestamp });

    let comment;
    try {
      comment = await reddit.submitAppComment(
        record.postId,
        buildReminderComment({
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

    // Pinned and distinguished, like the verification notice: the OP needs to
    // see it, and so does anyone deciding whether to donate today.
    //
    // Best-effort on purpose. Reddit allows only two stickied comments per
    // post, so this can legitimately fail on a busy post - and a reminder that
    // is merely unpinned is far better than one rolled back and re-posted,
    // which would comment on the fundraiser twice.
    try {
      await comment.distinguishAndSticky();
    } catch (error) {
      log.warn('posted the reminder but could not pin it', {
        postId: record.postId,
        reason: describeError(error),
      });
    }

    return 'reminded';
  }

  /**
   * Sends an unanswered fundraiser to the modqueue, and locks it if the
   * subreddit opted in.
   *
   * Report, never remove: a human decides what happens to the post. The report
   * is rolled back on failure for the same reason reminders are. The LOCK is
   * best-effort on purpose - the post is already reported by then, and throwing
   * here would skip `closeOpen` and let the next sweep report it a second time.
   */
  async function escalate(
    record: VerificationRecord,
    timestamp: number,
    lockStalePosts: boolean,
  ): Promise<{ locked: boolean }> {
    const daysSinceVerified = daysBetween(record.verifiedAtMs, timestamp);

    await repo.update({ ...record, escalatedAtMs: timestamp });
    try {
      await reddit.reportPost(record.postId, buildStaleReportReason(daysSinceVerified));
    } catch (error) {
      await repo.update({ ...record, escalatedAtMs: null });
      throw error;
    }

    let locked = false;
    if (lockStalePosts) {
      try {
        await reddit.lockPost(record.postId);
        locked = true;
      } catch (error) {
        log.error('reported the stale fundraiser but could not lock it', {
          postId: record.postId,
          reason: describeError(error),
        });
      }
    }

    await repo.closeOpen(record.postId);
    return { locked };
  }

  /**
   * Decides which of the two actions one stale verification is due, and applies
   * it. The nightly sweep's decision function.
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
      return (await sendReminder(record, timestamp)) === 'reminded' ? 'reminded' : 'closed';
    }

    if (timestamp - record.reminderSentAtMs < graceMs) return 'waiting';

    await escalate(record, timestamp, lockStalePosts);
    return 'escalated';
  }
}
