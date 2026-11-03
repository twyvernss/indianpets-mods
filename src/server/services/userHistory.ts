import type { T3 } from '@devvit/web/shared';
import { CONFIG } from '../config.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { formatDisplayDate, formatShortDate } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import { describeMatch } from '../text.js';
import type { VerificationRecord } from '../types.js';
import type { AccountMatch, AltService } from './altMatch.js';
import { cell } from './auditLog.js';
import type { AuthorSnapshot, RedditPort, UserPostSummary } from './redditPort.js';

/**
 * A moderator-only wiki page per poster: `{wikiLogPage}/users/{username}`.
 *
 * Lists every post they made here with a link to each, who verified which and
 * when, the internal note, and which other accounts their posts resemble. The
 * page is REBUILT from Reddit and the app's own records each time, never
 * appended to, so a post the author deletes simply drops off on the next
 * rebuild. Post titles are deliberately not copied onto the page for the same
 * reason: the link is enough, and a copied title would outlive a deletion.
 *
 * Same privacy rule as the verification log: nothing is written until the
 * page is proven moderator-only.
 */
export type UserHistoryService = {
  rebuild(username: string, options?: { ensureIndexed?: T3 }): Promise<HistoryResult>;
};

export type HistoryResult =
  | { kind: 'off' }
  | { kind: 'blocked'; page: string; reason: string }
  | { kind: 'ready'; page: string; postCount: number; top: AccountMatch | null };

export type UserHistoryDeps = {
  reddit: RedditPort;
  repo: VerificationRepo;
  alt: AltService;
  settings: SettingsReader;
  log: Logger;
  now: () => number;
};

export function userHistoryPageName(basePage: string, username: string): string {
  return `${basePage}/users/${username.toLowerCase().replace(/[^a-z0-9_-]/gu, '')}`;
}

export function userIndexPageName(basePage: string): string {
  return `${basePage}/users`;
}

/** Seed content for a new page. Names nobody, so it is safe before privacy is proven. */
const SEED = '# Poster history\n\nBeing written by the mod team bot.';

/** One row of the posts table, merged from Reddit and the app's records. */
export type HistoryRow = {
  postId: T3;
  postedAtMs: number;
  flairText: string | null;
  state: 'live' | 'removed' | 'gone';
  record: VerificationRecord | null;
};

/**
 * Merges the profile listing with the app's verification records.
 *
 * A verified post the author later deleted is missing from their profile but
 * still has a record, so it stays on the page as "gone" - that a fundraiser
 * was verified and then vanished is worth a moderator knowing.
 */
export function mergeHistoryRows(
  posts: readonly UserPostSummary[],
  records: readonly VerificationRecord[],
): HistoryRow[] {
  const recordById = new Map(records.map((record) => [record.postId, record]));
  const rows: HistoryRow[] = posts.map((post) => ({
    postId: post.id,
    postedAtMs: post.createdAtMs,
    flairText: post.flairText,
    state: post.removed ? 'removed' : 'live',
    record: recordById.get(post.id) ?? null,
  }));

  const listed = new Set(posts.map((post) => post.id));
  for (const record of records) {
    if (listed.has(record.postId)) continue;
    rows.push({
      postId: record.postId,
      postedAtMs: record.verifiedAtMs,
      flairText: null,
      state: 'gone',
      record,
    });
  }

  return rows.sort((a, b) => b.postedAtMs - a.postedAtMs).slice(0, CONFIG.history.maxRows);
}

function postLink(subredditName: string, postId: T3): string {
  return `https://www.reddit.com/r/${subredditName}/comments/${postId.replace('t3_', '')}/`;
}

const STATE_LABEL: Record<HistoryRow['state'], string> = {
  live: 'up',
  removed: 'removed',
  gone: 'deleted or hidden',
};

