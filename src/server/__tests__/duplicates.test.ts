import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { JOBS } from '../config.js';
import { createLinkRepo } from '../data/linkRepo.js';
import { createVerificationRepo } from '../data/verificationRepo.js';
import type { DuplicateService } from '../services/duplicates.js';
import { createDuplicateService, isDuplicateFinding } from '../services/duplicates.js';
import type { AppSettings } from '../settings.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const NOW = 1_700_000_000_000;
const KETTO = 'https://ketto.org/fundraiser/save-bruno';

type Harness = {
  service: DuplicateService;
  redis: FakeRedis;
  reddit: FakeReddit;
  scheduler: FakeScheduler;
  records: ReturnType<typeof createVerificationRepo>;
  setNow(ms: number): void;
};

function harness(
  settingsOverrides: Partial<AppSettings> = {},
  redditOptions: FakeRedditOptions = {},
): Harness {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit(redditOptions);
  const scheduler = new FakeScheduler();
  let clock = NOW;

  const service = createDuplicateService({
    links: createLinkRepo(redis),
    records: createVerificationRepo(redis),
    reddit,
    scheduler,
    settings: fakeSettings(settingsOverrides),
    log: fakeLogger(),
    now: () => clock,
  });

  return {
    service,
    redis,
    reddit,
    scheduler,
    records: createVerificationRepo(redis),
    setNow(ms) {
      clock = ms;
      redis.nowMs = ms;
    },
  };
}

function post(postId: string, author: string | null, body: string) {
  return { postId: postId as T3, author, title: '', body, url: '' };
}

describe('inspectPost', () => {
  it('records a first sighting without reporting anything', async () => {
    const h = harness();
    const finding = await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    expect(finding).toBeNull();
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('flags a second post carrying the same campaign from a different author', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    const finding = await h.service.inspectPost(
      post('t3_second', 'bob', 'mirror: https://www.ketto.org/fundraiser/save-bruno?utm_source=x'),
    );

    expect(finding).toMatchObject({
      postId: 't3_second',
      originalPostId: 't3_first',
      originalAuthor: 'alice',
      sameAuthor: false,
    });
    expect(h.scheduler.jobsNamed(JOBS.duplicateReport)).toHaveLength(1);
  });

  it('marks a repost by the same author as such', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'Alice', KETTO));

    expect(finding?.sameAuthor).toBe(true);
  });

  it('stays quiet about same-author reposts when configured to', async () => {
    const h = harness({ reportSameAuthorReposts: false });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    expect(await h.service.inspectPost(post('t3_second', 'alice', KETTO))).toBeNull();
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('reports one finding per post, not one per repeated URL shape', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.service.inspectPost(post('t3_other', 'alice', 'https://milaap.org/fundraisers/bruno'));

    const finding = await h.service.inspectPost(
      post('t3_second', 'bob', `${KETTO} and https://milaap.org/fundraisers/bruno`),
    );

    expect(finding).not.toBeNull();
    expect(h.scheduler.jobsNamed(JOBS.duplicateReport)).toHaveLength(1);
  });

  it('is idempotent when the trigger is redelivered', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    const first = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    const second = await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(h.scheduler.jobsNamed(JOBS.duplicateReport)).toHaveLength(1);
  });

  it('does not flag a post against itself on redelivery', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    expect(await h.service.inspectPost(post('t3_first', 'alice', KETTO))).toBeNull();
  });

  it('does nothing when the feature or the app is switched off', async () => {
    const off = harness({ duplicateDetectionEnabled: false });
    await off.service.inspectPost(post('t3_first', 'alice', KETTO));
    expect(await off.service.inspectPost(post('t3_second', 'bob', KETTO))).toBeNull();

    const disabled = harness({ enabled: false });
    expect(await disabled.service.inspectPost(post('t3_a', 'alice', KETTO))).toBeNull();
  });

  it('makes no Reddit calls at all - reporting is the scheduler’s job', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    expect(h.reddit.calls).toEqual([]);
  });

  it('reads every link in a post with one batched call', async () => {
    const h = harness();
    h.redis.mGetCalls = 0;
    await h.service.inspectPost(
      post('t3_first', 'alice', `${KETTO} https://milaap.org/fundraisers/x https://give.do/fundraisers/y`),
    );
    expect(h.redis.mGetCalls).toBe(1);
  });
});

