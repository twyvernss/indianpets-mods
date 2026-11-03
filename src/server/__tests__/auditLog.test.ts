import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import {
  auditPageHeader,
  auditPageName,
  auditRow,
  countRows,
  createAuditLogService,
  modDiscussionBody,
  statusFromState,
  upgradeAuditHeader,
  withStatus,
} from '../services/auditLog.js';
import { judgeWikiPrivacy } from '../lib/wikiPrivacy.js';
import type { AppSettings } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const NOW = Date.UTC(2026, 8, 28, 11, 13); // 28 Sep 2026, 16:43 IST
const PAGE = 'fundraiser-verifications/2026-09';

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    schemaVersion: 2,
    postId: 't3_abc123' as T3,
    authorName: 'op_user',
    modName: 'mod_one',
    verifiedAtMs: NOW,
    status: 'complete',
    note: 'clinic phone 98765 43210',
    checklist: [
      { label: 'Vet bill in OP name', checked: true },
      { label: 'Clinic contacted', checked: true },
      { label: 'Photo with username', checked: false },
    ],
    commentId: 't1_x',
    templateLabel: null,
    deletedAtMs: null,
    reminderSentAtMs: null,
    opRespondedAtMs: null,
    escalatedAtMs: null,
    ...overrides,
  };
}

function harness(settingsOverrides: Partial<AppSettings> = {}, redditOptions: FakeRedditOptions = {}) {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit(redditOptions);

  const service = createAuditLogService({
    reddit,
    redis,
    settings: fakeSettings(settingsOverrides),
    log: fakeLogger(),
    now: () => NOW,
  });

  return { service, redis, reddit };
}

describe('page naming', () => {
  it('rotates monthly, in local time', () => {
    expect(auditPageName('log', NOW)).toBe('log/2026-09');
    // 31 Dec 2026 20:00 UTC is 1 Jan 2027 in IST, so it belongs to January.
    expect(auditPageName('log', Date.UTC(2026, 11, 31, 20, 0))).toBe('log/2027-01');
  });
});

