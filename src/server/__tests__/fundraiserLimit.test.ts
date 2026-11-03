import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { createLinkRepo } from '../data/linkRepo.js';
import { createFundraiserLimitService } from '../services/fundraiserLimit.js';
import type { PostContent } from '../services/redditPort.js';
import type { AppSettings } from '../settings.js';
import { buildFundraiserLimitReason } from '../text.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit } from './fakes.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function post(id: string, author: string, hoursAgo: number, flairText: string | null, body = 'Our dog is doing well'): PostContent {
  return {
    id: id as T3,
    authorName: author,
    title: 'Update',
    body,
    url: '',
    createdAtMs: NOW - hoursAgo * HOUR,
    flairText,
  };
}

function harness(overrides: Partial<AppSettings> = {}) {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit();
  const links = createLinkRepo(redis);
  const service = createFundraiserLimitService({
    reddit,
    redis,
    links,
    settings: fakeSettings({ fundraiserFlairText: 'Fundraiser', ...overrides }),
    log: fakeLogger(),
    now: () => NOW,
  });
  return { reddit, links, service };
}

describe('one fundraiser per window', () => {
  it('lets the first fundraiser through and reports a second inside 24 hours', async () => {
    const h = harness();
    await expect(h.service.check(post('t3_one', 'raiser', 5, 'Fundraiser'))).resolves.toBe('first');
    await expect(h.service.check(post('t3_two', 'raiser', 0, 'Fundraiser'))).resolves.toBe('reported');

    expect(h.reddit.reports).toEqual([
      { postId: 't3_two', reason: '2nd fundraiser in 24h from u/raiser: last one t3_one 5h ago' },
    ]);
    expect(h.reddit.calls).not.toContain('remove');
  });

  it('allows the next fundraiser once the window has passed', async () => {
    const h = harness();
    await h.service.check(post('t3_one', 'raiser', 30, 'Fundraiser'));
    await expect(h.service.check(post('t3_two', 'raiser', 0, 'Fundraiser'))).resolves.toBe('first');
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('counts a fundraiser posted under another flair, so switching flair does not reset the clock', async () => {
    const h = harness();
    await h.service.check(post('t3_one', 'raiser', 3, 'Fundraiser'));
    await expect(
      h.service.check(post('t3_two', 'raiser', 0, 'Discussion', 'please donate, GPay for the vet bill')),
    ).resolves.toBe('reported');
  });

  it('ignores ordinary posts and other people', async () => {
    const h = harness();
    await h.service.check(post('t3_one', 'raiser', 3, 'Fundraiser'));
    await expect(h.service.check(post('t3_cat', 'raiser', 1, 'Cats'))).resolves.toBe('not-a-fundraiser');
    await expect(h.service.check(post('t3_two', 'someone_else', 0, 'Fundraiser'))).resolves.toBe('first');
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('says 3rd for a third, and reports each post only once', async () => {
    const h = harness();
    await h.service.check(post('t3_one', 'raiser', 10, 'Fundraiser'));
    await h.service.check(post('t3_two', 'raiser', 5, 'Fundraiser'));
    await h.service.check(post('t3_three', 'raiser', 0, 'Fundraiser'));
    await expect(h.service.check(post('t3_three', 'raiser', 0, 'Fundraiser'))).resolves.toBe('already-reported');
    expect(h.reddit.reports.at(-1)?.reason).toContain('3rd fundraiser in 24h');
    expect(h.reddit.reports).toHaveLength(2);
  });

  it('leaves a same-link repost to the duplicate report, so one post is not reported twice', async () => {
    const h = harness();
    await h.service.check(post('t3_one', 'raiser', 3, 'Fundraiser'));
    await h.links.markReported('t3_two' as T3, NOW);
    await expect(h.service.check(post('t3_two', 'raiser', 0, 'Fundraiser'))).resolves.toBe('left-to-duplicate-report');
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('counts past fundraisers recorded by the install scan, without reporting them', async () => {
    const h = harness();
    await h.service.record(post('t3_old', 'raiser', 2, 'Fundraiser'));
    expect(h.reddit.reports).toHaveLength(0);
    await expect(h.service.check(post('t3_new', 'raiser', 0, 'Fundraiser'))).resolves.toBe('reported');
  });

  it('honours the configured window, and 0 switches the rule off', async () => {
    const week = harness({ fundraiserLimitHours: 168 });
    await week.service.check(post('t3_one', 'raiser', 100, 'Fundraiser'));
    await expect(week.service.check(post('t3_two', 'raiser', 0, 'Fundraiser'))).resolves.toBe('reported');
    expect(week.reddit.reports[0]?.reason).toContain('in 168h');

    const off = harness({ fundraiserLimitHours: 0 });
    await expect(off.service.check(post('t3_two', 'raiser', 0, 'Fundraiser'))).resolves.toBe('off');
  });
});

describe('limit report reason', () => {
  it('reads naturally and fits the report length limit', () => {
    expect(
      buildFundraiserLimitReason({ count: 2, windowHours: 24, author: 'a', lastPostId: 't3_x', hoursAgo: 0 }),
    ).toBe('2nd fundraiser in 24h from u/a: last one t3_x under 1h ago');
    expect(
      buildFundraiserLimitReason({
        count: 4,
        windowHours: 24,
        author: 'a_really_long_username_here',
        lastPostId: 't3_abcdefg',
        hoursAgo: 23,
      }).length,
    ).toBeLessThanOrEqual(100);
  });
});
