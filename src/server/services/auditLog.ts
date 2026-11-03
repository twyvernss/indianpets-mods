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
 * The moderator's internal note IS written here. The wiki is the app's only
 * record that outlives an uninstall (the app no longer leaves mod notes), and a
 * verification without its note loses the part that says what was checked.
 * Notes routinely contain clinic phone numbers and case details, so nothing is
 * written until the page is PROVEN moderator-only - read back from Reddit on
 * every write - and pages are created MODS_ONLY and unlisted.
 */
export type AuditLogService = {
  /**
   * Appends one verification. Called from a scheduled job, never inline.
   *
   * `backfill` re-logs an old verification: the wiki row is written if it is
   * missing, but nothing is re-posted to Mod Discussions.
   */
  record(record: VerificationRecord, options?: { backfill?: boolean }): Promise<void>;

  /**
   * Proves, on demand, that the wiki log is actually working.
   *
   * Runs exactly what a verification runs - this month's page name, the same
   * privacy check - and reports what it found. Without this, the only evidence
   * the log works is a line in `devvit logs` after a real verification, which
   * is a poor way to discover that a subreddit has its wiki switched off.
   */
  check(): Promise<WikiLogCheck>;
};

/** What {@link AuditLogService.check} found. */
export type WikiLogCheck =
  | { kind: 'off' }
  | { kind: 'ready'; page: string; openPage: string; rows: number; createdNow: boolean }
  | { kind: 'blocked'; page: string; reason: string };