describe('row rendering', () => {
  it('links the post and shows the checklist as a count with what was missed', () => {
    const row = auditRow(record(), 'IndianPets');
    expect(row).toContain('[open post](https://www.reddit.com/r/IndianPets/comments/abc123/)');
    expect(row).toContain('u/op_user · verified by u/mod_one');
    expect(row).toContain('- Checklist 2/3 · missing: Photo with username');
  });

  it('shows a fully ticked checklist as just the count', () => {
    const all = record({ checklist: [{ label: 'a', checked: true }, { label: 'b', checked: true }] });
    expect(auditRow(all, 'IndianPets')).toContain('- Checklist 2/2 ✓');
  });

  it('is a short stack of lines a phone can show, never a wide table row', () => {
    const row = auditRow(record(), 'IndianPets');
    expect(row).not.toContain('|');
    for (const line of row.split('\n')) expect(line.length).toBeLessThan(140);
  });

  it('writes the moderator note, now that the wiki replaces the mod note', () => {
    expect(auditRow(record(), 'IndianPets')).toContain('- Note: clinic phone 98765 43210');
  });

  it('leaves out an empty note line, and starts the post as up', () => {
    const row = auditRow(record({ note: '' }), 'IndianPets');
    expect(row).not.toContain('Note:');
    expect(row.endsWith('- Status: up')).toBe(true);
  });

  it('turns old table rows into short entries, keeping only the checklist count', () => {
    const legacy = [
      '# log',
      'Written automatically by the mod team bot, one row per verified fundraiser.',
      'Moderator notes are deliberately not included here.',
      '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice | Mod note | Status |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 28 Sep 2026, 16:43 IST | [t3_abc](https://www.reddit.com/r/x/comments/abc/) | u/op | u/mod | 3/6: Vet bill; Clinic; Photo | default | hello | removed, 3 Nov 2026 |',
    ].join('\n');

    const upgraded = upgradeAuditHeader(legacy);
    expect(upgraded).not.toContain('|');
    expect(upgraded).not.toContain('deliberately not included');
    expect(upgraded).toContain('**28 Sep 2026, 16:43 IST** · [open post](https://www.reddit.com/r/x/comments/abc/) `t3_abc`');
    expect(upgraded).toContain('- u/op · verified by u/mod');
    expect(upgraded).toContain('- Checklist 3/6');
    expect(upgraded).not.toContain('Vet bill');
    expect(upgraded).toContain('- Note: hello');
    expect(upgraded).toContain('- Status: removed, 3 Nov 2026');
    expect(upgradeAuditHeader(upgraded)).toBe(upgraded);
  });

  it('converts the oldest six-column rows too, leaving their status empty to be filled in', () => {
    const legacy = [
      '| Verified (IST) | Post | Fundraiser by | Verified by | Checklist | Notice |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 Sep 2026, 10:00 IST | [t3_old](https://r/old/) | [deleted] | u/mod | not used | default |',
    ].join('\n');
    const upgraded = upgradeAuditHeader(legacy);
    expect(upgraded).toContain('- Checklist not used');
    expect(withStatus(upgraded, 't3_old', 'up', true)).toContain('- Status: up');
  });

  it('sets the status of one row and leaves the others alone', () => {
    const page = [
      auditPageHeader('IndianPets'),
      auditRow(record({ postId: 't3_one' as T3 }), 'IndianPets'),
      auditRow(record({ postId: 't3_two' as T3 }), 'IndianPets'),
    ].join('\n');

    const updated = withStatus(page, 't3_one', 'removed, 3 Nov 2026') ?? '';
    const entries = updated.split('`t3_two`');
    expect(entries[0]).toContain('- Status: removed, 3 Nov 2026');
    expect(entries[1]).toContain('- Status: up');
    expect(entries[1]).not.toContain('removed');
  });

  it('still updates a row in a table-format page from before the list format', () => {
    const row = '| a | [t3_old](link) | c | d | e | f | g | up |';
    expect(withStatus(row, 't3_old', 'removed')).toBe('| a | [t3_old](link) | c | d | e | f | g | removed |');
  });

  it('pads an old six-cell row so the status lands under Status', () => {
    const row = '| a | [t3_old](link) | c | d | e | f |';
    const updated = withStatus(row, 't3_old', 'up') ?? '';
    expect(updated).toBe('| a | [t3_old](link) | c | d | e | f | - | up |');
  });

  it('keeps escaped pipes inside a cell of a table-format row', () => {
    const row = '| a | [t3_abc123](l) | c | d | e | f | bill \\| receipt | up |';
    expect(withStatus(row, 't3_abc123', 'removed')).toContain('bill \\| receipt | removed |');
  });

  it('only fills a missing status when asked to', () => {
    const row = auditRow(record(), 'IndianPets');
    expect(withStatus(row, 't3_abc123', 'removed', true)).toBeNull();
    expect(withStatus(row.replace('- Status: up', '- Status: '), 't3_abc123', 'removed', true)).toContain(
      '- Status: removed',
    );
    const old = '| a | [t3_abc123](l) | c | d | e | f | g |';
    expect(withStatus(old, 't3_abc123', 'removed', true)).toBe(
      '| a | [t3_abc123](l) | c | d | e | f | g | removed |',
    );
  });

  it('returns null for a post that is not on the page', () => {
    expect(withStatus(auditPageHeader('IndianPets'), 't3_missing', 'up')).toBeNull();
  });

  it('reads a status from the post state, and writes nothing when Reddit could not be asked', () => {
    expect(statusFromState('up')).toBe('up');
    expect(statusFromState('removed')).toBe('removed');
    expect(statusFromState('deleted')).toBe('deleted by author');
    expect(statusFromState('unknown')).toBeNull();
  });

  it('keeps a note on one line, so one entry cannot break the next', () => {
    const row = auditRow(record({ note: 'line one\nline two' }), 'IndianPets');
    expect(row).toContain('- Note: line one line two');
  });

  it('handles a deleted author and a picked notice', () => {
    const row = auditRow(record({ authorName: null, templateLabel: 'Registered rescue' }), 'IndianPets');
    expect(row).toContain('[deleted]');
    expect(row).toContain('Registered rescue');
  });

  it('says so plainly when no checklist was used', () => {
    expect(auditRow(record({ checklist: null }), 'IndianPets')).toContain('not used');
  });
});

