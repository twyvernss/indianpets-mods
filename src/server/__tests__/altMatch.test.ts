import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { JOBS } from '../config.js';
import { createFingerprintRepo } from '../data/fingerprintRepo.js';
import type { StoredFingerprint } from '../data/fingerprintRepo.js';
import { keys } from '../data/keys.js';
import { createLinkRepo } from '../data/linkRepo.js';
import { allByScore, newestByScore } from '../data/redisPort.js';
import {
  extractPaymentIdentifiers,
  fingerprintPost,
  signatureSimilarity,
  textSignature,
} from '../lib/fingerprint.js';
import { createAltService, rankMatches } from '../services/altMatch.js';
import type { PostContent } from '../services/redditPort.js';
import type { AppSettings } from '../settings.js';
import { buildAltReportReason, describeMatch } from '../text.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const NOW = 1_700_000_000_000;

const STORY =
  'My dog Bruno was hit by a car near our house last night and the vet says he needs surgery on his back leg urgently. ' +
  'The clinic has asked for the full amount before they operate and we cannot afford it on our own. ' +
  'Please help us save him, every rupee counts and we will share the bills and updates here.';

function post(id: string, author: string | null, body: string, overrides: Partial<PostContent> = {}): PostContent {
  return {
    id: id as T3,
    authorName: author,
    title: 'Please help my dog',
    body,
    url: `https://www.reddit.com/r/IndianPets/comments/${id.replace('t3_', '')}/`,
    createdAtMs: NOW,
    ...overrides,
  };
}

describe('payment identifiers', () => {
  it('finds UPI IDs, Indian mobiles and labelled bank accounts', () => {
    const ids = extractPaymentIdentifiers(
      'GPay bruno.help@okaxis or call +91 98765 43210. A/c no 123456789012, IFSC SBIN0001234',
    );
    expect(ids.filter((id) => id.startsWith('upi:'))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('phone:'))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('bank:'))).toHaveLength(1);
  });

  it('treats differently written copies of one number as the same', () => {
    const a = extractPaymentIdentifiers('call 9876543210');
    const b = extractPaymentIdentifiers('call +91-98765-43210');
    const c = extractPaymentIdentifiers('call 098765 43210');
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('ignores e-mail addresses, unlabelled digit runs and numbers inside links', () => {
    expect(extractPaymentIdentifiers('mail me at someone@gmail.com')).toEqual([]);
    expect(extractPaymentIdentifiers('order 123456789012 shipped')).toEqual([]);
    expect(extractPaymentIdentifiers('see https://example.org/case/9876543210')).toEqual([]);
  });

  it('never stores the identifier itself', () => {
    const [id] = extractPaymentIdentifiers('UPI bruno.help@okaxis');
    expect(id).toMatch(/^upi:[0-9a-f]{8}$/u);
    expect(id).not.toContain('bruno');
  });
});

describe('wording signature', () => {
  it('scores a lightly edited copy as very similar and an unrelated post as not', () => {
    const original = textSignature(STORY);
    const edited = textSignature(STORY.replace('Bruno', 'Sheru').replace('last night', 'yesterday'));
    const other = textSignature(
      'Looking for a home for two kittens found near the railway station in Pune. They are healthy, dewormed and litter trained, and need a calm family with no other cats.',
    );
    if (!original || !edited || !other) throw new Error('expected signatures');

    expect(signatureSimilarity(original, edited)).toBeGreaterThan(0.6);
    expect(signatureSimilarity(original, other)).toBeLessThan(0.2);
  });

  it('declines to sign a post too short to say anything', () => {
    expect(textSignature('help my dog please')).toBeNull();
  });
});

function fp(postId: string, author: string, ids: string[], sig: number[] | null = null): StoredFingerprint {
  return { postId: postId as T3, author, postedAtMs: NOW, ids, sig };
}

