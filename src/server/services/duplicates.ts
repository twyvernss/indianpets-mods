import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import type { LinkRepo } from '../data/linkRepo.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { collectLinks } from '../lib/urls.js';
import type { SettingsReader } from '../settings.js';
import { buildAuthorRiskNote, buildDuplicateReportReason } from '../text.js';
import type { DuplicateFinding, LinkRecord } from '../types.js';
import type { RedditPort, SchedulerPort } from './redditPort.js';

const HOUR_MS = 3_600_000;

export type DuplicateDeps = {
  links: LinkRepo;
  /** Read-only here: used to say whether the earlier post was already verified. */
  records: VerificationRepo;
  reddit: RedditPort;
  scheduler: SchedulerPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

export type DuplicateService = {
  /**
   * Runs on the post-submit trigger. Does Redis work only, then hands any
   * finding to the scheduler. Must stay fast and must be safe to run twice.
   */
  inspectPost(input: {
    postId: T3;
    author: string | null;
    title: string;
    body: string;
    url: string;
  }): Promise<DuplicateFinding | null>;

  /** Files the modqueue report. Runs from a scheduled job, off the hot path. */
  report(finding: DuplicateFinding): Promise<void>;

  /** Called from the delete trigger so a removed post stops owning its links. */
  forgetPost(postId: T3): Promise<void>;
};

export function createDuplicateService(deps: DuplicateDeps): DuplicateService {
  const { links, records, reddit, scheduler, settings, log, now } = deps;

  return {
    async inspectPost(input): Promise<DuplicateFinding | null> {
      const config = await settings.get();
      if (!config.enabled || !config.duplicateDetectionEnabled) return null;

      const found = collectLinks(
        { title: input.title, body: input.body, url: input.url },
        CONFIG.duplicates.maxLinksPerPost,
      );
      if (found.length === 0) return null;

      const timestamp = now();
      const scoped = log.child({ postId: input.postId, linkCount: found.length });

      // One batched read for every link in the post - never one call per link.
      const owners = await links.findOwners(found.map((link) => link.key));

      /** Keys this post should end up owning. */
      const owned: string[] = [];
      /** Keys currently held by an earlier post. */
      const contested: string[] = [];
      let earliest: { record: LinkRecord; display: string; shortened: boolean } | null = null;

      for (const link of found) {
        const existing = owners.get(link.key);

        if (existing && existing.postId !== input.postId) {
          contested.push(link.key);
          // Report against the OLDEST clash, so the age we quote is the real
          // gap between this post and the first time we saw the link.
          if (!earliest || existing.firstSeenMs < earliest.record.firstSeenMs) {
            earliest = { record: existing, display: link.display, shortened: link.shortened };
          }
          continue;
        }

        if (existing) {
          // This post already owns it - a redelivered trigger.
          owned.push(link.key);
          continue;
        }

        const record: LinkRecord = {
          postId: input.postId,
          author: input.author,
          firstSeenMs: timestamp,
          display: link.display,
          shortened: link.shortened,
        };

        // `claim` resolves races: if another post claimed this link a moment
        // ago, the stored record comes back instead of ours.
        const owner = await links.claim(link.key, record, timestamp);
        if (owner.postId === input.postId) {
          owned.push(link.key);
        } else {
          contested.push(link.key);
          if (!earliest || owner.firstSeenMs < earliest.record.firstSeenMs) {
            earliest = { record: owner, display: link.display, shortened: link.shortened };
          }
        }
      }

      if (!earliest) {
        await links.rememberPostLinks(input.postId, owned, timestamp);
        return null;
      }

      const previous = earliest.record;
      const sameAuthor =
        previous.author !== null &&
        input.author !== null &&
        previous.author.toLowerCase() === input.author.toLowerCase();

      const ageMs = Math.max(0, timestamp - previous.firstSeenMs);
      const hoursSincePrevious = Math.floor(ageMs / HOUR_MS);
      const windowMs = config.sameAuthorRepostHours * HOUR_MS;

      /**
       * Hands the contested links to this post and records the whole set.
       *
       * Used when the repost is legitimate, so the newest post owns the link
       * and the "how long since last time" clock restarts from it. Without
       * this, someone allowed to repost every 24 hours would be measured
       * against their very first post forever.
       */
      const takeOver = async (): Promise<void> => {
        for (const linkKey of contested) {
          await links.transfer(
            linkKey,
            {
              postId: input.postId,
              author: input.author,
              firstSeenMs: timestamp,
              display: earliest?.display ?? '',
              shortened: earliest?.shortened ?? false,
            },
            timestamp,
          );
        }
        await links.rememberPostLinks(input.postId, [...owned, ...contested], timestamp);
      };

      if (sameAuthor) {
        // The subreddit allows a repost after `sameAuthorRepostHours`. One that
        // respects the rule is not a duplicate at all - reporting it would put
        // a legitimate post in the modqueue every single time.
        if (!config.reportSameAuthorReposts || ageMs >= windowMs) {
          await takeOver();
          scoped.info('same-author repost allowed', {
            originalPostId: previous.postId,
            hoursSincePrevious,
            reason: config.reportSameAuthorReposts ? 'outside repost window' : 'reporting disabled',
          });
          return null;
        }
      }

      await links.rememberPostLinks(input.postId, owned, timestamp);

      const finding: DuplicateFinding = {
        postId: input.postId,
        author: input.author,
        originalPostId: previous.postId,
        originalAuthor: previous.author,
        display: earliest.display,
        shortened: earliest.shortened,
        sameAuthor,
        hoursSincePrevious,
        tooSoon: sameAuthor,
      };

      // Idempotency: a redelivered trigger must not produce a second report.
      if (await links.wasReported(input.postId)) {
        scoped.info('duplicate already reported; skipping', {
          originalPostId: finding.originalPostId,
        });
        return null;
      }
      await links.markReported(input.postId, timestamp);

      // The report itself needs two or three Reddit round trips, which does not
      // belong on a trigger. Hand it to the scheduler and return.
      try {
        await scheduler.runJob({
          name: JOBS.duplicateReport,
          data: { finding: { ...finding } },
          runAt: new Date(timestamp + CONFIG.duplicates.reportDelaySeconds * 1000),
        });
      } catch (error) {
        scoped.error('could not queue duplicate report', { reason: describeError(error) });
      }

      scoped.info('duplicate link found', {
        originalPostId: finding.originalPostId,
        sameAuthor,
        tooSoon: finding.tooSoon,
        hoursSincePrevious,
        shortened: finding.shortened,
      });
      return finding;
    },

    async report(finding): Promise<void> {
      const config = await settings.get();
      if (!config.enabled || !config.duplicateDetectionEnabled) return;

      // Saying "the earlier post was already verified" is the single most
      // useful thing a moderator can know here: it usually means the documents
      // are on file and this needs a glance rather than a full re-check.
      const previousRecord = await records.get(finding.originalPostId);
      const previouslyVerified = previousRecord?.status === 'complete';

      let reason = buildDuplicateReportReason(finding, {
        previouslyVerified,
        minimumHours: config.sameAuthorRepostHours,
      });

      // Author thresholds only ever annotate a report that was going to happen
      // anyway. They never cause one, and they never cause a removal.
      if (finding.author && (config.minAccountAgeDays > 0 || config.minKarma > 0)) {
        const author = await reddit.getAuthor(finding.author);
        if (author) {
          const note = buildAuthorRiskNote({
            accountAgeDays: author.accountAgeDays,
            karma: author.karma,
            belowAge:
              config.minAccountAgeDays > 0 && author.accountAgeDays < config.minAccountAgeDays,
            belowKarma: config.minKarma > 0 && author.karma < config.minKarma,
          });
          if (note && reason.length + note.length <= CONFIG.reportReasonMaxLength) {
            reason += note;
          }
        }
      }

      await reddit.reportPost(finding.postId, reason);
      log.info('duplicate reported to modqueue', {
        postId: finding.postId,
        originalPostId: finding.originalPostId,
        sameAuthor: finding.sameAuthor,
        previouslyVerified,
      });
    },

    async forgetPost(postId): Promise<void> {
      await links.releasePostLinks(postId);
    },
  };
}

/** Narrows the JSON payload a scheduled job carries back to us. */
export function isDuplicateFinding(value: unknown): value is DuplicateFinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate['postId'] === 'string' &&
    candidate['postId'].startsWith('t3_') &&
    typeof candidate['originalPostId'] === 'string' &&
    candidate['originalPostId'].startsWith('t3_') &&
    (candidate['author'] === null || typeof candidate['author'] === 'string') &&
    (candidate['originalAuthor'] === null || typeof candidate['originalAuthor'] === 'string') &&
    typeof candidate['display'] === 'string' &&
    typeof candidate['shortened'] === 'boolean' &&
    typeof candidate['sameAuthor'] === 'boolean' &&
    typeof candidate['hoursSincePrevious'] === 'number' &&
    typeof candidate['tooSoon'] === 'boolean'
  );
}