describe('writing the log', () => {
  it('creates the page with a header on the first verification', async () => {
    const h = harness();
    await h.service.record(record());

    const page = h.reddit.wiki.get(PAGE);
    expect(page).toBeDefined();
    expect(page).toContain('Fundraiser verifications');
    expect(page).toContain('t3_abc123');
  });

  it('appends to an existing page instead of replacing it', async () => {
    const h = harness();
    await h.service.record(record());
    await h.service.record(record({ postId: 't3_second' as T3 }));

    const page = h.reddit.wiki.get(PAGE) ?? '';
    expect(page).toContain('t3_abc123');
    expect(page).toContain('t3_second');
    // One header, two entries.
    expect(page.split('# Fundraiser verifications')).toHaveLength(2);
  });

  it('does not write the same post twice if the job is redelivered', async () => {
    const h = harness();
    await h.service.record(record());
    await h.service.record(record());

    const page = h.reddit.wiki.get(PAGE) ?? '';
    expect(page.split('t3_abc123')).toHaveLength(2);
  });

  it('can be switched off', async () => {
    const h = harness({ wikiLogEnabled: false });
    await h.service.record(record());
    expect(h.reddit.wiki.size).toBe(0);
  });

  it('does nothing at all when the app is disabled', async () => {
    const h = harness({ enabled: false, modmailLogEnabled: true });
    await h.service.record(record());
    expect(h.reddit.wiki.size).toBe(0);
    expect(h.reddit.modDiscussions).toHaveLength(0);
  });

  it('leaves a full page alone rather than growing it forever', async () => {
    const h = harness();
    h.reddit.wiki.set(PAGE, 'x'.repeat(500_000));
    await h.service.record(record());
    expect(h.reddit.wiki.get(PAGE)).toBe('x'.repeat(500_000));
  });
});

describe('setStatus', () => {
  it('updates the row on the month page the post was verified in', async () => {
    const h = harness();
    await h.service.record(record());
    const done = await h.service.setStatus({
      postId: 't3_abc123' as T3,
      verifiedAtMs: NOW,
      status: 'removed, 28 Sep 2026',
    });
    expect(done).toBe(true);
    expect(h.reddit.wiki.get(PAGE)).toContain('- Status: removed, 28 Sep 2026');
  });

  it('writes nothing for a post that was never logged', async () => {
    const h = harness();
    await h.service.record(record());
    const before = h.reddit.wiki.get(PAGE);
    await h.service.setStatus({ postId: 't3_other' as T3, verifiedAtMs: NOW, status: 'removed' });
    expect(h.reddit.wiki.get(PAGE)).toBe(before);
  });
});

describe('logged markers', () => {
  it('marks a fresh verification as fully logged, so a later backfill skips it', async () => {
    const h = harness();
    await expect(h.service.record(record())).resolves.toBe(true);
    expect(await h.service.loggedAmong(['t3_abc123' as T3, 't3_other' as T3])).toEqual(
      new Set(['t3_abc123']),
    );
  });

  it('leaves a backfilled row unmarked until the backfill has also set its status', async () => {
    const h = harness();
    await h.service.record(record(), { backfill: true });
    expect((await h.service.loggedAmong(['t3_abc123' as T3])).size).toBe(0);
  });

  it('does not mark a row that never reached the wiki', async () => {
    const h = harness();
    h.reddit.wikiPrivate = false;
    await expect(h.service.record(record())).resolves.toBe(false);
    expect((await h.service.loggedAmong(['t3_abc123' as T3])).size).toBe(0);
  });
});