export function buildHistoryPage(input: {
  subredditName: string;
  username: string;
  author: AuthorSnapshot | null;
  banned: boolean;
  rows: readonly HistoryRow[];
  matches: readonly AccountMatch[];
  builtAtMs: number;
}): string {
  const { subredditName, username } = input;
  const verifiedCount = input.rows.filter((row) => row.record?.status === 'complete').length;
  const removedCount = input.rows.filter((row) => row.state === 'removed').length;

  const account = input.author
    ? `${input.author.accountAgeDays} days old, ${input.author.karma.toLocaleString('en-IN')} karma`
    : 'suspended, deleted or unreadable';

  const lines = [
    `# u/${username} - history in r/${subredditName}`,
    '',
    `Rebuilt ${formatDisplayDate(input.builtAtMs, CONFIG.displayTimeZoneOffsetMinutes, CONFIG.displayTimeZoneLabel)} by the mod team bot. Moderators only.`,
    '',
    `- Profile: [u/${username}](https://www.reddit.com/user/${username}/)`,
    `- Account: ${account}`,
    `- Banned here: **${input.banned ? 'YES' : 'no'}**`,
    `- Posts here: ${input.rows.length}, of which ${verifiedCount} verified and ${removedCount} removed`,
    '',
    '## Accounts their posts match',
    '',
  ];

  if (input.matches.length === 0) {
    lines.push('No other account shares their payment details, links or wording.');
  } else {
    lines.push(
      'Strongest first. Payment details (UPI ID, phone, bank account) are the strongest sign of the same person.',
      '',
      '| Account | Banned here | What matches | Their matching posts |',
      '| --- | --- | --- | --- |',
    );
    for (const match of input.matches) {
      const posts = match.postIds
        .map((postId, index) => `[${index + 1}](${postLink(subredditName, postId)})`)
        .join(' ');
      lines.push(
        `| [u/${cell(match.author)}](https://www.reddit.com/user/${match.author}/) | ${match.banned ? '**YES**' : 'no'} | ${cell(describeMatch(match) || 'similar')} | ${posts} |`,
      );
    }
  }

  lines.push('', '## Posts', '');
  if (input.rows.length === 0) {
    lines.push('No posts found in this subreddit.');
  } else {
    lines.push(
      '| Posted (IST) | Post | Flair | State | Verified by | Mod note |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const row of input.rows) {
      const record = row.record?.status === 'complete' ? row.record : null;
      const verified = record ? `u/${record.modName}, ${formatShortDate(record.verifiedAtMs)}` : '-';
      lines.push(
        `| ${formatShortDate(row.postedAtMs)} | [open](${postLink(subredditName, row.postId)}) | ${cell(row.flairText ?? '-')} | ${STATE_LABEL[row.state]} | ${cell(verified)} | ${cell(record && record.note.length > 0 ? record.note : '-')} |`,
      );
    }
  }

  return lines.join('\n');
}

export function createUserHistoryService(deps: UserHistoryDeps): UserHistoryService {
  const { reddit, repo, alt, settings, log, now } = deps;

  /** Adds the person to the list of history pages, once. Self-healing on every rebuild. */
  async function addToIndex(basePage: string, username: string, page: string): Promise<void> {
    const indexPage = userIndexPageName(basePage);
    const header = [
      '# Poster history pages',
      '',
      'One page per poster, rebuilt by the mod team bot. Moderators only.',
      '',
    ].join('\n');

    const privacy = await reddit.ensureWikiPagePrivate(indexPage, header);
    if (!privacy.ok) {
      log.error('skipping the history index: not confirmed moderator-only', { reason: privacy.reason });
      return;
    }

    const existing = (await reddit.readWikiPage(indexPage)) ?? header;
    const link = `https://www.reddit.com/r/${reddit.subredditName()}/wiki/${page}`;
    if (existing.includes(link)) return;
    await reddit.writeWikiPage(indexPage, `${existing}\n- [u/${username}](${link})`, `Add u/${username}`);
  }

  return {
    async rebuild(username, options = {}): Promise<HistoryResult> {
      const config = await settings.get();
      if (!config.enabled || !config.wikiLogEnabled || !config.userHistoryEnabled) return { kind: 'off' };

      const page = userHistoryPageName(config.wikiLogPage, username);

      const [posts, verified, author, banned, matches] = await Promise.all([
        reddit.getUserPostsHere(username, CONFIG.history.postsToScan),
        repo.getAuthorHistory(username, CONFIG.history.maxRows),
        reddit.getAuthor(username),
        reddit.isBanned(username),
        alt.matchesForAuthor(username, options.ensureIndexed),
      ]);
      const records = await repo.getMany(verified.map((entry) => entry.postId));
      const rows = mergeHistoryRows(posts, records);

      const privacy = await reddit.ensureWikiPagePrivate(page, SEED);
      if (!privacy.ok) {
        log.error('skipping the history page: not confirmed moderator-only', { page, reason: privacy.reason });
        return { kind: 'blocked', page, reason: privacy.reason };
      }

      const content = buildHistoryPage({
        subredditName: reddit.subredditName(),
        username,
        author,
        banned,
        rows,
        matches,
        builtAtMs: now(),
      });
      await reddit.writeWikiPage(page, content, `History of u/${username}`);
      await addToIndex(config.wikiLogPage, username, page);

      log.info('history page rebuilt', { page, rows: rows.length, matches: matches.length });
      return { kind: 'ready', page, postCount: rows.length, top: matches[0] ?? null };
    },
  };
}
