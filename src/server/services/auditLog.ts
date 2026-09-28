import { CONFIG, KEY_PREFIX } from '../config.js';
import type { RedisPort } from '../data/redisPort.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { formatDisplayDate } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import type { RedditPort } from './redditPort.js';

/**
 * A durable, human-readable record of every verification, kept OUTSIDE Redis.
 *
 * WHY THIS EXISTS: the app's Redis data lives with the installation. An app
 * upgrade keeps it, but uninstalling the app discards it permanently, and it
 * cannot be read or exported by a human at all. That makes Redis a fine working
 * store and a poor system of record.
 *
 * So every completed verification is also appended to a subreddit wiki page:
 *  - it survives the app being removed and reinstalled;
 *  - the wiki keeps its own revision history, so a bad write is recoverable;
 *  - moderators can read and search it without any tooling.
 *
 * WHAT IS DELIBERATELY NOT WRITTEN: the moderator's internal note. Wiki pages
 * are readable by anyone unless restricted, notes routinely contain clinic
 * phone numbers and case details, and one misconfigured permission would
 * publish them. The note stays in Redis and in the mod note. New pages are
 * created MODS_ONLY and unlisted as a second line of defence.
 */
export type AuditLogService = {
  /** Appends one verification. Called from a scheduled job, never inline. */
  record(record: VerificationRecord): Promise<void>;
};