describe('backfill', () => {
  it('writes the missing row but does not post to mod discussions again', async () => {
    const h = harness({ modmailLogEnabled: true });
    await h.service.record(record(), { backfill: true });
    expect(h.reddit.wiki.get(PAGE)).toContain('t3_abc123');
    expect(h.reddit.modDiscussions).toHaveLength(0);
  });

  it('leaves a row that is already logged alone', async () => {
    const h = harness();
    await h.service.record(record());
    await h.service.record(record(), { backfill: true });
    expect(h.reddit.wiki.get(PAGE)?.split('t3_abc123').length).toBe(2);
  });
});

describe('wiki privacy judgement', () => {
  it('accepts a page Reddit reads back as moderators-only', () => {
    expect(judgeWikiPrivacy({ permLevel: 2, listed: true })).toEqual({ ok: true, inferred: false });
  });

  it('accepts the misread 0 when the same request did make the page unlisted', () => {
    // Devvit reads "permlevel" back as 0 for every page; "listed" reads correctly.
    expect(judgeWikiPrivacy({ permLevel: 0, listed: false })).toEqual({ ok: true, inferred: true });
  });

  it('refuses when the page is still listed, so the request did not land', () => {
    const verdict = judgeWikiPrivacy({ permLevel: 0, listed: true });
    expect(verdict.ok).toBe(false);
  });

  it('refuses a readable level that is not moderators-only', () => {
    const verdict = judgeWikiPrivacy({ permLevel: 1, listed: false });
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toContain('permission level as 1');
  });

  it('refuses anything it cannot read', () => {
    expect(judgeWikiPrivacy({ permLevel: undefined, listed: undefined }).ok).toBe(false);
  });
});

describe('mod discussions', () => {
  it('is off by default', async () => {
    const h = harness();
    await h.service.record(record());
    expect(h.reddit.modDiscussions).toHaveLength(0);
  });

  it('posts the full checklist when switched on', async () => {
    const h = harness({ modmailLogEnabled: true });
    await h.service.record(record());

    expect(h.reddit.modDiscussions).toHaveLength(1);
    const body = h.reddit.modDiscussions[0]?.body ?? '';
    expect(body).toContain('[x] Vet bill in OP name');
    expect(body).toContain('[ ] Photo with username');
    expect(body).toContain('u/mod_one');
  });

  it('includes the moderator note there too', () => {
    const body = modDiscussionBody(record(), 'IndianPets');
    expect(body).toContain('**Mod note:** clinic phone 98765 43210');
    expect(modDiscussionBody(record({ note: '' }), 'IndianPets')).not.toContain('Mod note');
  });

  it('still writes the wiki row when mod discussions fail', async () => {
    const h = harness(
      { modmailLogEnabled: true },
      { failOn: { modDiscussion: new Error('MODMAIL_DOWN') } },
    );
    await h.service.record(record());

    expect(h.reddit.wiki.get(PAGE)).toContain('t3_abc123');
  });
});

describe('wiki privacy', () => {
  it('writes nothing at all when the page cannot be confirmed moderator-only', async () => {
    // Reddit's default wiki permission is world-readable, and the row names the
    // verifying moderator. Failing closed is the whole point.
    const h = harness();
    h.reddit.wikiPrivate = false;

    await h.service.record(record());

    expect(h.reddit.wiki.size).toBe(0);
    expect(h.reddit.calls).not.toContain('writeWiki');
  });

  it('confirms privacy before every append, not just on creation', async () => {
    const h = harness();
    await h.service.record(record());

    // A moderator could relax the page settings between verifications.
    h.reddit.wikiPrivate = false;
    await h.service.record(record({ postId: 't3_second' as T3 }));

    const page = h.reddit.wiki.get(PAGE) ?? '';
    expect(page).toContain('t3_abc123');
    expect(page).not.toContain('t3_second');
  });

  it('seeds a new page with a header that names nobody', async () => {
    const h = harness();
    await h.service.record(record());

    const page = h.reddit.wiki.get(PAGE) ?? '';
    const header = page.split('`t3_abc123`')[0] ?? '';
    expect(header).not.toContain('u/op_user');
    expect(header).not.toContain('u/mod_one');
    expect(header).toContain('Moderators only');
  });

  it('still posts to mod discussions when the wiki is refused', async () => {
    const h = harness({ modmailLogEnabled: true });
    h.reddit.wikiPrivate = false;

    await h.service.record(record());

    expect(h.reddit.wiki.size).toBe(0);
    expect(h.reddit.modDiscussions).toHaveLength(1);
  });
});

