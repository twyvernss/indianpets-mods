import type { T3 } from '@devvit/web/shared';
import { describe, expect, it } from 'vitest';
import { CONFIG, JOBS } from '../config.js';
import { keys } from '../data/keys.js';
import { createVerificationRepo } from '../data/verificationRepo.js';
import type { ReminderService } from '../services/reminders.js';
import { createReminderService } from '../services/reminders.js';
import type { AppSettings } from '../settings.js';
import type { VerificationRecord } from '../types.js';
import { fakeLogger, fakeSettings, FakeRedis, FakeReddit, FakeScheduler } from './fakes.js';
import type { FakeRedditOptions } from './fakes.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

type Harness = {
  service: ReminderService;
  repo: ReturnType<typeof createVerificationRepo>;
  redis: FakeRedis;
  reddit: FakeReddit;
  scheduler: FakeScheduler;
  setNow(ms: number): void;
  seed(record: Partial<VerificationRecord> & { postId: string }): Promise<void>;
};

function harness(
  settingsOverrides: Partial<AppSettings> = {},
  redditOptions: FakeRedditOptions = {},
): Harness {
  const redis = new FakeRedis();
  const reddit = new FakeReddit(redditOptions);
  const scheduler = new FakeScheduler();
  let clock = NOW;
  redis.nowMs = clock;

  const repo = createVerificationRepo(redis);
  const service = createReminderService({
    repo,
    reddit,
    scheduler,
    settings: fakeSettings(settingsOverrides),
    log: fakeLogger(),
    now: () => clock,
  });

  return {
    service,
    repo,
    redis,
    reddit,
    scheduler,
    setNow(ms) {
      clock = ms;
      redis.nowMs = ms;
    },
    async seed(partial) {
      const record: VerificationRecord = {
        schemaVersion: 2,
        authorName: 'op_user',
        modName: 'mod_one',
        verifiedAtMs: NOW - 40 * DAY,
        status: 'complete',
        note: '',
        checklist: null,
        commentId: 't1_x',
      templateLabel: null,
        deletedAtMs: null,
        reminderSentAtMs: null,
        opRespondedAtMs: null,
        escalatedAtMs: null,
        ...partial,
        postId: partial.postId as T3,
      } satisfies VerificationRecord;
      await repo.putComplete(record);
    },
  };
}

describe('sweep - reminding', () => {
  it('comments once on a fundraiser that is past the reminder window', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.reminded).toBe(1);
    expect(h.reddit.comments).toHaveLength(1);
    expect(h.reddit.lastCommentText).toContain('u/op_user');
    expect(h.reddit.lastCommentText).toContain('complete');
    expect((await h.repo.get('t3_old' as T3))?.reminderSentAtMs).toBe(NOW);
  });

  it('leaves a fundraiser that is not old enough alone', async () => {
    const h = harness();
    await h.seed({ postId: 't3_recent', verifiedAtMs: NOW - 5 * DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.examined).toBe(0);
    expect(h.reddit.comments).toHaveLength(0);
  });

  it('does not remind twice', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(h.reddit.comments).toHaveLength(1);
  });

  it('rolls back the timestamp if the comment fails, so the next sweep retries', async () => {
    const h = harness({}, { failOn: { comment: new Error('503 unavailable') } });
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.reminded).toBe(0);
    expect((await h.repo.get('t3_old' as T3))?.reminderSentAtMs).toBeNull();
  });

  it('honours custom reminder wording', async () => {
    const h = harness({ customReminderText: 'Hi {op}, {days} days in r/{subreddit}, {grace} to go.' });
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.reddit.lastCommentText).toBe('Hi u/op_user, 40 days in r/IndianPets, 7 to go.');
  });

  it('does nothing when reminders or the app are switched off', async () => {
    const off = harness({ staleRemindersEnabled: false });
    await off.seed({ postId: 't3_old' });
    expect((await off.service.sweep({ offset: 0, batchIndex: 0 })).examined).toBe(0);

    const disabled = harness({ enabled: false });
    await disabled.seed({ postId: 't3_old' });
    expect((await disabled.service.sweep({ offset: 0, batchIndex: 0 })).examined).toBe(0);
  });
});

