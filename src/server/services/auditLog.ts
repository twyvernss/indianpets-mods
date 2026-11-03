import type { T3 } from '@devvit/web/shared';
import { CONFIG, KEY_PREFIX } from '../config.js';
import type { RedisPort } from '../data/redisPort.js';
import { allByScore } from '../data/redisPort.js';
import type { Logger } from '../lib/logger.js';
import { describeError } from '../lib/logger.js';
import { formatDisplayDate } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import type { PostState, RedditPort } from './redditPort.js';

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
   * missing, but nothing is re-posted to Mod Discussions. `quiet` skips Mod
   * Discussions too, for a retry of a fresh verification.
   *
   * Returns true once the row is on the wiki - written now or already there.
   */
  record(record: VerificationRecord, options?: { backfill?: boolean; quiet?: boolean }): Promise<boolean>;

  /**
   * Remembers that a verification's row and status are on the wiki, so the
   * install/upgrade backfill never spends Reddit calls on it again.
   */
  markLogged(postId: T3): Promise<void>;
  /** Which of these posts are already fully logged. One batched read. */
  loggedAmong(postIds: readonly T3[]): Promise<Set<T3>>;

  /**
   * Rewrites every month's page in the current format (old table rows become
   * list entries). Returns how many pages changed. Safe to repeat.
   */
  migratePages(): Promise<number>;

  /**
   * Proves, on demand, that the wiki log is actually working.
   *
   * Runs exactly what a verification runs - this month's page name, the same
   * privacy check - and reports what it found. Without this, the only evidence
   * the log works is a line in `devvit logs` after a real verification, which
   * is a poor way to discover that a subreddit has its wiki switched off.
   */
  check(): Promise<WikiLogCheck>;

  /**
   * Updates the Status cell of a verified post's row, e.g. after a moderator
   * removes it. `onlyIfMissing` fills in rows written before the column
   * existed without overwriting a status an event already set.
   *
   * Returns false only when another write held the page; the caller retries.
   */
  setStatus(input: {
    postId: T3;
    verifiedAtMs: number;
    status: string;
    onlyIfMissing?: boolean;
  }): Promise<boolean>;
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

/**
 * The checklist in a few characters: "6/6 ✓", or the count and what was NOT
 * ticked - the part a moderator reading the log on a phone actually needs.
 */
export function checklistSummary(record: VerificationRecord): string {
  if (!record.checklist || record.checklist.length === 0) return 'not used';

  const total = record.checklist.length;
  const missing = record.checklist.filter((item) => !item.checked);
  if (missing.length === 0) return `${total}/${total} ✓`;
  return `${total - missing.length}/${total} · missing: ${missing.map((item) => item.label).join('; ')}`;
}

/** The header a freshly created monthly page starts with. */
export function auditPageHeader(subredditName: string, basePage?: string): string {
  return [
    `# Fundraiser verifications - r/${subredditName}`,
    '',
    ...(basePage ? [`[All months and poster pages](${wikiPageUrl(subredditName, basePage)})`, ''] : []),
    'Moderators only. If you can read this and are not a moderator here, tell the mod team.',
    '',
    '---',
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
    `**Looking for someone?** Use "Look up a poster's history" in the subreddit's mod menu, or open the poster history pages below and press Ctrl+F (Cmd+F on a Mac). Ctrl+F works on each month's log too.`,
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
  '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice | Mod note | Status |';
const AUDIT_TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- |';
/** Cells per row. Status is last so rows written before it existed stay aligned. */
const AUDIT_COLUMNS = 8;

/** Headers that pages started by earlier versions carry, oldest first. */
const LEGACY_TABLE_HEADERS = [
  [
    '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice |',
    '| --- | --- | --- | --- | --- | --- |',
  ].join('\n'),
  [
    '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice | Mod note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ].join('\n'),
];

/** A line early pages carried, no longer true now that notes are logged. */
const LEGACY_NOTE_LINE = 'Moderator notes are deliberately not included here.';

/**
 * Widens a page started before the note or status columns existed.
 *
 * Markdown drops cells beyond the header's width, so without this a cell added
 * mid-month would be written but invisible until next month's page.
 */
export function upgradeAuditHeader(content: string): string {
  let upgraded = content.replace(`${LEGACY_NOTE_LINE}\n`, '').replace(LEGACY_NOTE_LINE, '');
  for (const legacy of LEGACY_TABLE_HEADERS) {
    if (upgraded.includes(legacy)) {
      upgraded = upgraded.replace(legacy, `${AUDIT_TABLE_HEADER}\n${AUDIT_TABLE_RULE}`);
    }
  }
  return tableRowsToEntries(upgraded);
}

/**
 * Rewrites a page's table rows - the format before the list format - as list
 * entries, so a month's page reads the same on a phone from top to bottom.
 *
 * The old checklist cell named every ticked item, which is what made rows
 * tall; only its count ("3/6") is kept. A row it cannot read is left as it is.
 */
export function tableRowsToEntries(content: string): string {
  if (!content.includes('| Verified (IST) |')) return content;

  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('| Verified (IST) |') || /^\|(?:\s*---\s*\|)+\s*$/u.test(line)) continue;

    const cells = line.startsWith('|') ? splitRow(line) : [];
    const post = /^\[(t3_[a-z0-9]+)\]\(([^)]+)\)$/u.exec(cells[1] ?? '');
    if (!post) {
      out.push(line);
      continue;
    }

    const [when, , author, mod, checklist, notice, note, status] = cells;
    const ratio = (checklist ?? '').split(':')[0]?.trim() || 'not used';
    out.push('', `**${when ?? ''}** · [open post](${post[2]}) \`${post[1]}\``, `- ${author ?? ''} · verified by ${mod ?? ''}`);
    out.push(`- Checklist ${ratio}`);
    if (note && note !== '-') out.push(`- Note: ${note}`);
    if (notice && notice !== 'default') out.push(`- Notice: ${notice}`);
    // Left as "- Status: " when the row had none, so the backfill can fill it.
    out.push(`${STATUS_PREFIX}${status ?? ''}`);
  }
  return out.join('\n');
}