/**
 * The on-demand wiki check.
 *
 * The whole point of it is to replace "verify a real fundraiser and then go
 * read devvit logs" as the only way to find out whether the durable log works.
 */
describe('check', () => {
  it('confirms a page it had to create, and says it created it', async () => {
    const h = harness();

    const result = await h.service.check();

    expect(result).toEqual({
      kind: 'ready',
      page: PAGE,
      openPage: 'fundraiser-verifications',
      rows: 0,
      createdNow: true,
    });
    expect(h.reddit.wiki.has(PAGE)).toBe(true);
  });

  it('builds a start page that links every month and the poster history index', async () => {
    const h = harness();
    await h.service.record(record());
    await h.service.record(record({ postId: 't3_old' as T3, verifiedAtMs: NOW - 40 * 86_400_000 }));
    await h.service.check();

    const hub = h.reddit.wiki.get('fundraiser-verifications') ?? '';
    expect(hub).toContain('https://old.reddit.com/r/IndianPets/wiki/fundraiser-verifications/2026-09');
    expect(hub).toContain('https://old.reddit.com/r/IndianPets/wiki/fundraiser-verifications/2026-08');
    expect(hub).toContain('https://old.reddit.com/r/IndianPets/wiki/fundraiser-verifications/users');
    expect(hub.indexOf('2026-09')).toBeLessThan(hub.indexOf('2026-08'));
    expect(hub).not.toContain('mod_one');
  });

  it('seeds the new page with nothing that names a moderator', async () => {
    const h = harness();

    await h.service.check();

    expect(h.reddit.wiki.get(PAGE)).not.toContain('mod_one');
  });

  it('counts the verifications already on an existing page', async () => {
    const h = harness();
    await h.service.record(record({ postId: 't3_one' as T3 }));
    await h.service.record(record({ postId: 't3_two' as T3 }));

    const result = await h.service.check();

    expect(result).toEqual({
      kind: 'ready',
      page: PAGE,
      openPage: 'fundraiser-verifications',
      rows: 2,
      createdNow: false,
    });
  });

  it('reports why nothing can be written when the page cannot be restricted', async () => {
    const h = harness();
    h.reddit.wikiPrivate = false;

    const result = await h.service.check();

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.page).toBe(PAGE);
    expect(result.reason).toContain('wiki is disabled');
  });

  it('says so when the wiki log is switched off rather than pretending to check', async () => {
    const h = harness({ wikiLogEnabled: false });

    expect(await h.service.check()).toEqual({ kind: 'off' });
    expect(h.reddit.calls).toEqual([]);
  });

  it('checks the same page a verification right now would write to', async () => {
    const h = harness();

    const checked = await h.service.check();
    await h.service.record(record());

    expect(checked.kind).toBe('ready');
    if (checked.kind !== 'ready') return;
    expect(h.reddit.wiki.get(checked.page)).toContain('t3_abc123');
  });
});

describe('countRows', () => {
  it('ignores the header and counts one per verification', () => {
    expect(countRows(null)).toBe(0);
    expect(countRows(auditPageHeader('indianpets'))).toBe(0);
    expect(
      countRows([auditPageHeader('indianpets'), auditRow(record(), 'indianpets')].join('\n')),
    ).toBe(1);
  });
});