describe('sweep - escalation', () => {
  it('reports to the modqueue after the grace period, without removing', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 8 * DAY);
    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.escalated).toBe(1);
    expect(h.reddit.reports).toHaveLength(1);
    expect(h.reddit.reports[0]?.reason).toContain('no update from OP');
    expect(h.reddit.locked).toHaveLength(0);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);
  });

  it('waits out the grace period before escalating', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 3 * DAY);
    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.escalated).toBe(0);
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('locks the post only when the subreddit has opted in', async () => {
    const h = harness({ lockStalePosts: true });
    await h.seed({ postId: 't3_old' });

    await h.service.sweep({ offset: 0, batchIndex: 0 });
    h.setNow(NOW + 8 * DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(h.reddit.locked).toEqual(['t3_old']);
  });

  it('closes the chase when the post has gone from Reddit', async () => {
    const h = harness({}, { post: null });
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.closed).toBe(1);
    expect(h.reddit.comments).toHaveLength(0);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);
  });

  it('closes the chase for a post that was already deleted', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old', deletedAtMs: NOW - DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.closed).toBe(1);
    expect(h.reddit.comments).toHaveLength(0);
  });
});

describe('sweep - batching', () => {
  it('processes a bounded page and chains the next one', async () => {
    const h = harness();
    for (let index = 0; index < CONFIG.reminders.batchSize; index++) {
      await h.seed({ postId: `t3_p${index}`, verifiedAtMs: NOW - (50 + index) * DAY });
    }

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });

    expect(result.examined).toBe(CONFIG.reminders.batchSize);
    expect(result.chained).toBe(true);

    const chained = h.scheduler.jobsNamed(JOBS.staleSweepBatch);
    expect(chained).toHaveLength(1);
    expect(chained[0]?.data['offset']).toBe(CONFIG.reminders.batchSize);
    expect(chained[0]?.data['batchIndex']).toBe(1);
  });

  it('does not chain when the page was not full', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.chained).toBe(false);
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('stops chaining at the configured ceiling', async () => {
    const h = harness();
    for (let index = 0; index < CONFIG.reminders.batchSize; index++) {
      await h.seed({ postId: `t3_p${index}`, verifiedAtMs: NOW - (50 + index) * DAY });
    }

    const result = await h.service.sweep({
      offset: 0,
      batchIndex: CONFIG.reminders.maxChainedBatches - 1,
    });

    expect(result.chained).toBe(false);
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it('keeps going when one post in the page fails', async () => {
    // Every comment fails; the sweep must still examine the whole page rather
    // than abandoning it at the first error.
    const h = harness({}, { failOn: { comment: new Error('503 unavailable') } });
    await h.seed({ postId: 't3_a', verifiedAtMs: NOW - 50 * DAY });
    await h.seed({ postId: 't3_b', verifiedAtMs: NOW - 49 * DAY });

    const result = await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(result.examined).toBe(2);
    expect(result.reminded).toBe(0);
    // Both stay in the open index, so tomorrow's sweep retries them.
    expect(h.redis.sizeOf(keys.openIndex())).toBe(2);
  });

  it('reads the whole page with one batched call', async () => {
    const h = harness();
    await h.seed({ postId: 't3_a', verifiedAtMs: NOW - 50 * DAY });
    await h.seed({ postId: 't3_b', verifiedAtMs: NOW - 49 * DAY });

    h.redis.mGetCalls = 0;
    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.redis.mGetCalls).toBe(1);
  });
});

describe('noteOpActivity', () => {
  it('stops the chase when the OP replies after a reminder', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    h.setNow(NOW + DAY);
    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'OP_user' });

    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBe(NOW + DAY);
    expect(h.redis.sizeOf(keys.openIndex())).toBe(0);

    // And no escalation follows.
    h.setNow(NOW + 20 * DAY);
    await h.service.sweep({ offset: 0, batchIndex: 0 });
    expect(h.reddit.reports).toHaveLength(0);
  });

  it('ignores comments from anyone who is not the OP', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });
    await h.service.sweep({ offset: 0, batchIndex: 0 });

    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'someone_else' });
    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBeNull();
  });

  it('ignores a post that is not being chased yet', async () => {
    const h = harness();
    await h.seed({ postId: 't3_old' });

    await h.service.noteOpActivity({ postId: 't3_old' as T3, author: 'op_user' });
    expect((await h.repo.get('t3_old' as T3))?.opRespondedAtMs).toBeNull();
  });

  it('costs one Redis read for a comment on an unknown post', async () => {
    const h = harness();
    await expect(
      h.service.noteOpActivity({ postId: 't3_unknown' as T3, author: 'someone' }),
    ).resolves.toBeUndefined();
    expect(h.reddit.calls).toEqual([]);
  });
});