describe('report', () => {
  it('sends the post to the modqueue and never removes it', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    if (!finding) throw new Error('expected a finding');

    await h.service.report(finding);

    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.reports[0]?.postId).toBe('t3_second');
    expect(h.reddit.reports[0]?.reason).toContain('t3_first');
    expect(h.reddit.reports[0]?.reason).toContain('u/alice');
  });

  it('uses quieter wording for a same-author repost', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'alice', KETTO));
    if (!finding) throw new Error('expected a finding');

    await h.service.report(finding);
    expect(h.reddit.reports[0]?.reason).toContain('Repost');
  });

  it('skips the author lookup entirely when no thresholds are set', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    if (!finding) throw new Error('expected a finding');

    await h.service.report(finding);
    expect(h.reddit.calls).not.toContain('getAuthor');
  });

  it('annotates the report when the author is below a configured threshold', async () => {
    const h = harness(
      { minAccountAgeDays: 30, minKarma: 100 },
      { author: { username: 'bob', accountAgeDays: 3, karma: 12 } },
    );
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    if (!finding) throw new Error('expected a finding');

    await h.service.report(finding);
    expect(h.reddit.reports[0]?.reason).toContain('new account');
  });

  it('leaves the reason alone for an established author', async () => {
    const h = harness(
      { minAccountAgeDays: 30, minKarma: 100 },
      { author: { username: 'bob', accountAgeDays: 900, karma: 8000 } },
    );
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    if (!finding) throw new Error('expected a finding');

    await h.service.report(finding);
    expect(h.reddit.reports[0]?.reason).not.toContain('new account');
  });
});

describe('forgetPost', () => {
  it('releases the links a deleted post owned, so a new post may claim them', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.service.forgetPost('t3_first' as T3);

    // With ownership released, the next post is a first sighting again.
    expect(await h.service.inspectPost(post('t3_second', 'bob', KETTO))).toBeNull();
  });

  it('does not release a link another post has since claimed', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    // t3_second never owned the link, so forgetting it must change nothing.
    await h.service.forgetPost('t3_second' as T3);
    expect(await h.service.inspectPost(post('t3_third', 'carol', KETTO))).not.toBeNull();
  });

  it('tolerates a post it has never seen', async () => {
    const h = harness();
    await expect(h.service.forgetPost('t3_unknown' as T3)).resolves.toBeUndefined();
  });
});

describe('isDuplicateFinding', () => {
  it('accepts a well-formed payload and rejects anything else', () => {
    const valid = {
      postId: 't3_a',
      author: 'bob',
      originalPostId: 't3_b',
      originalAuthor: null,
      display: 'ketto.org/fundraiser/x',
      shortened: false,
      sameAuthor: false,
      hoursSincePrevious: 5,
      tooSoon: false,
    };
    expect(isDuplicateFinding(valid)).toBe(true);
    expect(isDuplicateFinding({ ...valid, postId: 'not-a-post' })).toBe(false);
    expect(isDuplicateFinding({ ...valid, sameAuthor: 'yes' })).toBe(false);
    expect(isDuplicateFinding({ ...valid, hoursSincePrevious: '5' })).toBe(false);
    expect(isDuplicateFinding({ ...valid, tooSoon: undefined })).toBe(false);
    expect(isDuplicateFinding(null)).toBe(false);
    expect(isDuplicateFinding('t3_a')).toBe(false);
  });
});

const HOUR = 3_600_000;