/** Splits a table row into cells, respecting escaped pipes. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/(?<!\\)\|$/u, '')
    .split(/(?<!\\)\|/u)
    .map((part) => part.trim());
}

/**
 * Sets the Status cell of one post's row. Returns null when the row is not on
 * the page, or when nothing would change - including, with `onlyIfMissing`,
 * when the row already has a status.
 */
export function withStatus(
  content: string,
  postId: string,
  status: string,
  onlyIfMissing = false,
): string | null {
  const lines = content.split('\n');

  // An entry in the list format: its Status line follows its heading.
  const heading = lines.findIndex((line) => line.startsWith('**') && line.includes(`\`${postId}\``));
  if (heading >= 0) {
    for (let at = heading + 1; at < lines.length && (lines[at] ?? '').startsWith('- '); at++) {
      const line = lines[at] ?? '';
      if (!line.startsWith(STATUS_PREFIX)) continue;
      if (onlyIfMissing && line.slice(STATUS_PREFIX.length).trim().length > 0) return null;
      const updated = `${STATUS_PREFIX}${cell(status)}`;
      if (updated === line) return null;
      lines[at] = updated;
      return lines.join('\n');
    }
    return null;
  }

  // A row in the table format pages used before the list format.
  const index = lines.findIndex((line) => line.startsWith('|') && line.includes(`[${postId}](`));
  if (index < 0) return null;

  const original = lines[index] ?? '';
  const cells = splitRow(original);
  if (onlyIfMissing && cells.length >= AUDIT_COLUMNS && (cells[AUDIT_COLUMNS - 1] ?? '') !== '') {
    return null;
  }

  // A row from before the note column existed is padded, so the status lands
  // under "Status" rather than under "Mod note".
  while (cells.length < AUDIT_COLUMNS - 1) cells.push('-');
  cells[AUDIT_COLUMNS - 1] = cell(status);
  const updated = `| ${cells.slice(0, AUDIT_COLUMNS).join(' | ')} |`;
  if (updated === original) return null;

  lines[index] = updated;
  return lines.join('\n');
}

/** What the Status cell says about a post, or null when Reddit could not be asked. */
export function statusFromState(state: PostState): string | null {
  switch (state) {
    case 'up':
      return 'up';
    case 'removed':
      return 'removed';
    case 'deleted':
      return 'deleted by author';
    case 'unknown':
      return null;
  }
}

export function auditRow(record: VerificationRecord, subredditName: string): string {
  const when = formatDisplayDate(
    record.verifiedAtMs,
    CONFIG.displayTimeZoneOffsetMinutes,
    CONFIG.displayTimeZoneLabel,
  );
  const link = `https://www.reddit.com/r/${subredditName}/comments/${record.postId.replace('t3_', '')}/`;

  // A short stack of lines rather than a table row: an eight-column table is
  // unreadable on a phone, while lines simply wrap. The post id appears once,
  // in backticks, which is what `withStatus` and the duplicate guard find.
  const lines = [
    '',
    `**${when}** · [open post](${link}) \`${record.postId}\``,
    `- ${record.authorName ? `u/${record.authorName}` : '[deleted]'} · verified by u/${record.modName}`,
    `- Checklist ${cell(checklistSummary(record))}`,
  ];
  if (record.note.length > 0) lines.push(`- Note: ${cell(record.note)}`);
  if (record.templateLabel) lines.push(`- Notice: ${cell(record.templateLabel)}`);
  // Verifying approves the post, so it starts out up.
  lines.push(`${STATUS_PREFIX}up`);
  return lines.join('\n');
}