export type AuditLogDeps = {
  reddit: RedditPort;
  redis: RedisPort;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

/**
 * Where a moderator should open a wiki page: on old.reddit.
 *
 * New Reddit's wiki view says "does not exist" for pages it will not render -
 * moderator-only pages, and every page on a subreddit whose wiki is switched
 * off - even when the page is there. old.reddit shows them to moderators.
 */
export function wikiPageUrl(subredditName: string, page: string): string {
  return `https://old.reddit.com/r/${subredditName}/wiki/${page}`;
}

/** Page names rotate monthly so no single page approaches Reddit's size cap. */
export function auditPageName(basePage: string, epochMs: number): string {
  const shifted = new Date(epochMs + CONFIG.displayTimeZoneOffsetMinutes * 60_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${basePage}/${shifted.getUTCFullYear()}-${month}`;
}

/** Markdown table cells cannot contain a raw pipe or newline. */
export function cell(value: string): string {
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
export function auditPageHeader(subredditName: string, basePage?: string): string {
  return [
    `# Fundraiser verification log - r/${subredditName}`,
    '',
    'Written automatically by the mod team bot, one row per verified fundraiser.',
    ...(basePage ? [`[All months and poster history pages](${wikiPageUrl(subredditName, basePage)})`] : []),
    '',
    'This page is restricted to moderators. If you can read it without being a',
    'moderator of this community, please tell the mod team: the bot refuses to',
    'write to it unless it can confirm the restriction, so something is wrong.',
    '',
    AUDIT_TABLE_HEADER,
    AUDIT_TABLE_RULE,
  ].join('\n');
}

/**
 * The moderator-only start page, at `{basePage}` itself.
 *
 * Every page this app writes is unlisted, so none of them appear in the wiki's
 * page list and the wiki tab cannot reach them. This one page links them all,
 * so the mod team has a single address to bookmark. Rebuilt whole from the
 * list of months, never edited in place.
 */
export function hubPageContent(subredditName: string, basePage: string, monthPages: readonly string[]): string {
  const months = [...monthPages].sort().reverse();
  return [
    `# Fundraiser records - r/${subredditName}`,
    '',
    'Moderators only. Kept up to date by the mod team bot - bookmark this page.',
    '',
    `- **[Poster history pages](${wikiPageUrl(subredditName, `${basePage}/users`)})** - one page per poster: every post with links, who verified it, and which accounts they match.`,
    '',
    '## Verification log, by month',
    '',
    ...(months.length > 0
      ? months.map((page) => `- [${page.slice(page.lastIndexOf('/') + 1)}](${wikiPageUrl(subredditName, page)})`)
      : ['Nothing logged yet.']),
  ].join('\n');
}

const AUDIT_TABLE_HEADER =
  '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice | Mod note |';
const AUDIT_TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- |';

/** The six-column header that pages written before the note column carry. */
const LEGACY_TABLE_HEADER = [
  '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');

/**
 * Widens a page started before the note column existed.
 *
 * Markdown drops cells beyond the header's width, so without this a note added
 * mid-month would be written but invisible until next month's page.
 */
export function upgradeAuditHeader(content: string): string {
  return content.includes(LEGACY_TABLE_HEADER)
    ? content.replace(LEGACY_TABLE_HEADER, `${AUDIT_TABLE_HEADER}\n${AUDIT_TABLE_RULE}`)
    : content;
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
    cell(record.note.length > 0 ? record.note : '-'),
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
    basePage: string,
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
        existing === null
          ? `${auditPageHeader(subredditName, basePage)}\n${row}`
          : `${upgradeAuditHeader(existing)}\n${row}`;
      await reddit.writeWikiPage(page, content, `Verified ${record.postId}`);
    });

    if (result === null) {
      log.warn('audit log busy; another verification holds the lock', { postId: record.postId });
    }
  }

  const monthsKey = `${KEY_PREFIX}:hubmonths`;

  /**
   * Makes sure the start page lists `monthPage`, rewriting it when the month
   * is new or when `force` is set. The month list lives in Redis so the page
   * is rebuilt whole rather than parsed and patched.
   */
  async function updateHub(basePage: string, monthPage: string, force: boolean): Promise<boolean> {
    const added = await redis.zAdd(monthsKey, { member: monthPage, score: 0 });
    if (added === 0 && !force) return true;

    const subredditName = reddit.subredditName();
    try {
      const privacy = await reddit.ensureWikiPagePrivate(
        basePage,
        hubPageContent(subredditName, basePage, []),
      );
      if (!privacy.ok) throw new Error(privacy.reason);

      const months = (await redis.zRange(monthsKey, 0, Number.MAX_SAFE_INTEGER, { by: 'score' }))
        .map((entry) => entry.member)
        .filter((page) => page.startsWith(`${basePage}/`));
      await reddit.writeWikiPage(
        basePage,
        hubPageContent(subredditName, basePage, months),
        'Update the start page',
      );
      return true;
    } catch (error) {
      // Forget the month so the next verification tries again.
      if (added > 0) await redis.zRem(monthsKey, [monthPage]);
      log.error('could not update the wiki start page', { basePage, reason: describeError(error) });
      return false;
    }
  }

  return {
    async record(record, options = {}): Promise<void> {
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
        const privacy = await reddit.ensureWikiPagePrivate(
          page,
          auditPageHeader(subredditName, config.wikiLogPage),
        );

        if (!privacy.ok) {
          // Skip the wiki only. Mod Discussions is a separate channel and is
          // not affected by a wiki permission problem.
          log.error('skipping the wiki log: page could not be confirmed moderator-only', {
            page,
            postId: record.postId,
            reason: privacy.reason,
          });
        } else {
          await appendRow(page, config.wikiLogPage, subredditName, record, row);
          await updateHub(config.wikiLogPage, page, false);
        }
      }

      if (config.modmailLogEnabled && !options.backfill) {
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

    async check(): Promise<WikiLogCheck> {
      const config = await settings.get();
      if (!config.enabled || !config.wikiLogEnabled) return { kind: 'off' };

      const subredditName = reddit.subredditName();
      const page = auditPageName(config.wikiLogPage, now());

      // Whether the page existed BEFORE the check matters: the check creates it
      // if it is missing, and a moderator should be told that happened rather
      // than wondering where a new wiki page came from.
      const before = await reddit.readWikiPage(page);

      const privacy = await reddit.ensureWikiPagePrivate(
        page,
        auditPageHeader(subredditName, config.wikiLogPage),
      );
      if (!privacy.ok) {
        log.error('wiki log check failed', { page, reason: privacy.reason });
        return { kind: 'blocked', page, reason: privacy.reason };
      }

      const content = before ?? (await reddit.readWikiPage(page));
      log.info('wiki log check passed', { page, existed: before !== null });

      // The start page is what the moderator is sent to, so it is refreshed
      // here even when nothing new was logged. Falls back to this month's page.
      const hubReady = await updateHub(config.wikiLogPage, page, true);

      return {
        kind: 'ready',
        page,
        openPage: hubReady ? config.wikiLogPage : page,
        rows: countRows(content),
        createdNow: before === null,
      };
    },
  };
}

/**
 * Rows currently on a log page.
 *
 * Counts post ids rather than table rows, so the two header lines and any note
 * a moderator adds by hand are not mistaken for verifications. `auditRow`
 * writes the prefixed id exactly once per row - the permalink it builds
 * alongside has the prefix stripped - so occurrences and rows are the same
 * number.
 */
export function countRows(content: string | null): number {
  if (!content) return 0;
  return content.split('t3_').length - 1;
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

  if (record.note.length > 0) lines.push('', `**Mod note:** ${record.note}`);
  return lines.join('\n');
}