export type AuditLogDeps = {
  reddit: RedditPort;
  redis: RedisPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

/** Page names rotate monthly so no single page approaches Reddit's size cap. */
export function auditPageName(basePage: string, epochMs: number): string {
  const shifted = new Date(epochMs + CONFIG.displayTimeZoneOffsetMinutes * 60_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${basePage}/${shifted.getUTCFullYear()}-${month}`;
}

/** Markdown table cells cannot contain a raw pipe or newline. */
function cell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ').trim();
}

function checklistCell(record: VerificationRecord): string {
  if (!record.checklist || record.checklist.length === 0) return 'not used';

  const ticked = record.checklist.filter((item) => item.checked);
  if (ticked.length === 0) return `0/${record.checklist.length}`;

  return `${ticked.length}/${record.checklist.length}: ${ticked
    .map((item) => item.label)
    .join('; ')}`;
}

/** The header a freshly created monthly page starts with. */
export function auditPageHeader(subredditName: string): string {
  return [
    `# Fundraiser verification log - r/${subredditName}`,
    '',
    'Written automatically by the mod team bot, one row per verified fundraiser.',
    'Moderator notes are deliberately not included here.',
    '',
    'This page is restricted to moderators. If you can read it without being a',
    'moderator of this community, please tell the mod team: the bot refuses to',
    'write to it unless it can confirm the restriction, so something is wrong.',
    '',
    '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice |',
    '| --- | --- | --- | --- | --- | --- |',
  ].join('\n');
}

export function auditRow(record: VerificationRecord, subredditName: string): string {
  const when = formatDisplayDate(
    record.verifiedAtMs,
    CONFIG.displayTimeZoneOffsetMinutes,
    CONFIG.displayTimeZoneLabel,
  );
  const link = `https://www.reddit.com/r/${subredditName}/comments/${record.postId.replace('t3_', '')}/`;

  const cells = [
    cell(when),
    `[${cell(record.postId)}](${link})`,
    cell(record.authorName ? `u/${record.authorName}` : '[deleted]'),
    cell(`u/${record.modName}`),
    cell(checklistCell(record)),
    cell(record.templateLabel ?? 'default'),
  ];
  return `| ${cells.join(' | ')} |`;
}

export function createAuditLogService(deps: AuditLogDeps): AuditLogService {
  const { reddit, redis, settings, log, now } = deps;
  const lockKey = `${KEY_PREFIX}:auditlock`;

  /**
   * The wiki append is a read-modify-write, so two verifications landing at
   * once could lose a row. A short Redis lock serialises them; the loser is
   * simply retried by the scheduler's own redelivery.
   */
  async function withLock<T>(operation: () => Promise<T>): Promise<T | null> {
    const owner = `${now()}-${Math.random()}`;
    await redis.set(lockKey, owner, {
      nx: true,
      expiration: new Date(now() + CONFIG.audit.lockTtlSeconds * 1000),
    });
    if ((await redis.get(lockKey)) !== owner) return null;

    try {
      return await operation();
    } finally {
      if ((await redis.get(lockKey)) === owner) await redis.del(lockKey);
    }
  }

  /**
   * Appends one row, serialised behind the lock.
   *
   * Only ever called once the page has been confirmed moderator-only.
   */
  async function appendRow(
    page: string,
    subredditName: string,
    record: VerificationRecord,
    row: string,
  ): Promise<void> {
    const result = await withLock(async () => {
      const existing = await reddit.readWikiPage(page);

      // A page nearing Reddit's size cap is left alone; next month's page takes
      // over. Rotating monthly makes this a safety net, not a routine event.
      if (existing !== null && existing.length > CONFIG.audit.maxPageBytes) {
        log.warn('audit log page is full; skipping this row', { page });
        return;
      }

      // Guard against a redelivered job writing the same row twice.
      if (existing !== null && existing.includes(record.postId)) {
        log.info('audit log already contains this post', { page, postId: record.postId });
        return;
      }

      const content =
        existing === null ? `${auditPageHeader(subredditName)}\n${row}` : `${existing}\n${row}`;
      await reddit.writeWikiPage(page, content, `Verified ${record.postId}`);
    });

    if (result === null) {
      log.warn('audit log busy; another verification holds the lock', { postId: record.postId });
    }
  }

  return {
    async record(record): Promise<void> {
      const config = await settings.get();
      if (!config.enabled) return;

      const subredditName = reddit.subredditName();
      const row = auditRow(record, subredditName);

      if (config.wikiLogEnabled) {
        const page = auditPageName(config.wikiLogPage, record.verifiedAtMs);

        // Reddit's default wiki permission is world-readable. The row names the
        // verifying moderator, and this app exists precisely so moderators are
        // not publicly attached to verifications - so nothing is written until
        // the page is PROVEN moderator-only. This fails closed on purpose.
        const isPrivate = await reddit.ensureWikiPagePrivate(page, auditPageHeader(subredditName));

        if (!isPrivate) {
          // Skip the wiki only. Mod Discussions is a separate channel and is
          // not affected by a wiki permission problem.
          log.error('skipping the wiki log: page could not be confirmed moderator-only', {
            page,
            postId: record.postId,
          });
        } else {
          await appendRow(page, subredditName, record, row);
        }
      }

      if (config.modmailLogEnabled) {
        try {
          await reddit.sendModDiscussion(
            `Fundraiser verified: ${record.postId}`,
            modDiscussionBody(record, subredditName),
          );
        } catch (error) {
          log.error('could not post the verification to mod discussions', {
            postId: record.postId,
            reason: describeError(error),
          });
        }
      }
    },
  };
}

/** The Mod Discussions message. Same facts as the wiki row, laid out to read. */
export function modDiscussionBody(record: VerificationRecord, subredditName: string): string {
  const when = formatDisplayDate(
    record.verifiedAtMs,
    CONFIG.displayTimeZoneOffsetMinutes,
    CONFIG.displayTimeZoneLabel,
  );
  const link = `https://www.reddit.com/r/${subredditName}/comments/${record.postId.replace('t3_', '')}/`;

  const lines = [
    `**Fundraiser approved** - [${record.postId}](${link})`,
    '',
    `- Fundraiser by: ${record.authorName ? `u/${record.authorName}` : '[deleted]'}`,
    `- Verified by: u/${record.modName}`,
    `- When: ${when}`,
    `- Notice posted: ${record.templateLabel ?? 'default'}`,
  ];

  if (record.checklist && record.checklist.length > 0) {
    const ticked = record.checklist.filter((item) => item.checked).length;
    lines.push(`- Checklist: ${ticked}/${record.checklist.length}`);
    for (const item of record.checklist) {
      lines.push(`  - ${item.checked ? '[x]' : '[ ]'} ${item.label}`);
    }
  } else {
    lines.push('- Checklist: not used');
  }

  // The internal note is intentionally absent; see the note at the top of this
  // module. It stays in the app record and the mod note on the OP.
  return lines.join('\n');
}