/** The line `withStatus` rewrites in a list-format entry. */
const STATUS_PREFIX = '- Status: ';

export function createAuditLogService(deps: AuditLogDeps): AuditLogService {
  const { reddit, redis, settings, log, now } = deps;
  const lockKey = `${KEY_PREFIX}:auditlock`;

  /**
   * The wiki append is a read-modify-write, so two verifications landing at
   * once could lose a row. A short Redis lock serialises them; the loser's
   * job queues itself again a few times, and the install/upgrade backfill
   * catches anything that still slipped through.
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
  ): Promise<boolean> {
    const result = await withLock(async () => {
      const existing = await reddit.readWikiPage(page);

      // A page nearing Reddit's size cap is left alone; next month's page takes
      // over. Rotating monthly makes this a safety net, not a routine event.
      if (existing !== null && existing.length > CONFIG.audit.maxPageBytes) {
        log.warn('audit log page is full; skipping this row', { page });
        return false;
      }

      // Guard against a redelivered job writing the same row twice.
      if (existing !== null && existing.includes(record.postId)) {
        log.info('audit log already contains this post', { page, postId: record.postId });
        return true;
      }

      const content =
        existing === null
          ? `${auditPageHeader(subredditName, basePage)}\n${row}`
          : `${upgradeAuditHeader(existing)}\n${row}`;
      await reddit.writeWikiPage(page, content, `Verified ${record.postId}`);
      return true;
    });

    if (result === null) {
      // Not lost: the row is not marked as logged, so the next install or
      // upgrade backfill writes it.
      log.warn('audit log busy; another verification holds the lock', { postId: record.postId });
      return false;
    }
    return result;
  }

  const loggedKey = (postId: T3): string => `${KEY_PREFIX}:logged:${postId}`;

  async function markLogged(postId: T3): Promise<void> {
    await redis.set(loggedKey(postId), '1');
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

      const months = (await allByScore(redis, monthsKey))
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
    async record(record, options = {}): Promise<boolean> {
      const config = await settings.get();
      if (!config.enabled) return false;
      let onPage = false;

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
          onPage = await appendRow(page, config.wikiLogPage, subredditName, record, row);
          await updateHub(config.wikiLogPage, page, false);
          // A fresh row is complete, status included. A backfilled one is
          // marked by the backfill once its status is filled in too.
          if (onPage && !options.backfill) await markLogged(record.postId);
        }
      }

      if (config.modmailLogEnabled && !options.backfill && !options.quiet) {
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

      return onPage;
    },

    markLogged,

    async migratePages(): Promise<number> {
      const config = await settings.get();
      if (!config.enabled || !config.wikiLogEnabled) return 0;

      let changed = 0;
      for (const page of await allByScore(redis, monthsKey)) {
        if (!page.startsWith(`${config.wikiLogPage}/`)) continue;
        const privacy = await reddit.ensureWikiPagePrivate(
          page,
          auditPageHeader(reddit.subredditName(), config.wikiLogPage),
        );
        if (!privacy.ok) continue;

        const wrote = await withLock(async () => {
          const existing = await reddit.readWikiPage(page);
          if (existing === null) return false;
          const migrated = upgradeAuditHeader(existing);
          if (migrated === existing) return false;
          await reddit.writeWikiPage(page, migrated, 'Shorter layout for phones');
          return true;
        });
        if (wrote) changed += 1;
      }
      log.info('wiki log pages migrated', { changed });
      return changed;
    },

    async loggedAmong(postIds): Promise<Set<T3>> {
      if (postIds.length === 0) return new Set();
      const flags = await redis.mGet(postIds.map(loggedKey));
      return new Set(postIds.filter((_, index) => flags[index] === '1'));
    },

    async setStatus({ postId, verifiedAtMs, status, onlyIfMissing = false }): Promise<boolean> {
      const config = await settings.get();
      if (!config.enabled || !config.wikiLogEnabled) return true;

      const subredditName = reddit.subredditName();
      const page = auditPageName(config.wikiLogPage, verifiedAtMs);
      const privacy = await reddit.ensureWikiPagePrivate(
        page,
        auditPageHeader(subredditName, config.wikiLogPage),
      );
      if (!privacy.ok) {
        log.error('status not written: page could not be confirmed moderator-only', { page, postId });
        return true;
      }

      const result = await withLock(async () => {
        const existing = await reddit.readWikiPage(page);
        if (existing === null) return;
        const updated = withStatus(upgradeAuditHeader(existing), postId, status, onlyIfMissing);
        if (updated === null) return;
        await reddit.writeWikiPage(page, updated, `Status of ${postId}: ${status}`);
      });

      return result !== null;
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