describe('rankMatches', () => {
  it('puts shared payment details above a shared link, and ignores the person themselves', () => {
    const own = [fp('t3_new', 'newbie', ['upi:aaaa', 'link:x'])];
    const ranked = rankMatches(
      own,
      'Newbie',
      [
        fp('t3_1', 'linkonly', ['link:x']),
        fp('t3_2', 'payer', ['upi:aaaa']),
        fp('t3_3', 'NEWBIE', ['upi:aaaa']),
      ],
      0.7,
    );
    expect(ranked.map((match) => match.author)).toEqual(['payer', 'linkonly']);
    expect(ranked[0]?.shared).toEqual({ upi: 1 });
  });

  it('counts wording alone only at or above the threshold', () => {
    const sig = textSignature(STORY);
    const copy = textSignature(STORY.replace('Bruno', 'Sheru'));
    if (!sig || !copy) throw new Error('expected signatures');

    const own = [fp('t3_new', 'newbie', [], sig)];
    expect(rankMatches(own, 'newbie', [fp('t3_1', 'old', [], copy)], 0.5)).toHaveLength(1);
    expect(rankMatches(own, 'newbie', [fp('t3_1', 'old', [], copy)], 1.01)).toHaveLength(0);
  });

  it('merges several posts by one account into one match', () => {
    const own = [fp('t3_new', 'newbie', ['upi:a', 'phone:b'])];
    const ranked = rankMatches(
      own,
      'newbie',
      [fp('t3_1', 'old', ['upi:a']), fp('t3_2', 'old', ['phone:b'])],
      0.7,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.shared).toEqual({ upi: 1, phone: 1 });
    expect(ranked[0]?.postIds).toHaveLength(2);
  });
});

describe('match wording', () => {
  it('reads naturally and fits a report reason', () => {
    const match = { author: 'old_account', shared: { upi: 1, phone: 1 }, textSimilarity: 0.82, banned: true };
    expect(describeMatch(match)).toBe('same UPI ID, phone; 82% same wording');
    const reason = buildAltReportReason(match);
    expect(reason).toContain('u/old_account (BANNED here)');
    expect(reason.length).toBeLessThanOrEqual(100);
  });
});

function harness(overrides: Partial<AppSettings> = {}, redditOptions: FakeRedditOptions = {}) {
  const redis = new FakeRedis();
  redis.nowMs = NOW;
  const reddit = new FakeReddit(redditOptions);
  const scheduler = new FakeScheduler();
  const fingerprints = createFingerprintRepo(redis);
  const links = createLinkRepo(redis);
  const service = createAltService({
    fingerprints,
    links,
    reddit,
    scheduler,
    settings: fakeSettings(overrides),
    log: fakeLogger(),
    now: () => NOW,
  });
  return { redis, reddit, scheduler, fingerprints, links, service };
}

