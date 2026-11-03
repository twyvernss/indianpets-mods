import type { T3 } from '@devvit/web/shared';
import { CONFIG, KEY_PREFIX } from '../config.js';
import type { RedisPort } from '../data/redisPort.js';
import { allByScore } from '../data/redisPort.js';
import type { VerificationRepo } from '../data/verificationRepo.js';
import type { Logger } from '../lib/logger.js';
import { formatDisplayDate, formatShortDate } from '../lib/time.js';
import type { SettingsReader } from '../settings.js';
import { describeMatch } from '../text.js';
import type { VerificationRecord } from '../types.js';
import type { AccountMatch, AltService } from './altMatch.js';
import { cell, wikiPageUrl } from './auditLog.js';
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
  redis: RedisPort;
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

/** Every username with a history page. Score is always 0; members sort by name. */
const INDEX_KEY = `${KEY_PREFIX}:hist:users`;

/**
 * The A-Z index of history pages, one heading per letter.
 *
 * Case is folded when sorting and when removing duplicates, because Reddit
 * usernames are case-insensitive and the same person can arrive spelt two ways.
 */
export function buildUserIndex(subredditName: string, basePage: string, usernames: readonly string[]): string {
  const unique = new Map<string, string>();
  for (const name of usernames) {
    if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  const sorted = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));

  const lines = [
    '# Poster history pages',
    '',
    'One page per poster, rebuilt by the mod team bot. Moderators only.',
    `Press Ctrl+F (Cmd+F on a Mac) to find someone, or use "Look up a poster's history" in the mod menu.`,
    '',
    `[Back to all fundraiser records](${wikiPageUrl(subredditName, basePage)})`,
  ];
  if (sorted.length === 0) lines.push('', 'Nobody yet.');

  let letter = '';
  let size = lines.join('\n').length;
  let listed = 0;
  for (const [lower, name] of sorted) {
    const entry = `- [u/${name}](${wikiPageUrl(subredditName, userHistoryPageName(basePage, name))})`;
    // Reddit refuses a wiki page much over 512 KB. A subreddit that outgrows
    // one page still has every history page; the lookup action finds them.
    if (size + entry.length + 12 > CONFIG.audit.maxPageBytes) break;

    const first = /[a-z]/u.test(lower[0] ?? '') ? (lower[0] ?? '').toUpperCase() : '#';
    if (first !== letter) {
      letter = first;
      lines.push('', `### ${letter}`, '');
      size += letter.length + 6;
    }
    lines.push(entry);
    size += entry.length + 1;
    listed += 1;
  }
  if (listed < sorted.length) {
    lines.push(
      '',
      `*${sorted.length - listed} more posters have history pages that do not fit here. Use "Look up a poster's history" to open them.*`,
    );
  }
  return lines.join('\n');
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
  const { reddit, redis, repo, alt, settings, log, now } = deps;

  /**
   * Lists the person on the A-Z index of history pages.
   *
   * The names live in Redis and the page is rebuilt whole and sorted whenever
   * someone new is added, so the index stays alphabetical - which is what
   * makes it searchable with Ctrl+F. A page missing this person (written by an
   * older version, say) is rebuilt too, so the index heals itself.
   */
  async function addToIndex(basePage: string, username: string, page: string): Promise<void> {
    const indexPage = userIndexPageName(basePage);
    const subredditName = reddit.subredditName();

    const privacy = await reddit.ensureWikiPagePrivate(indexPage, buildUserIndex(subredditName, basePage, []));
    if (!privacy.ok) {
      log.error('skipping the history index: not confirmed moderator-only', { reason: privacy.reason });
      return;
    }

    const added = await redis.zAdd(INDEX_KEY, { member: username, score: 0 });
    const existing = (await reddit.readWikiPage(indexPage)) ?? '';
    if (added === 0 && existing.includes(wikiPageUrl(subredditName, page))) return;

    const names = await allByScore(redis, INDEX_KEY);
    await reddit.writeWikiPage(indexPage, buildUserIndex(subredditName, basePage, names), `Add u/${username}`);
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
