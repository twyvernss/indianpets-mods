import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { JOBS } from '../config.js';
import { createFingerprintRepo } from '../data/fingerprintRepo.js';
import { createLinkRepo } from '../data/linkRepo.js';
import { createVerificationRepo } from '../data/verificationRepo.js';
import { createAltService } from '../services/altMatch.js';
import {
  buildHistoryPage,
  buildUserIndex,
  createUserHistoryService,
  mergeHistoryRows,
  userHistoryPageName,
} from '../services/userHistory.js';
import type { AppSettings } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';

const NOW = Date.UTC(2026, 10, 3, 8, 0);
const DAY = 86_400_000;

function record(postId: string, overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    schemaVersion: 2,
    postId: postId as T3,
    authorName: 'op_user',
    modName: 'mod_one',
    verifiedAtMs: NOW - DAY,
    status: 'complete',
    note: 'called the clinic',
    checklist: null,
    commentId: 't1_x',
    templateLabel: null,
    deletedAtMs: null,
    reminderSentAtMs: null,
    opRespondedAtMs: null,
    escalatedAtMs: null,
    ...overrides,
  };
}

describe('history rows', () => {
  it('merges profile posts with records, keeping verified posts the author deleted', () => {
    const rows = mergeHistoryRows(
      [
        { id: 't3_live' as T3, createdAtMs: NOW, flairText: 'Fundraiser', removed: false },
        { id: 't3_removed' as T3, createdAtMs: NOW - DAY, flairText: null, removed: true },
      ],
      [record('t3_live'), record('t3_gone', { verifiedAtMs: NOW - 5 * DAY })],
    );

    expect(rows.map((row) => [row.postId, row.state])).toEqual([
      ['t3_live', 'live'],
      ['t3_removed', 'removed'],
      ['t3_gone', 'gone'],
    ]);
    expect(rows[0]?.record?.modName).toBe('mod_one');
  });
});

describe('history page', () => {
  const page = buildHistoryPage({
    subredditName: 'IndianPets',
    username: 'op_user',
    author: { username: 'op_user', accountAgeDays: 12, karma: 40 },
    banned: false,
    rows: mergeHistoryRows(
      [{ id: 't3_abc' as T3, createdAtMs: NOW, flairText: 'Fundraiser', removed: false }],
      [record('t3_abc')],
    ),
    matches: [
      {
        author: 'old_alt',
        score: 9,
        shared: { upi: 1 },
        commonShared: 0,
        wordingIsCommon: false,
        textSimilarity: 0.8,
        postIds: ['t3_zzz' as T3],
        banned: true,
      },
    ],
    builtAtMs: NOW,
  });

  it('links every post and says who verified it, with the note', () => {
    expect(page).toContain('[open](https://www.reddit.com/r/IndianPets/comments/abc/)');
    expect(page).toContain('| u/mod_one, 2 Nov 2026 | not used | called the clinic |');
  });

  it('lists matching accounts with ban status and links to their posts', () => {
    expect(page).toContain('[u/old_alt](https://www.reddit.com/user/old_alt/) | **YES** | same UPI ID; 80% same wording');
    expect(page).toContain('[1](https://www.reddit.com/r/IndianPets/comments/zzz/)');
  });

  it('never copies post titles onto the page', () => {
    expect(page).not.toContain('Please help');
  });

  it('builds an A-Z index with one heading per letter and no duplicates', () => {
    const index = buildUserIndex('IndianPets', 'fundraiser-verifications', ['zed', 'Alice', 'bob', 'alice', '_under']);
    expect(index).toContain('Ctrl+F');
    expect(index.indexOf('### A')).toBeLessThan(index.indexOf('### B'));
    expect(index.indexOf('### B')).toBeLessThan(index.indexOf('### Z'));
    expect(index.split('u/Alice').length - 1).toBe(1);
    expect(index).not.toContain('u/alice]');
    expect(index).toContain('### #');
    expect(index).toContain('https://old.reddit.com/r/IndianPets/wiki/fundraiser-verifications/users/bob');
  });

  it('uses a safe, lower-case page name', () => {
    expect(userHistoryPageName('fundraiser-verifications', 'Op_User')).toBe(
      'fundraiser-verifications/users/op_user',
    );
  });
});

