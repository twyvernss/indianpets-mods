import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { auditPageName, auditRow, createAuditLogService, modDiscussionBody } from '../services/auditLog.js';
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
  it('links the post and summarises the checklist', () => {
    const row = auditRow(record(), 'IndianPets');
    expect(row).toContain('https://www.reddit.com/r/IndianPets/comments/abc123/');
    expect(row).toContain('u/op_user');
    expect(row).toContain('u/mod_one');
    expect(row).toContain('2/3');
    expect(row).toContain('Clinic contacted');
  });

  it('NEVER writes the moderator note to the wiki', () => {
    // Wiki pages are readable by anyone unless restricted, and notes routinely
    // contain phone numbers. This is the guarantee that matters most here.
    const row = auditRow(record(), 'IndianPets');
    expect(row).not.toContain('98765');
    expect(row).not.toContain('clinic phone');
  });

  it('escapes pipes so one row cannot break the table', () => {
    const row = auditRow(
      record({ checklist: [{ label: 'Bill | receipt seen', checked: true }] }),
      'IndianPets',
    );
    expect(row).toContain('Bill \\| receipt seen');
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
    expect(page).toContain('Fundraiser verification log');
    expect(page).toContain('| --- |');
    expect(page).toContain('t3_abc123');
  });

  it('appends to an existing page instead of replacing it', async () => {
    const h = harness();
    await h.service.record(record());
    await h.service.record(record({ postId: 't3_second' as T3 }));

    const page = h.reddit.wiki.get(PAGE) ?? '';
    expect(page).toContain('t3_abc123');
    expect(page).toContain('t3_second');
    // One header, two rows.
    expect(page.split('Fundraiser verification log')).toHaveLength(2);
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

  it('omits the moderator note there too', () => {
    const body = modDiscussionBody(record(), 'IndianPets');
    expect(body).not.toContain('98765');
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
    const header = page.split('| Verified (IST) |')[0] ?? '';
    expect(header).not.toContain('u/op_user');
    expect(header).not.toContain('u/mod_one');
    expect(header).toContain('restricted to moderators');
  });

  it('still posts to mod discussions when the wiki is refused', async () => {
    const h = harness({ modmailLogEnabled: true });
    h.reddit.wikiPrivate = false;

    await h.service.record(record());

    expect(h.reddit.wiki.size).toBe(0);
    expect(h.reddit.modDiscussions).toHaveLength(1);
  });
});
