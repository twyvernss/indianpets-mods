import type { T3 } from '@devvit/web/shared';
import { CONFIG, JOBS } from '../config.js';
import type { LinkRepo } from '../data/linkRepo.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { collectLinks } from '../lib/urls.js';
import type { SettingsReader } from '../settings.js';
import { buildAuthorRiskNote, buildDuplicateReportReason } from '../text.js';
import type { DuplicateFinding, LinkRecord } from '../types.js';
import type { RedditPort, SchedulerPort } from './redditPort.js';

export type DuplicateDeps = {
  links: LinkRepo;
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
  const { links, reddit, scheduler, settings, log, now } = deps;

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

      let finding: DuplicateFinding | null = null;
      const claimed: string[] = [];

      for (const link of found) {
        const existing = owners.get(link.key);

        if (existing && existing.postId !== input.postId) {
          // Report the FIRST duplicate only. A post that repeats one campaign
          // across five URL shapes is one problem, not five modqueue entries.
          finding ??= {
            postId: input.postId,
            author: input.author,
            originalPostId: existing.postId,
            originalAuthor: existing.author,
            display: link.display,
            shortened: link.shortened,
            sameAuthor:
              existing.author !== null &&
              input.author !== null &&
              existing.author.toLowerCase() === input.author.toLowerCase(),
          };
          continue;
        }

        if (existing) continue; // This post already owns it (redelivered trigger).

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
          claimed.push(link.key);
        } else if (!finding) {
          finding = {
            postId: input.postId,
            author: input.author,
            originalPostId: owner.postId,
            originalAuthor: owner.author,
            display: link.display,
            shortened: link.shortened,
            sameAuthor:
              owner.author !== null &&
              input.author !== null &&
              owner.author.toLowerCase() === input.author.toLowerCase(),
          };
        }
      }

      await links.rememberPostLinks(input.postId, claimed, timestamp);

      if (!finding) return null;

      if (finding.sameAuthor && !config.reportSameAuthorReposts) {
        // "Flagged more quietly": recorded in the logs, no modqueue entry.
        scoped.info('same-author repost (not reported)', {
          originalPostId: finding.originalPostId,
        });
        return null;
      }

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
        sameAuthor: finding.sameAuthor,
        shortened: finding.shortened,
      });
      return finding;
    },

    async report(finding): Promise<void> {
      const config = await settings.get();
      if (!config.enabled || !config.duplicateDetectionEnabled) return;

      let reason = buildDuplicateReportReason(finding);

      // Author thresholds only ever annotate a report that was going to happen
      // anyway. They never cause one, and they never cause a removal.
      if (finding.author && (config.minAccountAgeDays > 0 || config.minKarma > 0)) {
        const author = await reddit.getAuthor(finding.author);
        if (author) {
          const note = buildAuthorRiskNote({
            accountAgeDays: author.accountAgeDays,
            karma: author.karma,
            belowAge: config.minAccountAgeDays > 0 && author.accountAgeDays < config.minAccountAgeDays,
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
    typeof candidate['sameAuthor'] === 'boolean'
  );
}