describe('alt check', () => {
  it('reports a new account reusing a banned account’s UPI ID, and says it is banned', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'banned_one', `${STORY} UPI bruno.help@okaxis`));
    h.reddit.banned.add('banned_one');

    const outcome = await h.service.check(
      post('t3_new', 'fresh_account', 'Totally different words about a cat. UPI bruno.help@okaxis'),
    );

    expect(outcome.kind).toBe('matched');
    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.reports[0]?.reason).toContain('Possible alt of u/banned_one (BANNED here)');
    expect(h.reddit.reports[0]?.reason).toContain('same UPI ID');
  });

  it('reports a copied story with no shared details', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', STORY));
    await h.service.check(post('t3_new', 'second', STORY.replace('Bruno', 'Sheru')));
    expect(h.reddit.reports[0]?.reason).toContain('% same wording');
  });

  it('leaves a shared link alone to the duplicate detector unless the account is banned', async () => {
    const h = harness();
    const link = 'Donate at https://milaap.org/fundraisers/support-bruno';
    await h.service.index(post('t3_old', 'first', link));
    await h.service.check(post('t3_new', 'second', link));
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('does not report honest posters who share a clinic phone number many accounts use', async () => {
    const h = harness();
    const clinic = 'Treatment at Pet Care Clinic, call 9876543210 for the bill.';
    await h.service.index(post('t3_a', 'owner_a', `${clinic} Our cat Mau.`));
    await h.service.index(post('t3_b', 'owner_b', `${clinic} Our dog Tiger.`));
    await h.service.index(post('t3_c', 'owner_c', `${clinic} Our dog Kalu.`));

    await h.service.check(post('t3_new', 'owner_d', `${clinic} Our kitten Bunny.`));
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('still reports a shared common detail when the matched account is banned', async () => {
    const h = harness();
    const clinic = 'call 9876543210';
    for (const name of ['owner_a', 'owner_b', 'banned_one']) {
      await h.service.index(post(`t3_${name}`, name, clinic));
    }
    h.reddit.banned.add('banned_one');

    await h.service.check(post('t3_new', 'fresh', clinic));
    expect(h.reddit.reports[0]?.reason).toContain('u/banned_one (BANNED here)');
  });

  it('still reports a distinctive UPI ID alongside a common clinic number', async () => {
    const h = harness();
    const clinic = 'call 9876543210';
    await h.service.index(post('t3_a', 'owner_a', clinic));
    await h.service.index(post('t3_b', 'owner_b', clinic));
    await h.service.index(post('t3_c', 'owner_c', `${clinic} UPI bruno.help@okaxis`));

    await h.service.check(post('t3_new', 'fresh', `${clinic} UPI bruno.help@okaxis`));
    expect(h.reddit.reports[0]?.reason).toContain('Possible alt of u/owner_c');
  });

  it('does not treat a post template many accounts follow as copied wording', async () => {
    const h = harness();
    const template = (pet: string) =>
      `Pet name: ${pet}. Species and age: please fill in. Vet clinic and city: please fill in. ` +
      'Total bill amount and what it covers: please fill in. Amount already raised so far: please fill in. ' +
      'How to donate and who receives the money: please fill in. Updates will be posted in the comments below.';
    for (const [id, name] of [['t3_a', 'owner_a'], ['t3_b', 'owner_b'], ['t3_c', 'owner_c']] as const) {
      await h.service.index(post(id, name, template(name)));
    }

    await h.service.check(post('t3_new', 'owner_d', template('Bunny')));
    expect(h.reddit.reports).toHaveLength(0);

    // Control: the same wording against ONE other account is a copied story.
    const single = harness();
    await single.service.index(post('t3_a', 'owner_a', template('owner_a')));
    await single.service.check(post('t3_new', 'owner_d', template('Bunny')));
    expect(single.reddit.reports[0]?.reason).toContain('% same wording');
  });

  it('does not report the same post twice', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', `${STORY} 9876543210`));
    await h.service.check(post('t3_new', 'second', 'call 9876543210 please help our cat today'));
    await h.service.check(post('t3_new', 'second', 'call 9876543210 please help our cat today'));
    expect(h.reddit.reports).toHaveLength(1);
  });

  it('never matches a person against their own earlier posts', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', `${STORY} 9876543210`));
    await expect(h.service.check(post('t3_again', 'FIRST', `${STORY} 9876543210`))).resolves.toEqual({
      kind: 'no-match',
    });
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('skips a post the duplicate detector already reported, unless the match is banned', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', 'UPI bruno.help@okaxis'));
    await h.links.markReported('t3_new' as T3, NOW);
    await h.service.check(post('t3_new', 'second', 'UPI bruno.help@okaxis'));
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('reports only posts with the chosen fundraiser flair, even for a banned match', async () => {
    const h = harness({ fundraiserFlairText: 'Fundraiser' });
    h.reddit.banned.add('first');
    await h.service.index(post('t3_old', 'first', 'UPI bruno.help@okaxis'));
    await h.service.check(post('t3_new', 'second', 'UPI bruno.help@okaxis'));
    expect(h.reddit.reports).toHaveLength(0);

    const flaired = harness(
      { fundraiserFlairText: 'Fundraiser' },
      { post: { id: 't3_x' as T3, authorName: 'third', isApproved: true, isRemoved: false, flairText: 'Fundraiser' } },
    );
    flaired.reddit.banned.add('first');
    await flaired.service.index(post('t3_old', 'first', 'UPI bruno.help@okaxis'));
    await flaired.service.check(post('t3_new2', 'third', 'UPI bruno.help@okaxis'));
    expect(flaired.reddit.reports).toHaveLength(1);
  });

  it('queues a rebuild of the poster’s history page', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', 'UPI bruno.help@okaxis'));
    await h.service.check(post('t3_new', 'second', 'UPI bruno.help@okaxis'));
    expect(h.scheduler.jobsNamed(JOBS.userHistory)[0]?.data).toEqual({ username: 'second' });
  });

  it('does nothing when switched off', async () => {
    const h = harness({ altDetectionEnabled: false });
    await expect(h.service.check(post('t3_new', 'second', STORY))).resolves.toEqual({ kind: 'off' });
    expect(await h.fingerprints.get('t3_new' as T3)).toBeNull();
  });
});

describe('newest-first reads', () => {
  it('returns the newest members, where the raw-Redis range order returns nothing', async () => {
    const redis = new FakeRedis();
    await redis.zAdd('k', { member: 'old', score: 1 }, { member: 'mid', score: 2 }, { member: 'new', score: 3 });

    expect((await newestByScore(redis, 'k', 2)).map((entry) => entry.member)).toEqual(['new', 'mid']);
    // The trap: raw Redis wants a reversed range as (max, min); Devvit does
    // that swap itself, so passing it that way matches nothing.
    expect(
      await redis.zRange('k', Number.MAX_SAFE_INTEGER, 0, { by: 'score', reverse: true, limit: { offset: 0, count: 2 } }),
    ).toEqual([]);
  });

  it('reads past the 1,000-member default page', async () => {
    const redis = new FakeRedis();
    for (let index = 0; index < 2500; index++) await redis.zAdd('k', { member: `m${index}`, score: 0 });
    expect(await allByScore(redis, 'k')).toHaveLength(2500);
  });
});

describe('fingerprint storage', () => {
  it('holds no post text', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', `${STORY} UPI bruno.help@okaxis 9876543210`));
    const raw = (await h.redis.get(keys.fingerprint('t3_old' as T3))) ?? '';
    expect(raw).not.toContain('Bruno');
    expect(raw).not.toContain('okaxis');
    expect(raw).not.toContain('9876543210');
  });

  it('forgets a deleted post completely', async () => {
    const h = harness();
    const content = post('t3_old', 'first', 'UPI bruno.help@okaxis');
    await h.service.index(content);
    await h.service.forgetPost('t3_old' as T3);

    expect(await h.fingerprints.get('t3_old' as T3)).toBeNull();
    const [upi] = fingerprintPost(content).ids;
    expect(h.redis.sizeOf(keys.fingerprintId(upi ?? ''))).toBe(0);
    expect(h.redis.sizeOf(keys.fingerprintAuthor('first'))).toBe(0);
  });

  it('backfills recent posts page by page', async () => {
    const h = harness();
    h.reddit.newPosts = Array.from({ length: 60 }, (_, index) =>
      post(`t3_p${index}`, `user${index}`, `post number ${index}`),
    );

    const first = await h.service.backfill(null);
    expect(first).toMatchObject({ indexed: 50, last: 't3_p49' });
    const second = await h.service.backfill(first.last);
    expect(second).toMatchObject({ indexed: 10, last: null });
  });

  it('indexes an old post on demand when its poster is looked up', async () => {
    const h = harness();
    await h.service.index(post('t3_old', 'first', 'UPI bruno.help@okaxis'));
    h.reddit.contents.set('t3_unseen' as T3, post('t3_unseen', 'second', 'UPI bruno.help@okaxis'));

    const matches = await h.service.matchesForAuthor('second', 't3_unseen' as T3);
    expect(matches.map((match) => match.author)).toEqual(['first']);
  });
});