function harness(overrides: Partial<AppSettings> = {}) {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit();
  const settings = fakeSettings(overrides);
  const repo = createVerificationRepo(redis);
  const alt = createAltService({
    fingerprints: createFingerprintRepo(redis),
    links: createLinkRepo(redis),
    reddit,
    scheduler: new FakeScheduler(),
    settings,
    log: fakeLogger(),
    now: () => NOW,
  });
  const scheduler = new FakeScheduler();
  const service = createUserHistoryService({
    reddit,
    redis,
    scheduler,
    repo,
    alt,
    settings,
    log: fakeLogger(),
    now: () => NOW,
  });
  return { reddit, repo, scheduler, service };
}

describe('open from a menu', () => {
  it('builds a first-ever page while the moderator waits', async () => {
    const h = harness();
    const result = await h.service.open('op_user');
    expect(result).toMatchObject({ kind: 'ready', postCount: 0 });
    expect(h.reddit.wiki.has('fundraiser-verifications/users/op_user')).toBe(true);
    expect(h.scheduler.jobsNamed(JOBS.userHistory)).toHaveLength(0);
  });

  it('opens an existing page at once and refreshes it in the background', async () => {
    const h = harness();
    await h.service.rebuild('op_user');
    const writesBefore = h.reddit.calls.filter((call) => call === 'writeWiki').length;

    const result = await h.service.open('op_user');
    expect(result).toMatchObject({ kind: 'ready', postCount: null, refreshing: true });
    expect(h.reddit.calls.filter((call) => call === 'writeWiki').length).toBe(writesBefore);
    expect(h.scheduler.jobsNamed(JOBS.userHistory)[0]?.data).toEqual({ username: 'op_user' });
  });
});

describe('rebuild', () => {
  it('writes the page and lists it on the index exactly once', async () => {
    const h = harness();
    h.reddit.userPosts.set('op_user', [
      { id: 't3_abc' as T3, createdAtMs: NOW, flairText: null, removed: false },
    ]);

    const first = await h.service.rebuild('op_user');
    await h.service.rebuild('op_user');

    expect(first).toMatchObject({ kind: 'ready', page: 'fundraiser-verifications/users/op_user', postCount: 1 });
    expect(h.reddit.wiki.get('fundraiser-verifications/users/op_user')).toContain('# u/op_user');
    const index = h.reddit.wiki.get('fundraiser-verifications/users') ?? '';
    expect(index.split('u/op_user').length - 1).toBe(1);
  });

  it('links the index to old.reddit, and does not re-add an entry written in the old style', async () => {
    const h = harness();
    h.reddit.wiki.set(
      'fundraiser-verifications/users',
      '# Poster history pages\n- [u/op_user](https://www.reddit.com/r/IndianPets/wiki/fundraiser-verifications/users/op_user)',
    );
    await h.service.rebuild('op_user');
    await h.service.rebuild('someone_else');

    const index = h.reddit.wiki.get('fundraiser-verifications/users') ?? '';
    expect(index.split('u/op_user').length - 1).toBe(1);
    expect(index).toContain('https://old.reddit.com/r/IndianPets/wiki/fundraiser-verifications/users/someone_else');
  });

  it('writes nothing when the page cannot be proven moderator-only', async () => {
    const h = harness();
    h.reddit.wikiPrivate = false;
    const result = await h.service.rebuild('op_user');
    expect(result.kind).toBe('blocked');
    expect(h.reddit.calls).not.toContain('writeWiki');
  });

  it('is off when either the wiki log or history pages are switched off', async () => {
    await expect(harness({ wikiLogEnabled: false }).service.rebuild('op_user')).resolves.toEqual({ kind: 'off' });
    await expect(harness({ userHistoryEnabled: false }).service.rebuild('op_user')).resolves.toEqual({
      kind: 'off',
    });
  });
});