describe('legitimate reposts', () => {
  it('does NOT report a same-author repost that waited out the window', async () => {
    const h = harness({ sameAuthorRepostHours: 24 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    h.setNow(NOW + 25 * HOUR);
    const finding = await h.service.inspectPost(post('t3_second', 'alice', KETTO));

    expect(finding).toBeNull();
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('does report a same-author repost that came too soon, with the numbers', async () => {
    const h = harness({ sameAuthorRepostHours: 24 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    h.setNow(NOW + 3 * HOUR);
    const finding = await h.service.inspectPost(post('t3_second', 'alice', KETTO));

    expect(finding).toMatchObject({ sameAuthor: true, tooSoon: true, hoursSincePrevious: 3 });

    await h.service.report(finding!);
    expect(h.reddit.reports[0]?.reason).toContain('after 3h');
    expect(h.reddit.reports[0]?.reason).toContain('minimum is 24h');
  });

  it('restarts the clock from the newest allowed repost', async () => {
    const h = harness({ sameAuthorRepostHours: 24 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    // Allowed repost 25h later takes ownership.
    h.setNow(NOW + 25 * HOUR);
    expect(await h.service.inspectPost(post('t3_second', 'alice', KETTO))).toBeNull();

    // Another one 3h after THAT is too soon, measured from the second post -
    // not from the original, which would have said 28h and let it through.
    h.setNow(NOW + 28 * HOUR);
    const finding = await h.service.inspectPost(post('t3_third', 'alice', KETTO));

    expect(finding).toMatchObject({ tooSoon: true, hoursSincePrevious: 3 });
    expect(finding?.originalPostId).toBe('t3_second');
  });

  it('still reports a DIFFERENT author however long ago the first post was', async () => {
    const h = harness({ sameAuthorRepostHours: 24 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    h.setNow(NOW + 200 * HOUR);
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    expect(finding).toMatchObject({ sameAuthor: false, tooSoon: false });
    expect(h.scheduler.jobsNamed(JOBS.duplicateReport)).toHaveLength(1);
  });

  it('a window of 0 means no waiting period, so nothing is reported', async () => {
    const h = harness({ sameAuthorRepostHours: 0 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    h.setNow(NOW + 500 * HOUR);
    expect(await h.service.inspectPost(post('t3_second', 'alice', KETTO))).toBeNull();
  });

  it('a very large window flags every same-author repost, for subs that ban them', async () => {
    const h = harness({ sameAuthorRepostHours: 8760 });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));

    h.setNow(NOW + 500 * HOUR);
    expect(await h.service.inspectPost(post('t3_second', 'alice', KETTO))).not.toBeNull();
  });

  it('hands ownership over when same-author reporting is switched off', async () => {
    const h = harness({ reportSameAuthorReposts: false });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.service.inspectPost(post('t3_second', 'alice', KETTO));

    // t3_second now owns the link, so a later different-author post is
    // compared against it rather than the original.
    const finding = await h.service.inspectPost(post('t3_third', 'bob', KETTO));
    expect(finding?.originalPostId).toBe('t3_second');
  });

  it('tells the moderator when the earlier post was already verified', async () => {
    const h = harness();
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    await h.records.putComplete({
      schemaVersion: 2,
      postId: 't3_first' as T3,
      authorName: 'alice',
      modName: 'mod_one',
      verifiedAtMs: NOW,
      status: 'complete',
      note: '',
      checklist: null,
      commentId: 't1_x',
      templateLabel: null,
      deletedAtMs: null,
      reminderSentAtMs: null,
      opRespondedAtMs: null,
      escalatedAtMs: null,
    });

    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));
    await h.service.report(finding!);

    expect(h.reddit.reports[0]?.reason).toContain('verified');
  });
});

describe('fundraiser flair gating', () => {
  const snapshot = (flairText: string | null) => ({
    id: 't3_second' as T3,
    authorName: 'bob',
    isApproved: false,
    isRemoved: false,
    flairText,
  });

  it('reports a duplicate on a post carrying the fundraiser flair', async () => {
    const h = harness({ fundraiserFlairText: 'Fundraiser' }, { post: snapshot('Fundraiser') });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    await h.service.report(finding!);
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('does not report a duplicate on a post that is not a fundraiser', async () => {
    const h = harness({ fundraiserFlairText: 'Fundraiser' }, { post: snapshot('Discussion') });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    await h.service.report(finding!);
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('skips the flair lookup entirely when no flair is configured', async () => {
    const h = harness({ fundraiserFlairText: '' });
    await h.service.inspectPost(post('t3_first', 'alice', KETTO));
    const finding = await h.service.inspectPost(post('t3_second', 'bob', KETTO));

    await h.service.report(finding!);
    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.calls.filter((call) => call === 'getPost')).toHaveLength(0);
  });
});
